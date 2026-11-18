"""Synthetic-only fixtures for the read-only guest reader."""
import base64
from contextlib import contextmanager
import hashlib
import hmac
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_db_guest as guest


def encrypt(clear, number, salt, key, mac_key):
    start = 16 if number == 1 else 0
    iv = bytes([number % 256]) * 16
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    encrypted = encryptor.update(clear[start:guest.IV_OFFSET]) + encryptor.finalize() + iv
    mac = hmac.digest(mac_key, encrypted + struct.pack('<I', number), 'sha512')
    return (salt if start else b'') + encrypted + mac


def header(count, marker):
    page = bytearray(guest.PAGE_SIZE)
    page[:16] = b'SQLite format 3\0'
    page[16:21] = b'\x10\x00\x02\x02\x50'
    struct.pack_into('>I', page, 28, count)
    page[120] = marker
    return page


def wal_for(frames):
    head = struct.pack('>IIII8s', 0x377f0682, 3007000, guest.PAGE_SIZE, 0, b'WALSALTS')
    checksum = guest.wal_checksum(head, '<')
    out = [head, struct.pack('>II', *checksum)]
    for number, commit, page in frames:
        prefix = struct.pack('>II', number, commit)
        checksum = guest.wal_checksum(prefix + page, '<', checksum)
        out.extend((prefix, b'WALSALTS', struct.pack('>II', *checksum), page))
    return b''.join(out)


def fill(db, table, local_id, *, sender=1, body='hello', source='', created_at=1):
    db.execute(f'INSERT INTO "{table}" VALUES (?, ?, ?, 1, ?, ?, NULL, ?)',
               (local_id, -100 + local_id, sender, created_at, body, source))


def add_table(db, username):
    table = guest.table_for(username)
    db.execute(f'CREATE TABLE "{table}"(local_id INTEGER PRIMARY KEY, server_id, real_sender_id, local_type, '
               f'create_time, message_content, compress_content, source)')
    return table


class CipherTests(unittest.TestCase):
    def setUp(self):
        self.salt = b'synthetic salt!!'
        self.key, self.mac = guest.Keys(b'x' * 32).for_salt(self.salt)
        self.main = encrypt(header(2, 4), 1, self.salt, self.key, self.mac)
        self.second = encrypt(bytes([22]) * guest.PAGE_SIZE, 2, self.salt, self.key, self.mac)
        self.tail = bytes(guest.PAGE_SIZE * 6)

    def test_authenticated_wal_including_preallocated_database(self):
        new_main = encrypt(header(2, 7), 1, self.salt, self.key, self.mac)
        third_uncommitted = encrypt(bytes([77]) * guest.PAGE_SIZE, 2, self.salt, self.key, self.mac)
        wal = wal_for([(1, 8, new_main), (2, 0, third_uncommitted)])
        output = guest.logical_image(self.main + self.second + self.tail, wal, self.key, self.mac)
        self.assertEqual(len(output), 2 * guest.PAGE_SIZE)
        self.assertEqual(output[:16], b'SQLite format 3\0')
        self.assertEqual(output[18:20], b'\x01\x01')
        self.assertEqual(output[120], 7)
        self.assertEqual(output[guest.PAGE_SIZE], 22)

    def test_rejects_invalid_authenticated_page_and_nonzero_physical_tail(self):
        with self.assertRaisesRegex(guest.LocalDataError, 'page_authentication_failed'):
            guest.logical_image(self.main + self.second[:-1] + bytes([self.second[-1] ^ 1]),
                                b'', self.key, self.mac)
        with self.assertRaisesRegex(guest.LocalDataError, 'unexpected_preallocated_pages'):
            guest.logical_image(self.main + self.second + b'X' + self.tail[1:], b'', self.key, self.mac)

    def test_refuses_symlink_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory).resolve()
            actual = folder / 'mock.db'
            actual.write_bytes(self.main)
            link = folder / 'symlink.db'
            link.symlink_to(actual)
            with self.assertRaisesRegex(guest.LocalDataError, 'unsupported_database_file'):
                guest.read_snapshot(link)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.own = 'wxid_own'
        self.owner = 'wxid_owner'
        self.group = '123@chatroom'
        self.shard = Path('message_0.db')
        self.generation = '4' * 32
        self.db = sqlite3.connect(':memory:')
        self.contacts = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.addCleanup(self.contacts.close)
        for db in (self.db, self.contacts):
            db.row_factory = sqlite3.Row
        self.contacts.executescript(
            'CREATE TABLE contact(id INTEGER PRIMARY KEY, username, nick_name, remark, alias);'
            'CREATE TABLE chat_room(id INTEGER PRIMARY KEY,username,ext_buffer);'
            'CREATE TABLE chatroom_member(room_id,member_id);'
        )
        self.contacts.executemany('INSERT INTO contact VALUES (?,?,?,?,?)', (
            (1, self.owner, 'Owner title', '', 'ownerAlias'),
            (2, self.group, 'Group title', '', None),
            (3, 'wxid_other', 'Shared title', '', None),
            (4, 'wxid_fourth', 'Shared title', '', None),
        ))
        self.contacts.execute('INSERT INTO chat_room VALUES (2, ?, NULL)', (self.group,))
        self.contacts.executemany('INSERT INTO chatroom_member VALUES (2,?)', [(1,), (3,), (4,)])
        self.db.execute('CREATE TABLE Name2Id(user_name)')
        self.db.executemany('INSERT INTO Name2Id VALUES (?)', ((self.owner,), (self.own,), ('wxid_other',)))
        self.private_table = add_table(self.db, self.owner)
        fill(self.db, self.private_table, 10, body='old private')
        self.unrelated_table = add_table(self.db, 'wxid_unrelated')
        fill(self.db, self.unrelated_table, 999, body='out-of-scope')

    def poll(self, **request):
        @contextmanager
        def fake_open(path, keys):
            self.assertEqual(path, self.shard)
            yield self.db, self.generation

        with patch.object(guest, 'message_shards', return_value=[self.shard]), \
             patch.object(guest, 'open_logical', new=fake_open):
            return guest.poll(Path('.'), None, self.contacts, self.own, [self.owner, self.group], request)

    def voice(self, op, **request):
        @contextmanager
        def fake_open(path, keys):
            if path == Path('contact/contact.db'):
                yield self.contacts, self.generation
            else:
                self.assertEqual(path, self.shard)
                yield self.db, self.generation

        with patch.object(guest, 'message_shards', return_value=[self.shard]), \
             patch.object(guest, 'open_logical', new=fake_open), patch.object(guest.time, 'time', return_value=1000):
            request = {'op': op, 'account_id': self.own, 'owner_id': self.owner} | request
            return guest.respond(request, Path('.'), self.own, b'x' * 32)

    def voice_row(self, table, local_id, *, sender=2, kind=34, created=1000, server_id=987, duration='3300'):
        body = '' if duration is None else f'<msg><voicemsg voicelength="{duration}"/></msg>'
        self.db.execute(f'INSERT INTO "{table}" VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
                        (local_id, server_id, sender, kind, created, body))

    def test_voice_receipt_requires_one_new_voice_to_bound_owner_with_server_id_and_duration(self):
        self.voice_row(self.private_table, 11)
        baseline = self.voice('voice_baseline')
        request = {'cursors': baseline['cursors'], 'since': baseline['since'], 'expected_duration_ms': 3500}
        self.voice_row(self.unrelated_table, 1000)
        self.voice_row(self.private_table, 12, sender=1)
        self.voice_row(self.private_table, 13, kind=49)
        self.voice_row(self.private_table, 14, created=999)
        self.assertEqual(self.voice('voice_receipt', **request)['status'], 'pending')
        self.voice_row(self.private_table, 15, server_id=0)
        self.assertEqual(self.voice('voice_receipt', **request)['status'], 'pending')
        self.db.execute(f'UPDATE "{self.private_table}" SET server_id=-99 WHERE local_id=15')
        result = self.voice('voice_receipt', **request)
        self.assertEqual(result, {'ok': True, 'account_id': self.own, 'status': 'confirmed',
                                  'duration_ms': 3300, 'server_id': str(2**64 - 99)})
        self.voice_row(self.private_table, 16, server_id=0)
        self.assertEqual(self.voice('voice_receipt', **request)['status'], 'ambiguous')

    def test_voice_receipt_rejects_wrong_account_owner_generation_and_bad_duration(self):
        with self.assertRaisesRegex(guest.LocalDataError, 'account_binding_changed'):
            self.voice('voice_baseline', account_id='wxid_other')
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.voice('voice_baseline', owner_id=self.group)
        baseline = self.voice('voice_baseline')
        request = {'cursors': baseline['cursors'], 'since': baseline['since'], 'expected_duration_ms': 3500}
        self.voice_row(self.private_table, 11, duration='24000')
        self.assertEqual(self.voice('voice_receipt', **request)['status'], 'duration_mismatch')
        self.db.execute(f'UPDATE "{self.private_table}" SET message_content=NULL WHERE local_id=11')
        self.assertEqual(self.voice('voice_receipt', **request)['status'], 'duration_unavailable')
        self.generation = '3' * 32
        with self.assertRaisesRegex(guest.LocalDataError, 'cursor_generation_changed'):
            self.voice('voice_receipt', **request)

    def test_voice_audio_returns_only_the_bound_owner_voice_in_part_order(self):
        media = sqlite3.connect(':memory:')
        self.addCleanup(media.close)
        media.row_factory = sqlite3.Row
        media.executescript('CREATE TABLE Name2Id(user_name);'
                            'CREATE TABLE VoiceInfo(chat_name_id, create_time, local_id, svr_id, voice_data, data_index);')
        media.executemany('INSERT INTO Name2Id VALUES (?)', ((self.owner,), ('wxid_other',)))
        media.executemany('INSERT INTO VoiceInfo VALUES (?,?,?,?,?,?)', (
            (1, 1000, 5, -99, b'-two', '1'), (1, 1000, 5, -99, b'\x02#!SILK_V3 one', '0'),
            (2, 1000, 6, 77, b'other chat', '0'), (1, 1000, 7, 88, b'x' * (guest.MAX_VOICE_BYTES + 1), '0'),
        ))
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        storage = Path(root.name)
        (storage / 'message').mkdir()
        (storage / 'message' / 'media_0.db').touch()

        @contextmanager
        def fake_open(path, keys):
            yield (self.contacts if path.name == 'contact.db' else media), self.generation

        def audio(server_id, **request):
            with patch.object(guest, 'open_logical', new=fake_open):
                return guest.respond({'op': 'voice_audio', 'account_id': self.own, 'owner_id': self.owner,
                                      'server_id': server_id} | request, storage, self.own, b'x' * 32)

        # The signed SQLite id of an unsigned server id; parts joined by index.
        self.assertEqual(base64.b64decode(audio(str(2**64 - 99))['audio']), b'\x02#!SILK_V3 one-two')
        self.assertEqual(audio('77'), {'ok': True, 'account_id': self.own, 'status': 'pending'})
        with self.assertRaisesRegex(guest.LocalDataError, 'voice_too_large'):
            audio('88')
        for forged in ('0', '-5', '1e3', str(2**64)):
            with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
                audio(forged)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            audio('77', owner_id=self.group)
        with self.assertRaises(guest.LocalDataError):
            guest.parse_request(b'{"op":"voice_audio","account_id":"a","owner_id":"b","server_id":"1","limit":2}\n')

    def test_discovery_exact_alias_and_ambiguity(self):
        selected = guest.select_contact(self.contacts, {'title': 'Owner title', 'alias': self.owner})
        self.assertEqual(selected, {'id': self.owner, 'title': 'Owner title', 'alias': 'ownerAlias'})
        self.assertEqual(guest.select_contact(self.contacts, {'alias': 'ownerAlias'})['id'], self.owner)
        with self.assertRaisesRegex(guest.LocalDataError, 'binding_not_found'):
            guest.select_contact(self.contacts, {'title': 'Owner title', 'alias': 'mismatch'})
        with self.assertRaisesRegex(guest.LocalDataError, 'binding_ambiguous'):
            guest.select_contact(self.contacts, {'title': 'Shared title'})

    def test_missing_table_baseline_and_limit_do_not_skip_unreturned_rows(self):
        baseline = self.poll(baseline=True)
        self.assertEqual(baseline['rows'], [])
        self.assertEqual(baseline['cursors'][f'{self.shard}/{self.group}']['local_id'], 0)
        group_table = add_table(self.db, self.group)
        fill(self.db, self.private_table, 11, body='new private')
        native = f'<msgsource><atuserlist><![CDATA[{self.own}]]></atuserlist></msgsource>'
        fill(self.db, group_table, 1, body=self.owner + ':\nraw group', source=native)
        fill(self.db, group_table, 2, sender=3, body='manually typed @label')
        first = self.poll(cursors=baseline['cursors'], limit=2)
        self.assertTrue(first['has_more'])
        self.assertEqual([row['body'] for row in first['rows']], ['raw group', 'new private'])
        self.assertEqual(first['rows'][0]['mention_ids'], [self.own])
        self.assertEqual(first['rows'][0]['sender_display_name'], 'Owner title')
        self.assertEqual(first['rows'][0]['raw_body'], self.owner + ':\nraw group')
        self.assertEqual(first['rows'][0]['server_id'], str(2**64 - 99))
        final = self.poll(cursors=first['cursors'])
        self.assertFalse(final['has_more'])
        self.assertEqual([row['body'] for row in final['rows']], ['manually typed @label'])
        self.assertFalse(final['rows'][0]['native_mention_self'])

    def test_cursor_scope_generation_and_regression_fail_closed(self):
        baseline = self.poll(baseline=True)['cursors']
        one_key = f'{self.shard}/{self.owner}'
        altered = {**baseline}
        del altered[one_key]
        with self.assertRaisesRegex(guest.LocalDataError, 'cursor_scope_changed'):
            self.poll(cursors=altered)
        for patch_value in ({'local_id': 11}, {'generation': '3' * 32}):
            altered = {**baseline, one_key: {**baseline[one_key], **patch_value}}
            with self.assertRaisesRegex(guest.LocalDataError, 'cursor_generation_changed'):
                self.poll(cursors=altered)

    def test_size_bound_pages_without_losing_messages(self):
        baseline = self.poll(baseline=True)['cursors']
        body = 'a' * 500
        fill(self.db, self.private_table, 11, body=body)
        fill(self.db, self.private_table, 12, body=body)
        with patch.multiple(guest, MAX_RESPONSE_BYTES=2400, CONTROL_RESERVE=1024):
            first = self.poll(cursors=baseline)
            self.assertEqual([row['local_id'] for row in first['rows']], [11])
            self.assertTrue(first['has_more'])
            last = self.poll(cursors=first['cursors'])
        self.assertEqual([row['local_id'] for row in last['rows']], [12])
        self.assertFalse(last['has_more'])

    def test_signed_sender_id_and_native_metadata_are_separate_from_visible_name(self):
        group_table = add_table(self.db, self.group)
        fake = f'<msgsource><other><atuserlist>{self.own}</atuserlist></other></msgsource>'
        fill(self.db, group_table, 1, sender=2, body='@label', source=fake)
        baseline = self.poll(baseline=True)['cursors']
        self.db.execute(f'DELETE FROM "{group_table}"')
        baseline[f'{self.shard}/{self.group}']['local_id'] = 0
        fill(self.db, group_table, 1, sender=2, body='@label', source=fake)
        row, = self.poll(cursors=baseline)['rows']
        self.assertEqual(row['sender_id'], self.own)
        self.assertEqual(row['mention_ids'], [])
        self.assertFalse(row['native_mention_self'])

    def test_resolves_names_only_inside_the_group(self):
        result = guest.resolve_senders(self.contacts, [self.group], [
            {'group_id': self.group, 'name': 'Owner title'},
            {'group_id': self.group, 'name': 'Shared title'},
            {'group_id': self.group, 'name': 'Missing title'},
        ])
        self.assertEqual([item['status'] for item in result], ['resolved', 'ambiguous', 'not_found'])
        self.assertEqual(result[0]['sender_id'], self.owner)
        self.assertNotIn('sender_id', result[1])

    def test_oversized_bodies_and_xml_bombs_never_grant_mentions(self):
        baseline = self.poll(baseline=True)['cursors']
        bogus = '<!DOCTYPE msgsource [<!ENTITY target "wxid_own">]>'
        bogus += '<msgsource><atuserlist>&target;</atuserlist></msgsource>'
        fill(self.db, self.private_table, 11, body='x' * (guest.MAX_BODY_BYTES + 1), source=bogus)
        row, = self.poll(cursors=baseline)['rows']
        self.assertEqual(row['body'], '')
        self.assertFalse(row['body_available'])
        self.assertEqual(row['mention_ids'], [])

    def test_private_controls_available_beyond_a_held_ordinary_cursor(self):
        baseline = self.poll(baseline=True)['cursors']
        for position in range(11, guest.CONTROL_LOOKAHEAD + 40):
            fill(self.db, self.private_table, position, created_at=position)
        latest = guest.CONTROL_LOOKAHEAD + 40
        fill(self.db, self.private_table, latest, created_at=latest, body='  /ReSuMe-QuEuE  ')
        fill(self.db, self.private_table, latest + 1, sender=3, body='/cancel-queue')
        fill(self.db, self.private_table, latest + 2, sender=2, body='/pause-queue')
        group_table = add_table(self.db, self.group)
        fill(self.db, group_table, 1, body='/cancel-queue')
        first = self.poll(cursors=baseline, limit=1)
        self.assertEqual([row['local_id'] for row in first['rows']], [11])
        self.assertEqual([row['local_id'] for row in first['controls']], [latest])
        self.assertEqual(first['cursors'][f'{self.shard}/{self.owner}']['local_id'], 11)
        self.assertEqual(first['cursors'][f'{self.shard}/{self.group}']['local_id'], 0)

    def test_protocol_rejects_duplicate_object_keys(self):
        request = b'{"op":"poll","op":"discover"}\n'
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            guest.parse_request(request)


if __name__ == '__main__':
    unittest.main()
