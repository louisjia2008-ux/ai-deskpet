"""Synthetic official-client schemas and the independent group selection boundary."""

from contextlib import closing, contextmanager
from pathlib import Path
import json
import sqlite3
import sys
import threading
import time
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_db_guest as guest
import wechat_digest_groups as controls
import wechat_followup_groups as followup
import wechat_listener as listener
from wechat_db_channel import DatabaseUnavailable
from wechat_db_intake import DbIntake, DbScope
from wechat_group_policy import GroupPolicy
from wechat_state import WeChatState


ACCOUNT = 'fixture_bot'
OWNER = 'fixture_owner'
OTHER_MEMBER = 'fixture_member'
ROOM = 'reading_only@chatroom'
REPLY = 'reply_room@chatroom'
FAKE_ROOM = 'not_a_room@chatroom'
BINDING = 'a' * 64
REPLY_BINDING = 'b' * 64
FINGERPRINT = 'c' * 64
STORAGE = Path('fixture/db_storage')
SHARD = Path('fixture/message_0.db')
NOW = 10 * guest.DIGEST_WINDOW


class DigestGuestTest(unittest.TestCase):
    def setUp(self):
        self.contact = sqlite3.connect(':memory:')
        self.contact.row_factory = sqlite3.Row
        self.addCleanup(self.contact.close)
        self.contact.execute('CREATE TABLE contact(username, nick_name, remark)')
        self.contact.executemany('INSERT INTO contact VALUES (?,?,?)', (
            (OWNER, 'Fixture owner', ''), (OTHER_MEMBER, 'Fixture member', ''),
            (ROOM, 'Fixture reading room', ''), (REPLY, 'Fixture reply room', ''),
            (FAKE_ROOM, 'Not a native room', ''),
        ))
        self.contact.execute('CREATE TABLE chat_room(id, username, ext_buffer)')
        self.contact.executemany('INSERT INTO chat_room VALUES (?,?,?)', ((1, ROOM, None), (2, REPLY, None)))
        self.message = sqlite3.connect(':memory:')
        self.message.row_factory = sqlite3.Row
        self.addCleanup(self.message.close)
        self.message.execute('CREATE TABLE Name2Id(user_name)')
        self.message.executemany('INSERT INTO Name2Id VALUES (?)', ((OWNER,), (OTHER_MEMBER,), (ACCOUNT,)))
        self.table = guest.table_for(ROOM)
        self.message.execute(f'CREATE TABLE "{self.table}" (local_id,server_id,real_sender_id,local_type,create_time,message_content,compress_content,source)')
        self.opaque = guest.digest_group_id(ACCOUNT, ROOM)

    def add(self, number, when, text, *, speaker=2, raw_type=1, native_mentions=''):
        source = f'<msgsource><atuserlist>{native_mentions}</atuserlist></msgsource>' if native_mentions else ''
        self.message.execute(f'INSERT INTO "{self.table}" VALUES (?,?,?,?,?,?,?,?)',
                             (number, number + 1, speaker, raw_type, when, text, None, source))

    def read(self, op, **fields):
        @contextmanager
        def readonly(path, keys):
            self.assertIn(path, (STORAGE / 'contact/contact.db', SHARD))
            yield (self.contact if path.name == 'contact.db' else self.message), None

        with patch.object(guest, 'open_logical', side_effect=readonly), patch.object(guest, 'message_shards', return_value=[SHARD]), \
                patch.object(guest.time, 'time', return_value=NOW):
            return guest.respond({'op': op, 'account_id': ACCOUNT, 'owner_id': OWNER, 'group_ids': [REPLY], **fields},
                                 STORAGE, ACCOUNT, b'fixture')

    def test_roster_marks_reply_rooms_and_filters_group_like_contacts(self):
        reply = guest.digest_group_id(ACCOUNT, REPLY)
        self.assertEqual(sorted(self.read('digest_group_list')['groups'], key=lambda group: group['title']), [
            {'id': self.opaque, 'title': 'Fixture reading room'},
            {'id': reply, 'title': 'Fixture reply room', 'replying': True},
        ])
        with patch.object(guest, 'group_members', return_value=None):
            self.assertEqual(self.read('digest_group_read', id=reply, until=NOW)['rows'], [])
        with self.assertRaisesRegex(guest.LocalDataError, 'digest_scope_changed'):
            self.read('digest_group_read', id=guest.digest_group_id(ACCOUNT, FAKE_ROOM), until=NOW)

    def test_recent_exact_group_sources_have_bounded_public_fields(self):
        card = ('<msg><appmsg><type>5</type><title>Fixture link</title>'
                '<url>https://example.test/item</url><sourceusername>fixture_secret</sourceusername></appmsg></msg>')
        self.add(1, NOW - guest.DIGEST_WINDOW - 1, 'too old')
        self.add(2, NOW - 30, OTHER_MEMBER + ':\nFixture question?', native_mentions=OWNER)
        self.add(3, NOW - 20, card, raw_type=(5 << 32) | 49)
        self.add(4, NOW - 10, 'Fixture response', speaker=1)
        self.add(5, NOW, 'next window')
        self.add(6, NOW - 9, 'attachment key', raw_type=47)
        self.add(7, NOW - 6, '<msg><img aeskey="fixture_secret"/></msg>', raw_type=3)
        with patch.object(guest, 'group_members', return_value=None):
            result = self.read('digest_group_read', id=self.opaque, until=NOW)
        self.assertEqual(result['rows'], [
            {'at': NOW - 30, 'text': 'Fixture question?', 'mentionsOwner': True, 'speaker': 'Fixture member'},
            {'at': NOW - 20, 'text': 'Fixture link https://example.test/item', 'speaker': 'Fixture member'},
            {'at': NOW - 10, 'text': 'Fixture response', 'speaker': '主人'},
            {'at': NOW - 6, 'text': '[图片]', 'speaker': 'Fixture member'},
        ])
        self.assertFalse(result['truncated'])
        public = json.dumps(result['rows'])
        self.assertNotIn(ROOM, public)
        self.assertNotIn(OTHER_MEMBER, public)
        self.assertNotIn('fixture_secret', public)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.read('digest_group_read', id=self.opaque, until=NOW - (2 * guest.DIGEST_WINDOW))

    def test_bulk_messages_respect_global_character_and_row_limits(self):
        for number in range(guest.MAX_DIGEST_ROWS + 5):
            self.add(number + 1, NOW - 100 + number, '测' * 600)
        with patch.object(guest, 'group_members', return_value=None):
            result = self.read('digest_group_read', id=self.opaque, until=NOW)
        self.assertTrue(result['truncated'])
        self.assertLess(len(result['rows']), guest.MAX_DIGEST_ROWS)
        self.assertEqual(result['rows'][-1]['at'], NOW - 16)
        self.assertLessEqual(sum(len(item['text']) + len(item['speaker']) for item in result['rows']),
                             guest.MAX_DIGEST_CHARACTERS)

    def test_followup_requires_native_owner_mention_and_exact_owner_sender(self):
        quote = ('<msg><appmsg><type>57</type><title>周五可以。</title>'
                 '<refermsg><svrid>4</svrid></refermsg></appmsg></msg>')
        self.add(1, NOW - 80, '旧窗口', native_mentions=OWNER)
        self.add(2, NOW - 50, '@Fixture owner 仅显示名', native_mentions=OTHER_MEMBER)
        self.add(3, NOW - 40, OTHER_MEMBER + ':\n周五能来吗？', native_mentions=OWNER)
        self.add(4, NOW - 30, '我在群里聊了别的', speaker=1)
        self.add(5, NOW - 20, quote, speaker=2, raw_type=(57 << 32) | 49, native_mentions=OWNER)
        self.add(6, NOW - 10, quote, speaker=1, raw_type=(57 << 32) | 49)
        self.add(7, NOW - 5, '桌宠自己的消息', speaker=3, native_mentions=OWNER)
        self.add(8, NOW, '汇报时间点以后不读', native_mentions=OWNER)
        result = self.read('followup_group_read', id=self.opaque, since=NOW - 60, until=NOW)
        self.assertFalse(result['truncated'])
        rows = result['rows']
        self.assertEqual([(row['role'], row['text']) for row in rows], [
            ('member', '周五能来吗？'), ('owner', '我在群里聊了别的'), ('member', '周五可以。'), ('owner', '周五可以。'),
        ])
        self.assertTrue(rows[0]['mentionsOwner'])
        self.assertEqual(rows[0]['author'], rows[2]['author'])
        self.assertNotIn('quoteId', rows[2])
        self.assertNotIn('author', rows[3])
        self.assertEqual(rows[-1]['quoteId'], rows[0]['id'])
        public = json.dumps(rows)
        self.assertNotIn(OWNER, public)
        self.assertNotIn(OTHER_MEMBER, public)
        self.assertNotIn(ROOM, public)
        self.assertNotIn(ACCOUNT, public)

    def test_followup_refuses_stale_windows_and_reports_incomplete_evidence(self):
        read = lambda: self.read('followup_group_read', id=self.opaque, since=NOW - 30, until=NOW)
        self.message.execute(f'DROP TABLE "{self.table}"')
        self.assertTrue(read()['truncated'])
        self.message.execute(f'CREATE TABLE "{self.table}" (local_id,server_id,real_sender_id,local_type,create_time,message_content,compress_content,source)')
        for index in range(guest.MAX_FOLLOWUP_ROWS + 5):
            self.add(index + 1, NOW - 10, '测试' * 220, native_mentions=OWNER)
        result = read()
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['rows']), guest.MAX_FOLLOWUP_ROWS)
        self.assertLessEqual(len(result['rows'][0]['text']), guest.MAX_FOLLOWUP_CHARS)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.read('followup_group_read', id=self.opaque, since=NOW - guest.FOLLOWUP_WINDOW - 1, until=NOW)


class DigestControlTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(prefix='fixture-wechat-digest-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.runtime = root / 'runtime'
        self.database = root / 'listener.db'
        with WeChatState(self.database) as state:
            DbIntake(state, ACCOUNT, FINGERPRINT, (
                DbScope(BINDING, 'private', OWNER), DbScope(REPLY_BINDING, 'group', REPLY, GroupPolicy('mentions', None, '1')),
            )).enroll()
        self.bindings = {'private': BINDING, 'legacy': REPLY_BINDING}
        self.owner = {'fingerprint': FINGERPRINT}
        for name, value in [('owner_record', self.owner), ('enrolled_bindings', self.bindings)]:
            mock = patch.object(listener, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        self.opaque = guest.digest_group_id(ACCOUNT, ROOM)
        self.requests = []

    def reader(self):
        def read(operation):
            self.requests.append(operation)
            self.assertEqual(operation['group_ids'], [REPLY])
            if operation['op'] == 'digest_group_list':
                return {'account_id': ACCOUNT, 'groups': [{'id': self.opaque, 'title': 'Fixture room'}]}
            self.assertEqual(operation['id'], self.opaque)
            return {'account_id': ACCOUNT, 'rows': [{'text': 'Fixture content', 'at': NOW - 1}], 'truncated': False}

        return SimpleNamespace(read=read)

    def run_control(self, action, value=None):
        return controls.digest_groups(action, {}, self.runtime, self.database, value, self.reader())

    def test_current_private_selection_required_and_only_opaque_ids_are_stored(self):
        self.assertEqual(self.run_control('digest-group-list'), {'groups': [{'id': self.opaque, 'title': 'Fixture room'}]})
        reading = {'binding': BINDING, 'id': self.opaque, 'until': NOW}
        with self.assertRaisesRegex(DatabaseUnavailable, 'digest_scope_changed'):
            self.run_control('digest-group-read', reading)
        with self.assertRaisesRegex(DatabaseUnavailable, 'digest_scope_changed'):
            self.run_control('digest-group-select', {'binding': BINDING, 'ids': [guest.digest_group_id(ACCOUNT, REPLY)]})
        self.assertEqual(self.run_control('digest-group-select', {'binding': BINDING, 'ids': [self.opaque]}), {'ok': True})
        stored = self.runtime / controls.SELECTION_FILE
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(ROOM, stored.read_text())
        self.assertTrue(controls.is_digest_group(self.runtime, ACCOUNT, ROOM))
        result = self.run_control('digest-group-read', reading)
        self.assertEqual(result, {'rows': [{'text': 'Fixture content', 'at': NOW - 1}], 'truncated': False})
        with self.assertRaisesRegex(DatabaseUnavailable, 'digest_scope_changed'):
            self.run_control('digest-group-read', dict(reading, binding='f' * 64))
        listener.set_paused(self.runtime, True)
        with self.assertRaisesRegex(DatabaseUnavailable, 'digest_scope_changed'):
            self.run_control('digest-group-read', reading)

    def test_followup_permissions_are_independent_and_revocable(self):
        def run(action, payload):
            return followup.followup_groups(action, {}, self.runtime, self.database, payload, self.reader())

        selection = {'binding': BINDING, 'ids': [self.opaque]}
        reading = {'binding': BINDING, 'id': self.opaque, 'since': NOW - 30, 'until': NOW}
        self.run_control('digest-group-select', selection)
        with self.assertRaisesRegex(DatabaseUnavailable, 'followup_scope_changed'):
            run('followup-group-read', reading)
        with self.assertRaisesRegex(DatabaseUnavailable, 'followup_scope_changed'):
            run('followup-group-select', dict(selection, binding='f' * 64))
        self.assertEqual(run('followup-group-select', selection), {'ok': True})
        self.assertEqual((self.runtime / followup.SELECTION_FILE).stat().st_mode & 0o777, 0o600)
        self.assertEqual(run('followup-group-read', reading)['rows'][0]['at'], NOW - 1)
        self.assertEqual(self.requests[-1], {'op': 'followup_group_read', 'account_id': ACCOUNT, 'owner_id': OWNER,
                                            'group_ids': [REPLY], 'id': self.opaque, 'since': NOW - 30, 'until': NOW})
        listener.set_paused(self.runtime, True)
        with self.assertRaisesRegex(DatabaseUnavailable, 'followup_scope_changed'):
            run('followup-group-read', reading)
        listener.set_paused(self.runtime, False)
        run('followup-group-select', dict(selection, ids=[]))
        with self.assertRaisesRegex(DatabaseUnavailable, 'followup_scope_changed'):
            run('followup-group-read', reading)

    def test_waits_for_the_listener_poll_to_release_the_binding_lock(self):
        # The live listener holds this lock for each database poll; a digest read failed as busy on 2026-11-16.
        held = threading.Event()

        def poll():
            with listener.group_policy_lock(self.runtime):
                held.set()
                time.sleep(0.6)

        worker = threading.Thread(target=poll)
        worker.start()
        held.wait()
        try:
            self.assertEqual(self.run_control('digest-group-list'), {'groups': [{'id': self.opaque, 'title': 'Fixture room'}]})
        finally:
            worker.join()
        with patch.object(controls, 'LOCK_WAIT', 0.3), listener.group_policy_lock(self.runtime):
            with self.assertRaises(BlockingIOError):
                self.run_control('digest-group-list')

    def test_missing_active_reply_pin_blocks_reads_and_a_digest_group_can_still_be_bound_for_replies(self):
        self.run_control('digest-group-select', {'binding': BINDING, 'ids': [self.opaque]})
        self.bindings['fixture-added'] = 'f' * 64
        with self.assertRaisesRegex(DatabaseUnavailable, 'digest_scope_unverified'):
            self.run_control('digest-group-list')
        del self.bindings['fixture-added']
        with WeChatState(self.database) as state, patch.object(listener, 'enrolled_groups', return_value={}), \
                patch.object(listener, 'active_group', return_value=('Fixture room', ('1' * 64,))), \
                patch.object(listener.ui, 'conversation_messages', return_value=[]), \
                patch.object(listener, 'private_binding_key', return_value=BINDING), \
                patch.object(listener, 'DatabaseReader') as reader:
            reader.return_value.read.return_value = {'account_id': ACCOUNT, 'groups': [{'id': ROOM}]}
            settings = {'account_name': 'Fixture bot', 'targets': {'private': {'title': 'Fixture owner'}}}
            # Selection for a digest no longer reserves the group: binding goes on to registration.
            with patch.object(listener, 'read_group_registry', side_effect=RuntimeError('reached-registration')), \
                    self.assertRaisesRegex(RuntimeError, 'reached-registration'):
                listener.bind_selected_group(state, settings, self.runtime / 'unused.png', self.runtime)


if __name__ == '__main__':
    unittest.main()
