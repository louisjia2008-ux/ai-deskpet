"""Exercise the friend scope through the read-only guest and host intake."""

import base64
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from test_wechat_db_guest import add_table, fill, guest
from wechat_db_intake import DbIntake, DbScope
from wechat_state import StateConflict, WeChatState, database_queue_command


ACCOUNT = 'fixture_self'
OWNER = 'fixture_owner'
FRIEND = 'fixture_friend'
OWNER_BINDING = 'a' * 64
FRIEND_BINDING = 'b' * 64
FINGERPRINT = 'c' * 64
GENERATION = 'd' * 32
SHARD = 'message_0.db'


class FriendDatabaseTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'message').mkdir()
        (self.root / 'message/media_0.db').touch()
        (self.root / 'message' / SHARD).touch()
        self.contacts = self.connection()
        self.contacts.execute('CREATE TABLE contact(username,nick_name,remark,alias,local_type,flag,delete_flag,verify_flag)')
        self.contacts.executemany('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)', (
            (ACCOUNT, 'Self fixture', '', '', 1, 3, 0, 0),
            (OWNER, 'Owner fixture', '', '', 1, 3, 0, 0),
            (FRIEND, 'Friend nickname', 'Friend fixture', 'friend_alias', 1, 3, 0, 0),
            ('gh_fixture', 'Official fixture', '', '', 1, 3, 0, 0),
            ('filehelper', 'System fixture', '', '', 1, 3, 0, 0),
            ('123@chatroom', 'Group fixture', '', '', 1, 3, 0, 0),
            ('fixture_deleted', 'Deleted fixture', '', '', 1, 3, 1, 0),
            ('fixture_verified', 'Verified fixture', '', '', 1, 3, 0, 24),
            ('fixture_unknown', 'Unconfirmed contact', '', '', 1, 1, 0, 0),
            ('fixture_stranger', 'Stranger fixture', '', '', 0, 0, 0, 0),
        ))
        self.messages = self.connection()
        self.messages.execute('CREATE TABLE Name2Id(user_name)')
        self.messages.executemany('INSERT INTO Name2Id VALUES (?)', ((OWNER,), (ACCOUNT,), (FRIEND,), ('fixture_other',)))
        self.owner_table = add_table(self.messages, OWNER)
        self.friend_table = add_table(self.messages, FRIEND)
        self.media = self.connection()
        self.media.execute('CREATE TABLE Name2Id(user_name)')
        self.media.executemany('INSERT INTO Name2Id VALUES (?)', ((OWNER,), (FRIEND,)))
        self.media.execute('CREATE TABLE VoiceInfo(svr_id,chat_name_id,data_index,voice_data)')
        self.friend_id = guest.reply_friend_id(ACCOUNT, FRIEND)
        state = WeChatState(self.root / 'ledger.db')
        self.state = state.__enter__()
        self.addCleanup(lambda: state.__exit__(None, None, None))
        self.owner_scope = DbScope(OWNER_BINDING, 'private', OWNER)
        self.friend_scope = DbScope(FRIEND_BINDING, 'friend', self.friend_id, display_name='Friend fixture')

    def connection(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        return db

    def guest_response(self, request):
        @contextmanager
        def fake_open(path, _keys):
            yield {'contact.db': self.contacts, 'media_0.db': self.media, SHARD: self.messages}[path.name], GENERATION

        wire = json.dumps(request).encode() + b'\n'
        with patch.object(guest, 'open_logical', new=fake_open):
            return guest.respond(guest.parse_request(wire), self.root, ACCOUNT, b'x' * 32)

    def friend_read(self, op, **fields):
        return self.guest_response({'op': op, 'account_id': ACCOUNT, 'owner_id': OWNER, **fields})

    def test_roster_requires_observed_friend_flags_and_exact_contact_card(self):
        self.assertEqual(self.friend_read('friend_list')['friends'], [{'id': self.friend_id, 'title': 'Friend fixture'}])
        saved = self.friend_read('friend_verify', friend_id=self.friend_id, title='Friend fixture', alias='friend_alias')
        self.assertEqual(saved['friend'], {'id': self.friend_id, 'title': 'Friend fixture'})
        self.assertNotIn(FRIEND, json.dumps(saved))
        with self.assertRaisesRegex(guest.LocalDataError, 'friend_binding_invalid'):
            self.friend_read('friend_verify', friend_id=self.friend_id, title='Friend fixture', alias=OWNER)
        with self.assertRaisesRegex(guest.LocalDataError, 'friend_binding_invalid'):
            self.friend_read('friend_verify', friend_id=self.friend_id, title='Different title', alias='friend_alias')
        self.contacts.execute('UPDATE contact SET alias=? WHERE username=?', ('friend_alias', OWNER))
        with self.assertRaisesRegex(guest.LocalDataError, 'friend_binding_ambiguous'):
            self.friend_read('friend_verify', friend_id=self.friend_id, title='Friend fixture', alias='friend_alias')
        self.contacts.execute('UPDATE contact SET alias=? WHERE username=?', ('', OWNER))
        self.contacts.execute('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)',
                              ('fixture_same_title', 'Ｆｒｉｅｎｄfixture', '', 'second_alias', 1, 3, 0, 0))
        with self.assertRaisesRegex(guest.LocalDataError, 'friend_binding_ambiguous'):
            self.friend_read('friend_verify', friend_id=self.friend_id, title='Friend fixture', alias='friend_alias')

    def test_intake_keeps_the_owner_lane_independent_and_friend_rows_opaque(self):
        intake = DbIntake(self.state, ACCOUNT, FINGERPRINT, [self.owner_scope, self.friend_scope])
        intake.enroll()
        owner = intake.request()
        self.assertEqual(intake.apply(owner, self.guest_response(owner)).baselined, (OWNER_BINDING,))
        self.assertNotIn(FRIEND_BINDING, intake.apply(intake.request(), self.guest_response(intake.request())).statuses)
        friend = intake.request_friend(FRIEND_BINDING)
        self.assertEqual(intake.apply(friend, self.guest_response(friend)).baselined, (FRIEND_BINDING,))

        fill(self.messages, self.owner_table, 1, body='owner text')
        fill(self.messages, self.friend_table, 1, sender=2, body='own text should not leave guest')
        fill(self.messages, self.friend_table, 2, sender=4, body='untrusted sender should not leave guest')
        fill(self.messages, self.friend_table, 3, sender=3, body='发')
        fill(self.messages, self.friend_table, 4, sender=3, body='/cancel-queue')
        quote = '<msg><appmsg><title>存</title><type>57</type><refermsg><content>sample quote</content></refermsg></appmsg></msg>'
        transfer = '<msg><appmsg><title>pay</title><type>2000</type><wcpayinfo/></appmsg></msg>'
        for local, kind, body in ((5, (57 << 32) | 49, quote), (6, (2000 << 32) | 49, transfer),
                                  (7, 34, ''), (8, 3, '')):
            self.messages.execute(f'INSERT INTO "{self.friend_table}" VALUES (?,?,3,?,1,?,NULL,NULL)', (local, local, kind, body))
        owner = intake.request()
        intake.apply(owner, self.guest_response(owner))
        self.assertEqual(self.state.pending(OWNER_BINDING)[0].observation['text'], 'owner text')
        self.assertEqual(self.state.pending(FRIEND_BINDING), ())

        friend = intake.request_friend(FRIEND_BINDING)
        read = self.guest_response(friend)
        self.assertEqual(list(read['cursors']), [f'{SHARD}/{self.friend_id}'])
        self.assertNotIn('controls', read)
        encoded = json.dumps(read)
        for hidden in (OWNER, FRIEND, 'untrusted sender', 'own text'):
            self.assertNotIn(hidden, encoded)
        next(row for row in read['rows'] if row['type'] == 34)['transcript'] = 'sample voice'
        intake.apply(friend, read)
        self.assertEqual(DbIntake.pins(self.state)[FRIEND_BINDING].conversation_id, self.friend_id)
        events = self.state.pending(FRIEND_BINDING)
        self.assertEqual([event.observation['text'] for event in events[:4]], ['发', '/cancel-queue', '存', 'sample voice'])
        self.assertEqual(events[2].observation['quote'], '引用：sample quote')
        self.assertEqual(events[3].observation['voice'], {'heard': True})
        self.assertEqual(events[4].observation['rich']['kind'], 'image')
        self.assertEqual(len(events), 5)
        for event in events:
            self.assertTrue(intake.event_authorized(event))
            self.assertFalse(database_queue_command(event.observation))
            self.assertFalse(DbIntake(self.state, ACCOUNT, FINGERPRINT, [self.owner_scope]).event_authorized(event))
        with self.assertRaises(StateConflict):
            intake.apply({**friend, 'friend_id': OWNER}, read)

    def test_receipts_and_voice_access_are_conversation_scoped_and_revoke_with_contact(self):
        identity = {'friend_id': self.friend_id}
        baseline = self.friend_read('send_baseline', **identity)
        self.assertEqual(list(baseline['cursors']), [f'{SHARD}/{self.friend_id}'])
        name = 'synthetic outbound result'
        fill(self.messages, self.owner_table, 1, sender=2, created_at=baseline['since'], body=name)
        receipt = {**identity, 'cursors': baseline['cursors'], 'since': baseline['since'], 'kind': 'text', 'text': name}
        self.assertEqual(self.friend_read('send_receipt', **receipt)['status'], 'pending')
        fill(self.messages, self.friend_table, 1, sender=2, created_at=baseline['since'], body=name)
        self.assertEqual(self.friend_read('send_receipt', **receipt)['status'], 'confirmed')
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.friend_read('send_receipt', **receipt, conversation=OWNER)

        self.media.executemany('INSERT INTO VoiceInfo VALUES (123,?,0,?)', ((1, b'owner data'), (2, b'friend data')))
        voice = self.friend_read('voice_audio', server_id='123', **identity)
        self.assertEqual(base64.b64decode(voice['audio']), b'friend data')
        self.contacts.execute('UPDATE contact SET delete_flag=1 WHERE username=?', (FRIEND,))
        self.assertEqual(self.friend_read('friend_list')['friends'], [])
        for op, fields in (('friend_poll', {'baseline': True}), ('send_baseline', {}),
                           ('voice_audio', {'server_id': '123'}), ('send_receipt', receipt)):
            with self.subTest(op=op), self.assertRaisesRegex(guest.LocalDataError, 'friend_binding_invalid'):
                self.friend_read(op, **(identity | fields))
        owner = self.friend_read('poll', group_ids=[], baseline=True)
        self.assertEqual(list(owner['cursors']), [f'{SHARD}/{OWNER}'])
