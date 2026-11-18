"""Native owner activity metadata, with read-only synthetic SQLite sessions only."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_db_guest as guest


class OwnerActivityTest(unittest.TestCase):
    def setUp(self):
        self.owner = 'fixture_owner'
        self.account = 'fixture_bot'
        self.table = guest.table_for(self.owner)
        self.contacts = sqlite3.connect(':memory:')
        self.addCleanup(self.contacts.close)
        self.contacts.row_factory = sqlite3.Row
        self.contacts.execute('CREATE TABLE contact(username)')
        self.contacts.execute('INSERT INTO contact VALUES (?)', (self.owner,))
        self.shards = [Path('message_0.db'), Path('message_1.db')]
        self.databases = {}
        for path in self.shards:
            db = sqlite3.connect(':memory:')
            self.addCleanup(db.close)
            # No body or sender column exists: the op must only query timestamps.
            db.execute(f'CREATE TABLE "{self.table}"(create_time)')
            self.databases[path] = db

    def request(self, **overrides):
        @contextmanager
        def fake_open(path, _keys):
            db = self.contacts if path == Path('contact/contact.db') else self.databases[path]
            db.execute('PRAGMA query_only=ON')
            yield db, 'fixture-generation'

        request = {'op': 'owner_activity', 'account_id': self.account, 'owner_id': self.owner} | overrides
        request = guest.parse_request((json.dumps(request) + '\n').encode())
        with patch.object(guest, 'message_shards', return_value=self.shards), patch.object(guest, 'open_logical', new=fake_open):
            return guest.respond(request, Path('.'), self.account, b'x' * 32)

    def test_latest_native_timestamp_across_shards_has_no_identity_or_content(self):
        for path, times in zip(self.shards, ((100, 400), (300, 200))):
            self.databases[path].executemany(f'INSERT INTO "{self.table}" VALUES (?)', [(at,) for at in times])
            other = guest.table_for('fixture_other')
            self.databases[path].execute(f'CREATE TABLE "{other}"(create_time)')
            self.databases[path].execute(f'INSERT INTO "{other}" VALUES (999)')
        self.assertEqual(self.request(), {'ok': True, 'at': 400})

    def test_empty_or_missing_owner_tables_return_unknown_not_idle(self):
        self.assertEqual(self.request(), {'ok': True, 'at': None})

    def test_invalid_time_and_account_or_owner_fail_closed(self):
        self.databases[self.shards[0]].execute(f'INSERT INTO "{self.table}" VALUES (?)', ('bad',))
        with self.assertRaises(guest.LocalDataError):
            self.request()
        for overrides in ({'account_id': 'fixture_wrong'}, {'owner_id': 'fixture_other'}, {'owner_id': self.account},
                          {'conversation': 'fixture_other'}, {'group_ids': []}):
            with self.subTest(overrides=overrides), self.assertRaises(guest.LocalDataError):
                self.request(**overrides)
