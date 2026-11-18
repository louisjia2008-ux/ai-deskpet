import base64
import json
import sqlite3
import sys
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

    def post(self, publish):
        with (
            patch.object(moments.ui, "vm_operation", side_effect=nullcontext),
            patch.object(moments, "is_paused", return_value=False),
            patch.object(moments.ui, "open_target"),
            patch.object(moments.ui, "guest", return_value=b"/home/agent"),
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


if __name__ == "__main__":
    unittest.main()
