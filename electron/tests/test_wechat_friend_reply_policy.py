"""Test friend reply limits and the owner priority check against a durable state database."""

from datetime import datetime, time as day_time
import itertools
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_listener as listener
from wechat_friend_replies import FRIEND_DECLINE, plan_reply
from wechat_replies import ReplyYielded, cloud_request_from_bytes, local_reply_context
from wechat_state import WeChatState


class FriendPolicyTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = WeChatState(self.root / 'state.db')
        self.addCleanup(self.state.db.close)
        self.ids = itertools.count(1)
        self.friend = 'a' * 64
        self.friend_binding = 'b' * 64
        self.owner_binding = 'c' * 64
        self.now = datetime.combine(datetime.now().date(), day_time(hour=12)).timestamp()

    def event(self, binding, target, conversation):
        count = next(self.ids)
        occurrence = f'{count:064x}'
        data = {'database': {'target': target, 'conversation_id': conversation}, 'text': 'fixture message'}
        with self.state.db:
            self.state.db.execute("INSERT INTO wechat_occurrences VALUES (?,?,?,?,'pending',NULL)",
                                  (occurrence, binding, count, json.dumps(data)))
        return occurrence

    def attempt(self, *, friend=None, at=None):
        friend = friend or self.friend
        occurrence = self.event(self.friend_binding, 'friend', friend)
        self.assertTrue(self.state.prepare(occurrence, 'fixture response'))
        status = self.state.mark_friend_attempted(occurrence, friend, {'version': 1}, now=self.now if at is None else at)
        if status == 'attempted':
            self.assertTrue(self.state.mark_uncertain(occurrence))
        return status

    def test_minute_counts_possible_clicks_and_skips_excess(self):
        self.assertEqual([self.attempt() for _ in range(4)], ['attempted'] * 4)
        self.assertEqual(self.attempt(), 'friend_rate_limited')
        self.assertEqual(self.state.skipped_since(self.now), [('friend_rate_limited', self.now)])
        self.assertEqual(self.attempt(friend='d' * 64), 'attempted')
        self.assertEqual(self.attempt(at=self.now + 61), 'attempted')

    def test_daily_cap_and_combined_hourly_cap(self):
        self.assertEqual([self.attempt(at=self.now + index * 61) for index in range(60)], ['attempted'] * 60)
        self.assertEqual(self.attempt(at=self.now + 3660), 'friend_rate_limited')
        for index in range(120):
            self.assertEqual(self.attempt(friend=f'{index + 100:064x}', at=self.now + 7200), 'attempted')
        self.assertEqual(self.attempt(friend='d' * 64, at=self.now + 7200), 'friend_rate_limited')
        self.assertEqual(self.attempt(friend='d' * 64, at=self.now + 10801), 'attempted')

    def test_owner_poll_preempts_friend_before_click(self):
        intake = Mock()
        intake.request.return_value = {'op': 'poll'}
        intake.apply.side_effect = lambda *_: self.event(self.owner_binding, 'private', 'fixture_owner')
        reader = Mock()
        self.event(self.friend_binding, 'friend', self.friend)
        self.assertFalse(listener.owner_turn_waiting(self.state, self.owner_binding))
        with (patch.object(listener, 'database_intake', return_value=(intake, {})) as create,
              patch.object(listener, 'hear_owner_voices')):
            check = listener.owner_priority_check(self.state, {}, self.root, self.owner_binding, reader)
            with self.assertRaises(ReplyYielded):
                check(force=True)
            create.assert_called_once_with(self.state, {}, self.root, {}, {'private': self.owner_binding}, reader)
            self.assertTrue(listener.owner_turn_waiting(self.state, self.owner_binding))

    def test_friend_owner_command_cannot_start_a_model_or_publish_moments(self):
        friend = SimpleNamespace(id='e' * 32)
        for command in ('发', '/pause-queue', '收件箱', '展开 群 1', '设置定时任务'):
            with self.subTest(command=command), patch('wechat_friend_replies.local_reply_context') as context:
                event = SimpleNamespace(observation={'text': command})
                reply, _, model = plan_reply(self.state, friend, self.friend_binding, event, self.root, None, Mock())
                self.assertEqual(reply, FRIEND_DECLINE)
                self.assertIsNone(model)
                context.assert_not_called()

    def test_wire_rejects_friend_owner_capabilities_and_local_context_rejects_memories(self):
        request = {'target': 'friend', 'groupId': None, 'friendId': 'e' * 32, 'binding': self.friend_binding,
                   'eventId': 'f' * 64, 'text': 'fixture request', 'history': [], 'split': False, 'stickers': False}
        wire = lambda item: (json.dumps(item) + '\n').encode()
        self.assertEqual(cloud_request_from_bytes(wire(request)), request)
        for fields in ({'ownerCommand': True}, {'readTool': True}, {'stickers': True},
                       {'dailyDigests': {'items': ['fixture digest'], 'expiresAt': 99999999}}, {'ownerName': 'fixture owner'}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                cloud_request_from_bytes(wire(request | fields))
        with patch('wechat_replies._host_reply', return_value={'persona': 'fixture persona', 'memories': ['fixture secret']}):
            self.assertIsNone(local_reply_context(self.root, request, 'fixture'))
        with patch('wechat_replies._host_reply', return_value={'persona': 'fixture private typing style', 'memories': []}):
            self.assertIsNone(local_reply_context(self.root, request, 'fixture'))
        with patch('wechat_replies._host_reply', return_value={'name': 'Fixture companion', 'persona': None, 'memories': []}):
            self.assertEqual(local_reply_context(self.root, request, 'fixture'), {'name': 'Fixture companion', 'persona': None, 'memories': []})
