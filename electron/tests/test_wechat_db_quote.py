import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui
from wechat_listener import VisibleMessage, database_group_quote


class DatabaseQuoteTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "screen.png"
        Image.new("RGB", (200, 200), "white").save(self.path)
        self.visible = "@小桌宠 /time"
        self.original = "@小桌宠\u2005/time"
        self.hand = VisibleMessage("incoming", "阿明", self.visible, True, False, (10, 20, 50, 25))
        self.native = VisibleMessage("incoming", "阿明", self.visible, True, False, (10, 70, 50, 25))
        self.observation = {"text": self.original, "sender": "阿明"}

    def test_exact_clipboard_selects_native_spacing(self):
        with patch.object(ui, "copy_group_sticker_message", side_effect=[self.visible, self.original]):
            message, resolve = database_group_quote({}, self.path, (self.hand, self.native), self.observation)
        self.assertEqual(message, self.native)
        self.assertEqual(resolve((self.hand, self.native)), self.native)
        self.assertIsNone(resolve((self.native,)))

    def test_duplicate_exact_content_and_failed_copy_refuse_quote(self):
        for second in (self.original, ui.TestError("copy unavailable")):
            with patch.object(ui, "copy_group_sticker_message", side_effect=[self.original, second]):
                self.assertEqual(
                    database_group_quote({}, self.path, (self.hand, self.native), self.observation), (None, None)
                )

    def test_same_sender_candidate_can_recover_ocr_punctuation(self):
        row = VisibleMessage("incoming", "阿明", "@小桌宠 Itime", True, False, self.native.box)
        with patch.object(ui, "copy_group_sticker_message", return_value=self.original):
            resolved, _ = database_group_quote({}, self.path, (row,), self.observation)
        self.assertEqual(resolved, row)


if __name__ == "__main__":
    unittest.main()
