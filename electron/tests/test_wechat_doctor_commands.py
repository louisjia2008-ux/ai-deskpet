"""Only the verified owner command lane can dispatch checkups."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_replies as replies
from wechat_friend_replies import friend_owner_command
from wechat_replies import cloud_request_from_bytes
import json


class DoctorCommandsTest(unittest.TestCase):
    def test_width_whitespace_normalization_and_ephemeral_reports(self):
        for text in ('体检', '  /checkup  ', '　／ＣＨＥＣＫＵＰ　'):
            self.assertTrue(replies.doctor_checkup_command(text))
            self.assertTrue(replies.owner_command_candidate(text))
            self.assertTrue(replies.ephemeral_owner_reply(text))
            self.assertFalse(friend_owner_command(text))
            with patch.object(replies, '_host_reply', return_value={'reply': '【医生】合成体检结果'}) as bridge:
                self.assertEqual(replies.owner_command_plan(Path('.'), {'text': text})['reply'], '【医生】合成体检结果')
                self.assertEqual(bridge.call_args.kwargs['timeout'], 180)
        self.assertFalse(replies.doctor_checkup_command('帮我体检一下'))
        self.assertFalse(replies.owner_command_candidate('帮我体检一下'))

    def test_friend_cannot_inject_an_owner_command_flag(self):
        request = {'target': 'friend', 'groupId': None, 'friendId': 'e' * 32, 'binding': 'a' * 64,
                   'eventId': 'b' * 64, 'text': '体检', 'history': [], 'split': False, 'stickers': False}
        self.assertEqual(cloud_request_from_bytes((json.dumps(request) + '\n').encode()), request)
        with self.assertRaises(ValueError):
            cloud_request_from_bytes((json.dumps({**request, 'ownerCommand': True}) + '\n').encode())
