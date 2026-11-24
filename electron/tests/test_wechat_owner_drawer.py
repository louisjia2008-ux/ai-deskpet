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
GRAY = (238, 238, 240)


def shade(color):
    return tuple(round(value * 0.96) for value in color)


class OwnerDrawerStateTest(unittest.TestCase):
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

    def test_open_drawer_with_an_unobscured_divider(self):
        def paint(pixels, row):
            pixels[EDGE, row] = shade(CHAT)
        self.assertIs(listener.owner_drawer_state(SETTINGS, self.frame(paint)), True)

    def test_closed_drawer_over_plain_chat_is_not_a_shadow(self):
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(lambda pixels, row: None)))

    def test_closed_drawer_with_a_bubble_crossing_the_edge_is_not_a_shadow(self):
        def paint(pixels, row):
            if row < ROWS.start + 270:
                for column in (EDGE - 1, EDGE, EDGE + 1):
                    pixels[column, row] = GREEN
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(paint)))

    def test_closed_drawer_with_text_crossing_the_edge_inside_a_tall_bubble(self):
        def paint(pixels, row, fill):
            for column in range(EDGE - 24, EDGE + 25):
                pixels[column, row] = fill
            glyph_columns = (-1, 0, 1, 0, -5, 7)
            slot = (row - ROWS.start) % 10
            if slot < len(glyph_columns):
                pixels[EDGE + glyph_columns[slot], row] = (22, 22, 22)
        for fill in (GREEN, GRAY):
            with self.subTest(fill=fill):
                self.assertIs(listener.owner_drawer_state(SETTINGS, self.frame(lambda pixels, row: paint(pixels, row, fill))), False)

    def test_green_pixels_near_the_edge_do_not_confirm_a_closed_drawer(self):
        def paint(pixels, row):
            pixels[EDGE - 1, row] = (22, 22, 22)
            pixels[EDGE, row] = pixels[EDGE + 1, row] = GREEN
        self.assertIsNone(listener.owner_drawer_state(SETTINGS, self.frame(paint)))

    def test_crossing_bubble_color_does_not_override_a_visible_divider(self):
        def paint(pixels, row):
            if row < ROWS.start + 100:
                for column in range(EDGE - 24, EDGE + 25):
                    pixels[column, row] = GREEN
            else:
                pixels[EDGE, row] = shade(CHAT)
        self.assertIsNone(listener.owner_drawer_state(SETTINGS, self.frame(paint)))

    def test_mostly_unshaded_edge_is_not_a_shadow(self):
        def paint(pixels, row):
            if row % 3 == 0:
                pixels[EDGE, row] = shade(CHAT)
        self.assertFalse(listener.owner_drawer_shadow(SETTINGS, self.frame(paint)))


if __name__ == "__main__":
    unittest.main()
