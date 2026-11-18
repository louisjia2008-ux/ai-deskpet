import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import wechat_listener as listener

SETTINGS = {"window": [280, 180, 880, 640]}
EDGE = 280 + 880 - 252
ROWS = range(180 + 115, 180 + 640 - 170)
CHAT = (250, 250, 250)
GREEN = (157, 242, 159)


def shade(color):
    return tuple(round(value * 0.96) for value in color)


class OwnerDrawerShadowTest(unittest.TestCase):
    def frame(self, paint):
        image = Image.new("RGB", (1440, 1000), CHAT)
        pixels = image.load()
        for row in ROWS:
            paint(pixels, row)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "frame.png"
        image.save(path)
        return path

    def test_open_drawer_over_a_tall_bubble_with_clipped_text(self):
        def paint(pixels, row):
            under = GREEN if row < ROWS.start + 270 else CHAT
            pixels[EDGE - 1, row] = under
            pixels[EDGE, row] = shade(under)
            if under == GREEN and row % 5 == 0:
                # A glyph edge: unrelated pixels on either side of the divider.
                pixels[EDGE - 1, row], pixels[EDGE, row] = (127, 194, 129), (21, 21, 21)
        path = self.frame(paint)
        self.assertIsNone(listener.owner_drawer_state(SETTINGS, path))
        self.assertTrue(listener.owner_drawer_shadow(SETTINGS, path))

    def test_closed_drawer_over_plain_chat_is_not_a_shadow(self):
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(lambda pixels, row: None)))

    def test_closed_drawer_with_a_bubble_crossing_the_edge_is_not_a_shadow(self):
        def paint(pixels, row):
            if row < ROWS.start + 270:
                for column in (EDGE - 1, EDGE, EDGE + 1):
                    pixels[column, row] = GREEN
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(paint)))

    def test_mostly_unshaded_edge_is_not_a_shadow(self):
        def paint(pixels, row):
            if row % 3 == 0:
                pixels[EDGE, row] = shade(CHAT)
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(paint)))


if __name__ == "__main__":
    unittest.main()
