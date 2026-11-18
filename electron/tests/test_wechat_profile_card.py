"""Read the native profile card's WeChat ID, including one the card wraps onto two lines."""

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_listener as listener

WINDOW = (280, 180, 880, 640)


def line(text, dx, dy):
    return {'text': text, 'x': WINDOW[0] + dx, 'y': WINDOW[1] + dy}


class ProfileCardTest(unittest.TestCase):
    def read(self, card):
        with TemporaryDirectory(prefix='fixture-wechat-card-') as temporary:
            path = Path(temporary) / 'screen.png'
            Image.new('RGB', (1440, 1000), 'white').save(path)
            settings = {'window': list(WINDOW), 'ocr': None}
            with (patch.object(listener.ui, 'verify_title', return_value=True),
                  patch.object(listener, 'owner_drawer_state', side_effect=[True, True, True, False]),
                  patch.object(listener.ui, 'points', return_value=[{'text': '查找聊天记录'}]),
                  patch.object(listener.ui, 'click'), patch.object(listener.ui, 'snapshot'),
                  patch.object(listener.ui, 'recognize', return_value=card), patch.object(listener.time, 'sleep')):
                return listener.owner_profile(settings, path)[1]

    def card(self, *extra):
        return [line('Friend Profile', 720, 100), line('Lyrix', 789, 121),
                line('Weixin ID:fixtureid163814g', 791, 146), *extra, line('Region:Fixture Krong P', 789, 173)]

    def test_joins_an_id_the_card_wraps_onto_a_second_line(self):
        # Seen live on 2026-11-16: a 17-character ID wrapped its last three letters, so binding was refused.
        self.assertEqual(self.read(self.card(line('olf', 850, 160))), 'fixtureid163814golf')

    def test_a_one_line_id_and_the_next_field_are_left_alone(self):
        self.assertEqual(self.read(self.card(line('ailin', 850, 189))), 'fixtureid163814g')

    def test_two_wrap_candidates_fail_closed(self):
        with self.assertRaises(listener.ui.DiagnosticTestError):
            self.read(self.card(line('olf', 850, 160), line('xyz', 860, 162)))


if __name__ == '__main__':
    unittest.main()
