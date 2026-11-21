import base64
import json
import multiprocessing
import os
import sqlite3
import sys
import time
import unittest
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui
import wechat_moments as moments


def png(color="skyblue", size=(64, 48)):
    encoded = BytesIO()
    Image.new("RGB", size, color).save(encoded, format="PNG", pnginfo=None)
    return encoded.getvalue()


def request(**changes):
    value = {"id": "a" * 64, "text": "今天降温了\n好冷 https://example.com", "visibility": "private",
             "images": [base64.b64encode(png()).decode()]}
    value.update(changes)
    return json.dumps(value, ensure_ascii=False).encode()


def busy_listener(lock_path, pipe, rounds):
    """One fake-background process repeatedly occupies the real desktop lock."""
    ui.VM_LOCK_PATH = lock_path
    with pipe:
        attempt = 0
        while attempt < rounds:
            try:
                with ui.vm_operation():
                    pipe.send(attempt)
                    time.sleep(2.0)
                    attempt += 1
            except ui.OperationBusy:
                pass
            time.sleep(0.3)


class ParseTest(unittest.TestCase):
    def test_accepts_multiline_text_and_reencodes_images(self):
        parsed = moments.parse_post(request())
        self.assertEqual(parsed["text"], "今天降温了\n好冷 https://example.com")
        with Image.open(BytesIO(parsed["images"][0])) as image:
            self.assertEqual((image.format, image.size), ("PNG", (64, 48)))

    def test_rejects_unsafe_requests(self):
        for changes in ({"id": "short"}, {"visibility": "friends"}, {"text": ""}, {"text": "a‮b"},
                        {"text": "x" * 1001}, {"images": []}, {"images": ["not base64!"]},
                        {"images": [base64.b64encode(b"GIF89a").decode()]}, {"extra": 1}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                moments.parse_post(request(**changes))

    def test_labels_tolerate_icons_read_as_text(self):
        self.assertTrue(moments.label_matches("S Visible To", moments.LABELS["visible"]))
        self.assertTrue(moments.label_matches("Say something..", moments.LABELS["placeholder"], prefix=True))
        self.assertFalse(moments.label_matches("Posted", moments.LABELS["post"]))
        self.assertFalse(moments.label_matches("Visible To All", moments.LABELS["visible"]))


class PostTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / "listener.db"
        self.request = moments.parse_post(request())

    def post(self, publish, *, open_target=None, paused=False, lock=None, guest=None):
        with (
            patch.object(moments.ui, "vm_operation", side_effect=lock or (lambda **_: nullcontext())),
            patch.object(moments, "is_paused", return_value=paused),
            patch.object(moments.ui, "open_target", side_effect=open_target),
            patch.object(moments.ui, "guest", return_value=b"/home/agent", side_effect=guest),
            patch.object(moments, "close_moments"),
            patch.object(moments, "publish", side_effect=publish),
        ):
            return moments.post_moment({}, self.root, self.state, self.request)

    def test_records_the_attempt_before_the_click_and_never_posts_an_id_twice(self):
        calls = []

        def publish(settings, path, value, guest_paths, *, before_post):
            calls.append(guest_paths)
            self.assertTrue(before_post())
            return True

        self.assertEqual(self.post(publish), "posted")
        self.assertEqual(calls, [["/home/agent/.local/state/deskpet-wechat/moments/" + "a" * 16 + "-0.png"]])
        self.assertEqual(self.post(publish), "posted")
        self.assertEqual(len(calls), 1)
        changed = dict(self.request, text="另一段文字")
        with patch.object(moments, "publish", side_effect=AssertionError("must not publish")):
            self.request = changed
            self.assertEqual(self.post(publish), "conflict")

    def test_unconfirmed_after_the_click_is_uncertain_and_failure_before_it_is_retryable(self):
        def unconfirmed(settings, path, value, guest_paths, *, before_post):
            before_post()
            return False

        def blocked(settings, path, value, guest_paths, *, before_post):
            raise ui.TestError("朋友圈界面没有唯一的「Post」。")

        self.assertEqual(self.post(blocked), "retry")
        self.assertEqual(self.post(unconfirmed), "uncertain")
        self.assertEqual(self.post(unconfirmed), "uncertain")
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT status FROM wechat_moment_posts").fetchall(), [("uncertain",)])

    def test_busy_paused_and_window_error_have_distinct_pre_publish_outcomes(self):
        def forbidden(*_args, **_kwargs):
            self.fail("the composer must not publish")

        def locked(**_options):
            raise ui.OperationBusy("fixture busy")

        def moments_window_missing(*_args, **_kwargs):
            raise moments.MomentWindowError("fixture Moments window")

        with self.subTest("busy"):
            self.assertEqual(self.post(forbidden, lock=locked), "busy")
        with self.subTest("paused"):
            self.assertEqual(self.post(forbidden, paused=True), "paused")
            self.assertEqual(self.post(forbidden, lock=locked, paused=True), "paused")
        with self.subTest("window error"):
            self.assertEqual(self.post(forbidden, open_target=ui.TestError("fixture window")), "window_error")
            self.assertEqual(self.post(moments_window_missing), "window_error")
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM wechat_moment_posts").fetchone()[0], 0)

    def test_post_setup_error_is_kept_when_guest_cleanup_also_fails(self):
        def failed_window(*_args, **_kwargs):
            raise moments.MomentWindowError("fixture Moments window")

        def guest(command, *_args):
            if command.startswith("rm -f"):
                raise OSError("fixture cleanup failure")
            return b"/home/agent"

        self.assertEqual(self.post(failed_window, guest=guest,
                                   open_target=[None, OSError("fixture restore failure")]), "window_error")

    def test_twenty_posts_against_a_high_frequency_cross_process_listener(self):
        rounds = 20
        os.chmod(self.root, 0o700)
        lock_path = self.root / "desktop.lock"
        ctx = multiprocessing.get_context("spawn")
        receiver, writer = ctx.Pipe(duplex=False)
        worker = ctx.Process(target=busy_listener, args=(lock_path, writer, rounds), daemon=True)
        worker.start()
        writer.close()
        durations = []
        started = None

        def publish(_settings, _path, _request, _paths, *, before_post):
            durations.append(time.monotonic() - started)
            self.assertTrue(before_post())
            return True

        outcomes = []
        try:
            with (
                receiver,
                patch.object(ui, "VM_LOCK_PATH", lock_path),
                patch.object(moments, "MOMENTS_LOCK_WAIT", 5),
                patch.object(ui, "open_target"),
                patch.object(ui, "guest", return_value=b"/home/fixture"),
                patch.object(moments, "close_moments"),
                patch.object(moments, "publish", side_effect=publish),
            ):
                for attempt in range(rounds):
                    self.assertTrue(receiver.poll(6), f"listener did not start poll {attempt}")
                    self.assertEqual(receiver.recv(), attempt)
                    started = time.monotonic()
                    payload = {**self.request, "id": f"{attempt:064x}"}
                    outcomes.append(moments.post_moment({}, self.root, self.state, payload))
                    self.assertEqual(outcomes[-1], "posted")
        finally:
            worker.join(3)
            if worker.is_alive():
                worker.terminate()
                worker.join(3)
        self.assertEqual(worker.exitcode, 0)
        self.assertEqual(len(durations), rounds)
        self.assertTrue(all(0 < seconds < 5 for seconds in durations))
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM wechat_moment_posts WHERE status='posted'").fetchone()[0], rounds)
        print(json.dumps({
            "scenario": "cross_process_moments_contention", "attempts": rounds, "posted": outcomes.count("posted"),
            "listener_hold_s": 2.0, "listener_gap_s": 0.3, "test_wait_budget_s": 5,
            "avg_wait_s": round(sum(durations) / rounds, 3), "max_wait_s": round(max(durations), 3),
        }), flush=True)


if __name__ == "__main__":
    unittest.main()
