import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui

SETTINGS = {"ocr": "/unused", "quote_preview": [588, 738, 472, 32], "draft": [594, 675, 552, 86], "draft_click": [623, 700]}
LINE = {"text": "张小明：@小桌宠 325是什么意思", "x": 600, "y": 746, "width": 194, "height": 18}


class QuotePreviewTest(unittest.TestCase):
    def frame(self, disc=True):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "screen.png"
        image = Image.new("RGB", (1440, 1000), (250, 250, 250))
        draw = ImageDraw.Draw(image)
        draw.text((600, 746), "quote", fill=(136, 136, 136))
        if disc:
            draw.ellipse((812, 749, 824, 761), fill=(214, 214, 214))
            draw.line((815, 752, 821, 758), fill=(255, 255, 255))
            draw.line((815, 758, 821, 752), fill=(255, 255, 255))
        image.save(path)
        return path

    def test_finds_the_close_disc_right_of_the_preview_text(self):
        with patch.object(ui, "points", return_value=[LINE]):
            x, y = ui.quote_close_point(SETTINGS, self.frame())
        self.assertTrue(812 <= x <= 824, x)
        self.assertEqual(y, 755)

    def test_no_preview_or_no_disc_means_nothing_to_click(self):
        with patch.object(ui, "points", return_value=[]):
            self.assertIsNone(ui.quote_close_point(SETTINGS, self.frame()))
        with patch.object(ui, "points", return_value=[LINE]):
            self.assertIsNone(ui.quote_close_point(SETTINGS, self.frame(disc=False)))

    def test_clearing_clicks_the_disc_and_reports_whether_the_preview_is_gone(self):
        path = self.frame()
        with patch.object(ui, "capture_wechat"), patch.object(ui, "points", side_effect=[[LINE], []]), \
                patch.object(ui, "click") as click, patch.object(ui.time, "sleep"):
            self.assertTrue(ui.clear_quote_preview(SETTINGS, path))
        click.assert_called_once()
        with patch.object(ui, "capture_wechat"), patch.object(ui, "points", side_effect=[[LINE], [LINE]]), \
                patch.object(ui, "click"), patch.object(ui.time, "sleep"):
            self.assertFalse(ui.clear_quote_preview(SETTINGS, path))

    def test_discarding_a_staged_draft_never_raises(self):
        with patch.object(ui, "click"), patch.object(ui, "guest", side_effect=KeyError("window_class")):
            ui.discard_staged_draft(SETTINGS, Path("/unused"))


if __name__ == "__main__":
    unittest.main()
