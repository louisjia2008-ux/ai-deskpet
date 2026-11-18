import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui

SETTINGS = {"window": [280, 180, 880, 640]}


def desktop(*windows, active=7):
    return ui.WeChatDesktop(active, tuple(windows))


class RealignTest(unittest.TestCase):
    def realign(self, value):
        with patch.object(ui, "wechat_desktop", return_value=value), patch.object(ui, "guest") as guest:
            return ui.realign_wechat(SETTINGS), guest

    def test_moves_only_the_single_shifted_window_and_verifies_the_result(self):
        moved, guest = self.realign(desktop(ui.WeChatWindow(7, (296, 188, 880, 640), True, True),
                                            ui.WeChatWindow(9, (828, 368, 246, 70), False, False)))
        self.assertEqual(moved, (296, 188))
        script = guest.call_args.args[0]
        self.assertIn("'296 188 880 640 IsViewable'", script)
        self.assertIn('windowmove --sync "$window" 280 180', script)
        self.assertIn("'280 180 880 640 IsViewable'", script)

    def test_leaves_resized_ambiguous_hidden_or_covered_windows_alone(self):
        for value in (
            desktop(ui.WeChatWindow(7, (280, 180, 880, 640), True, True)),
            desktop(ui.WeChatWindow(7, (296, 188, 900, 640), True, True)),
            desktop(ui.WeChatWindow(7, (296, 188, 880, 640), False, True)),
            desktop(ui.WeChatWindow(7, (296, 188, 880, 640), True, True), ui.WeChatWindow(8, (500, 220, 440, 560), True, True)),
            desktop(ui.WeChatWindow(7, (296, 188, 880, 640), True, True), ui.WeChatWindow(8, (500, 220, 440, 560), True, False)),
        ):
            with self.subTest(value=value):
                moved, guest = self.realign(value)
                self.assertIsNone(moved)
                guest.assert_not_called()


if __name__ == "__main__":
    unittest.main()
