"""WeChat's voice-input hint in an empty editor is not a draft; real text still is."""

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui


class EditorHintTest(unittest.TestCase):
    def test_the_hint_as_ocr_reads_it_is_not_typed_text(self):
        for hint in ("Hold Ctrl + Superto use voice input", "Hold Ctrl+Super to use voice input", "按住 Ctrl + Super 使用语音输入"):
            self.assertEqual(ui.typed_lines([{"text": hint}]), [])
        for typed in ("你会吵架吗", "Hold Ctrl + Super to use voice input 你好", "use voice input"):
            self.assertEqual(len(ui.typed_lines([{"text": typed}])), 1)

    def test_an_editor_showing_only_the_hint_counts_as_empty(self):
        settings = {"ocr": "ocr", "draft": (0, 0, 10, 10)}
        with patch.object(ui, "points", return_value=[{"text": "Hold Ctrl + Superto use voice input"}]):
            self.assertTrue(ui.editor_shows_only_hint(settings, Path("x")))
        with patch.object(ui, "points", return_value=[{"text": "Hold Ctrl + Superto use voice input"}, {"text": "草稿"}]):
            self.assertFalse(ui.editor_shows_only_hint(settings, Path("x")))
        with patch.object(ui, "points", return_value=[]):
            self.assertFalse(ui.editor_shows_only_hint(settings, Path("x")))


if __name__ == "__main__":
    unittest.main()
