import base64
import json
import multiprocessing
import os
import sqlite3
import sys
import time
import unittest
from contextlib import ExitStack, nullcontext
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont

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

    def test_post_and_preview_remove_internal_markers_and_reject_marker_only_text(self):
        body = "[mood:happy][sticker:none] 今天有点[sticker:none]冷"
        preview = {"id": "a" * 64, "binding": "b" * 64, "text": body, "image": base64.b64encode(png()).decode()}
        self.assertEqual(moments.parse_post(request(text=body))["text"], "今天有点冷")
        self.assertEqual(moments.parse_preview(json.dumps(preview).encode())["text"], "今天有点冷")
        with self.assertRaises(ValueError):
            moments.parse_post(request(text="[mood:happy] [sticker:none]"))
        with self.assertRaises(ValueError):
            moments.parse_preview(json.dumps({**preview, "text": "[sticker:none]"}).encode())

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

        def publish(settings, path, value, guest_paths, *, before_post, diagnostics):
            calls.append(guest_paths)
            self.assertTrue(before_post())

        self.assertEqual(self.post(publish), {"status": "posted"})
        self.assertEqual(calls, [["/home/agent/.local/state/deskpet-wechat/moments/" + "a" * 16 + "-0.png"]])
        self.assertEqual(self.post(publish), {"status": "posted"})
        self.assertEqual(len(calls), 1)
        changed = dict(self.request, text="另一段文字")
        with patch.object(moments, "publish", side_effect=AssertionError("must not publish")):
            self.request = changed
            self.assertEqual(self.post(publish), {"status": "conflict"})

    def test_unconfirmed_after_the_click_is_uncertain_and_failure_before_it_is_retryable(self):
        def unconfirmed(settings, path, value, guest_paths, *, before_post, diagnostics):
            before_post()
            diagnostics.stage = "confirm"
            raise ui.TestError("fixture no receipt")

        def blocked(settings, path, value, guest_paths, *, before_post, diagnostics):
            diagnostics.stage = "post_button"
            raise ui.TestError("朋友圈界面没有唯一的「Post」。")

        self.assertEqual(self.post(blocked), {"status": "retry", "stage": "post_button"})
        self.assertEqual(self.post(unconfirmed), {"status": "uncertain", "stage": "confirm"})
        self.assertEqual(self.post(unconfirmed), {"status": "uncertain"})
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT status FROM wechat_moment_posts").fetchall(), [("uncertain",)])

    def test_busy_paused_and_window_error_have_distinct_pre_publish_outcomes(self):
        def forbidden(*_args, **_kwargs):
            self.fail("the composer must not publish")

        def locked(**_options):
            raise ui.OperationBusy("fixture busy")

        def moments_window_missing(*_args, diagnostics, **_kwargs):
            diagnostics.stage = "open_window"
            raise ui.TestError("fixture Moments window")

        with self.subTest("busy"):
            self.assertEqual(self.post(forbidden, lock=locked), {"status": "busy"})
        with self.subTest("paused"):
            self.assertEqual(self.post(forbidden, paused=True), {"status": "paused"})
            self.assertEqual(self.post(forbidden, lock=locked, paused=True), {"status": "paused"})
        with self.subTest("window error"):
            failure = {"status": "window_error", "stage": "open_window"}
            self.assertEqual(self.post(forbidden, open_target=ui.TestError("fixture window")), failure)
            self.assertEqual(self.post(moments_window_missing), failure)
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM wechat_moment_posts").fetchone()[0], 0)

    def test_post_setup_error_is_kept_when_guest_cleanup_also_fails(self):
        def failed_window(*_args, diagnostics, **_kwargs):
            diagnostics.stage = "open_window"
            raise ui.TestError("fixture Moments window")

        def guest(command, *_args):
            if command.startswith("rm -f"):
                raise OSError("fixture cleanup failure")
            return b"/home/agent"

        self.assertEqual(self.post(failed_window, guest=guest,
                                   open_target=[None, OSError("fixture restore failure")]),
                         {"status": "window_error", "stage": "open_window"})

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

        def publish(_settings, _path, _request, _paths, *, before_post, diagnostics):
            durations.append(time.monotonic() - started)
            self.assertTrue(before_post())

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
                    outcomes.append(moments.post_moment({}, self.root, self.state, payload)["status"])
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


def line(text, x=30, y=30):
    return {"text": text, "x": x, "y": y, "width": 60, "height": 22}


class VisibilityTest(unittest.TestCase):
    def test_only_the_composer_can_confirm_the_approved_scope(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "composer.png"
            frame = Image.new("RGB", (430, 200), "#aeaeae")
            ImageDraw.Draw(frame).rectangle((35, 20, 394, 179), fill="#fafafa")
            frame.save(path)
            visible = line("Visible To", x=89, y=110)
            feed = line("All", x=395, y=113)
            public = line("All", x=310, y=107)
            private = line("Private", x=309, y=107)
            for choice, labels, expected in (
                ("all", [public, feed], True),
                ("private", [private, feed], True),
                ("all", [private, feed], False),
                ("all", [feed], False),
                ("all", [public, private, feed], False),
            ):
                with self.subTest(choice=choice, labels=labels):
                    self.assertEqual(
                        moments.visibility_matches({}, path, (0, 0, *frame.size), [visible, *labels], choice), expected)

            unreadable = line("A|I", x=310, y=107)
            for rescanned, expected in ((["All"], True), (["Private"], False), (["Not All"], False),
                                        (["All", "Private"], False), ([], False)):
                with self.subTest(rescanned=rescanned), patch.object(ui, "recognize", return_value=[line(t) for t in rescanned]):
                    self.assertEqual(moments.visibility_matches({"ocr": "fake-ocr"}, path, (0, 0, *frame.size),
                                                               [visible, unreadable, feed], "all"), expected)


class FakeComposer:
    """Only this fixture receives guest commands. It models focus, overlays, and receipts."""

    private = ui.WeChatWindow(42, (0, 0, 800, 600), True, True)
    moments = ui.WeChatWindow(43, (160, 100, 430, 480), True, True)
    popup = ui.WeChatWindow(44, (210, 200, 330, 180), True, False)
    caption = "今天降温了\n好冷 https://example.com"
    warning = "当前账号存在安全风险，暂时无法发表朋友圈"

    def __init__(self, stage=None, *, restriction=None, warning=None):
        self.stage = stage
        self.restriction = restriction
        self.warning = warning or self.warning
        self.active = self.private
        self.opened = False
        self.events = []
        self.frames = []
        self.crops = []

    def fail_at(self, stage, error=ui.TestError):
        if self.stage == stage:
            raise error("fixture failure")

    def guest(self, command, _payload=None):
        left, top, _, _ = self.moments.geometry
        if command.startswith("xdotool mousemove 31 258 click"):
            self.fail_at("open_window")
            self.opened = True
            self.active = self.popup if self.restriction == "open" else self.moments
        elif command.startswith(f"xdotool mousemove {left + 67} {top + 25} click"):
            self.fail_at("camera")
        elif command.startswith("cat >"):
            self.fail_at("upload")
        elif command.startswith("wechat") or command.startswith(ui.WECHAT_X11_IDENTITY):
            self.events.append(("dismiss", command))
            self.active = self.moments
        elif command.startswith(f"xdotool mousemove {left + 407} {top + 25} click"):
            self.events.append("close_moments")
            self.opened = False
            self.active = self.private
        return b"/home/fixture"

    def window_named(self, name):
        if name == "Moments" and self.opened:
            xid, geometry = self.moments.xid, self.moments.geometry
            return ((999 if self.stage == "window_changed" else xid), *geometry)
        if name == "Select File" and self.opened and self.stage == "attach_images":
            raise ui.TestError("fixture attachment failure")
        return None

    def wait_window(self, name):
        if name == "Select File":
            self.fail_at("select_file")
            return 45, 230, 250, 400, 300
        return self.moments.xid, *self.moments.geometry

    def open_target(self, _settings, _path, target):
        self.events.append(("open_target", target))
        self.active = self.private

    def require_label(self, _settings, _path, _region, kind, **_options):
        if self.stage == kind or (self.stage == "visibility" and kind == "visible") or (
                self.stage == "post_button" and kind == "post"):
            raise ui.TestError("fixture missing label")
        return {**line(kind.title()), "text": kind}

    def click_line(self, label):
        if label["text"] == "post":
            self.events.append("click_post")
            self.fail_at("click_post")
            if self.restriction == "after_click":
                self.active = self.popup

    def snapshot(self, path):
        warning = self.active == self.popup
        frame = Image.new("RGB", (800, 600), "red")
        draw = ImageDraw.Draw(frame)
        left, top, width, height = self.active.geometry
        draw.rectangle((left, top, left + width - 1, top + height - 1), fill="white")
        if self.active == self.moments:
            draw.rectangle((left + width - 35, top, left + width - 1, top + height - 1), fill="#aeaeae")
        font_path = Path("/System/Library/Fonts/Hiragino Sans GB.ttc")
        font = ImageFont.truetype(str(font_path), size=18) if font_path.exists() else ImageFont.load_default()
        draw.text((left + 19, top + 25), self.warning if warning else "Moment composer", fill="black", font=font)
        draw.text((left + 19, top + 96), "OK" if warning else "Visibility", fill="black", font=font)
        frame.save(path)
        self.frames.append(path.read_bytes())
        self.events.append("snapshot")
        return [800, 600]

    def recognize(self, _ocr, path):
        with Image.open(path) as crop:
            self.crops.append((crop.size, crop.getpixel((0, 0))))
        if self.active == self.popup:
            return [line(self.warning), line("OK", 180, 100)]
        return [line("Visibility"), line("正常文案")]

    def begin(self, ledger, post_id, digest):
        self.fail_at("ledger", sqlite3.OperationalError)
        return self.real_begin(ledger, post_id, digest)

    def run(self, runtime, state, payload):
        self.real_begin = moments.MomentLedger.begin
        settings = {"window": self.private.geometry, "ocr": "fake-ocr"}
        with ExitStack() as stack:
            for target, overrides in (
                (ui, {
                    "vm_operation": lambda **_: nullcontext(),
                    "guest": self.guest, "open_target": self.open_target, "snapshot": self.snapshot, "recognize": self.recognize,
                    "wechat_desktop": lambda: ui.WeChatDesktop(self.active.xid, (self.private, self.active)),
                    "paste": lambda _: self.fail_at("paste"), "clear_clipboard": lambda: None,
                }),
                (moments, {
                    "is_paused": lambda _: False,
                    "window_named": self.window_named, "wait_window": self.wait_window,
                    "require_label": self.require_label, "click_line": self.click_line,
                    "composer_text": lambda *_: "" if self.stage == "text_verify" else payload["text"],
                    "lines_in": lambda *_: [line("Visible To", x=220, y=470), line("Private", x=410, y=470)],
                    "find_label": lambda *_args, **_kwargs: None,
                    "confirmed": lambda *_: self.stage != "confirm" and self.restriction != "after_click",
                }),
                (moments.time, {"sleep": lambda _: None}),
            ):
                for name, override in overrides.items():
                    stack.enter_context(patch.object(target, name, side_effect=override))
            stack.enter_context(patch.object(moments.MomentLedger, "begin", autospec=True, side_effect=self.begin))
            return moments.post_moment(settings, runtime, state, payload)


class CaptureTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.request = moments.parse_post(request())

    def test_failures_return_the_actual_stage_and_save_the_frame_before_restoring(self):
        cases = [(stage, stage, "window_error" if stage == "open_window" else "uncertain" if stage == "confirm" else "retry")
                 for stage in moments.STAGES]
        cases.extend([("upload", "attach_images", "retry"), ("click_post", "post_button", "uncertain")])
        for failure, stage, status in cases:
            with self.subTest(failure=failure):
                host = FakeComposer(stage=failure)
                result = host.run(self.root, self.root / f"{failure}.db", self.request)
                self.assertEqual((result["status"], result["stage"]), (status, stage))
                screenshot = Path(result["screenshotPath"])
                self.assertTrue(moments.FAILURE_FILE.fullmatch(screenshot.name))
                self.assertTrue(screenshot.name.endswith(f"-{stage}.png"))
                self.assertEqual(screenshot.read_bytes(), host.frames[-1])
                self.assertEqual(screenshot.stat().st_mode & 0o777, 0o600)
                self.assertEqual(screenshot.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(host.events[-1], ("open_target", "private"))
                self.assertLessEqual(len(list(screenshot.parent.glob("*.png"))), 5)

    def test_restriction_on_open_is_captured_and_dismissed_then_the_draft_id_can_be_reused(self):
        state = self.root / "restricted.db"
        host = FakeComposer(restriction="open")
        result = host.run(self.root, state, self.request)
        self.assertEqual((result["status"], result["stage"]), ("restricted", "open_window"))
        self.assertNotIn("click_post", host.events)
        self.assertEqual(host.crops, [((330, 180), (255, 255, 255))])
        self.assertEqual(Path(result["screenshotPath"]).read_bytes(), host.frames[0])
        actions = [event[0] for event in host.events if isinstance(event, tuple)]
        self.assertEqual(actions, ["open_target", "dismiss", "open_target"])
        dismiss_command = next(event[1] for event in host.events if isinstance(event, tuple) and event[0] == "dismiss")
        self.assertIn('getactivewindow)" = "44"', dismiss_command)
        self.assertIn("mousemove 420 311 click 1", dismiss_command)
        self.assertIn("close_moments", host.events)
        self.assertEqual(host.active, host.private)
        self.assertEqual(FakeComposer().run(self.root, state, self.request), {"status": "posted"})

    def test_after_click_requires_an_explicit_publish_refusal_to_release_the_ledger(self):
        for warning, status in [(FakeComposer.warning, "restricted"), ("当前账号存在安全风险，部分功能受限", "uncertain")]:
            with self.subTest(status=status):
                state = self.root / f"{status}.db"
                host = FakeComposer(restriction="after_click", warning=warning)
                result = host.run(self.root, state, self.request)
                self.assertEqual((result["status"], result["stage"]), (status, "confirm"))
                self.assertEqual(host.events.count("click_post"), 1)
                if status == "restricted":
                    self.assertEqual(FakeComposer().run(self.root, state, self.request), {"status": "posted"})
                else:
                    self.assertEqual(FakeComposer().run(self.root, state, self.request), {"status": "uncertain"})

    def test_ordinary_feed_caption_and_network_error_are_not_account_restrictions(self):
        valid = [line(FakeComposer.warning), line("确定", y=80)]
        self.assertIsNotNone(moments.restriction_lines(valid, "", inline=True))
        self.assertIsNone(moments.restriction_lines(valid[:1], "", inline=True))
        self.assertIsNone(moments.restriction_lines(valid, FakeComposer.warning, inline=True))
        self.assertIsNone(moments.restriction_lines([line("网络异常，暂时无法发表朋友圈")], "", inline=False))
        host = FakeComposer(stage="open_window")
        self.assertEqual(host.run(self.root, self.root / "chat.db", self.request)["status"], "window_error")
        self.assertEqual(host.crops, [])

    def test_periodic_retention_deletes_seven_day_old_samples_without_a_new_failure(self):
        sample = self.root / "screen.png"
        sample.write_bytes(png())
        for stage in moments.STAGES:
            moments.save_failure_screenshot(self.root, sample, stage)
        directory = self.root / moments.FAILURE_DIRECTORY
        self.assertEqual(len(list(directory.glob("*.png"))), 5)
        stale = next(directory.glob("*.png"))
        now = time.time()
        cutoff = now - moments.FAILURE_AGE
        os.utime(stale, (cutoff, cutoff))
        moments.prune_failure_screenshots(self.root, now=now)
        self.assertFalse(stale.exists())
        self.assertEqual(len(list(directory.glob("*.png"))), 4)


if __name__ == "__main__":
    unittest.main()
