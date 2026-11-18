"""Synthetic official-session snapshots and private binding checks."""

from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_db_guest as guest
import wechat_official_digest as official
from wechat_db_channel import DatabaseUnavailable


BOT, OWNER = 'fixture_bot', 'fixture_owner'
PUBLIC, NEWS, INACTIVE, ORPHAN = 'gh_fixture_public', 'gh_fixture_news', 'gh_fixture_old', 'gh_fixture_missing'
GROUP = 'fixture_room@chatroom'
BINDING = 'a' * 64
NOW = guest.DIGEST_WINDOW * 10
STORAGE = Path('fixture/db_storage')
SHARD = Path('fixture/message_0.db')
ARTICLE = 'https://mp.weixin.qq.com/s?__biz=fixture&mid=111&idx=1&sn=signed'
SHORT = 'https://mp.weixin.qq.com/s/FIXTURE_123456789'


def item(title, url, source=None):
    author = f'<sourceusername>{source}</sourceusername>' if source else ''
    return f'<title>{title}</title><url>{escape(url)}</url>{author}'


def card(content, source=None):
    issuer = f'<sourceusername>{source}</sourceusername>' if source else ''
    return f'<msg><appmsg><type>5</type>{issuer}{content}</appmsg></msg>'


class OfficialSourceTest(unittest.TestCase):
    def setUp(self):
        self.contacts = sqlite3.connect(':memory:')
        self.sessions = sqlite3.connect(':memory:')
        self.messages = sqlite3.connect(':memory:')
        for db in (self.contacts, self.sessions, self.messages):
            db.row_factory = sqlite3.Row
            self.addCleanup(db.close)
        self.contacts.execute('CREATE TABLE contact(username, nick_name, remark)')
        self.contacts.executemany('INSERT INTO contact VALUES (?,?,?)', (
            (OWNER, 'Fixture owner', ''), (PUBLIC, 'Fixture bulletin', 'Private fixture remark'),
            (NEWS, 'Fixture news', ''), (INACTIVE, 'Fixture old official', ''), (GROUP, 'Fixture room', ''),
        ))
        self.sessions.execute('CREATE TABLE SessionTable(username)')
        self.sessions.executemany('INSERT INTO SessionTable VALUES (?)', ((PUBLIC,), (NEWS,), (ORPHAN,), (OWNER,), (GROUP,)))
        self.messages.execute('CREATE TABLE Name2Id(user_name)')
        self.messages.executemany('INSERT INTO Name2Id VALUES (?)', (
            (PUBLIC,), (NEWS,), (OWNER,), (BOT,), (GROUP,), (INACTIVE,), (ORPHAN,),
        ))
        for session in (PUBLIC, NEWS, OWNER, GROUP, INACTIVE, ORPHAN):
            table = guest.table_for(session)
            self.messages.execute(f'CREATE TABLE "{table}" (local_id,create_time,real_sender_id,local_type,message_content,compress_content)')
        self.account_id = guest.official_account_id(BOT, PUBLIC)

    def add(self, session, number, when, body, *, sender=1, raw_type=49):
        table = guest.table_for(session)
        self.messages.execute(f'INSERT INTO "{table}" VALUES (?,?,?,?,?,?)', (number, when, sender, raw_type, body, None))

    def run_guest(self, operation, **fields):
        lookup = {'contact.db': self.contacts, 'session.db': self.sessions, 'message_0.db': self.messages}

        @contextmanager
        def local_db(path, _keys):
            yield lookup[path.name], None

        with patch.object(guest, 'open_logical', side_effect=local_db), patch.object(guest, 'message_shards', return_value=[SHARD]), \
                patch.object(guest.time, 'time', return_value=NOW):
            return guest.respond({'op': operation, 'account_id': BOT, 'owner_id': OWNER, **fields}, STORAGE, BOT, b'fixture')

    def test_list_uses_the_intersection_of_official_contacts_and_sessions(self):
        result = self.run_guest('official_list')
        self.assertEqual(result['accounts'], [
            {'id': self.account_id, 'title': 'Fixture bulletin'},
            {'id': guest.official_account_id(BOT, NEWS), 'title': 'Fixture news'},
        ])
        self.assertNotIn('Private fixture remark', json.dumps(result))
        self.assertNotIn(PUBLIC, json.dumps(result))
        self.assertEqual(self.run_guest('official_read', ids=[], until=NOW)['articles'], [])
        with self.assertRaisesRegex(guest.LocalDataError, 'official_scope_changed'):
            self.run_guest('official_read', ids=[guest.official_account_id(BOT, INACTIVE)], until=NOW)

    def test_only_exact_native_source_and_author_can_supply_an_article(self):
        good = card(item('Fixture publication', ARTICLE + '&tracker=fixture'), PUBLIC)
        old = card(item('Expired', SHORT), PUBLIC)
        self.add(PUBLIC, 1, NOW - 80, good, raw_type=(5 << 32) | 49)
        self.add(PUBLIC, 2, NOW - 70, good, sender=4)
        self.add(PUBLIC, 3, NOW - 60, card(item('Spoofed', SHORT), NEWS))
        self.add(PUBLIC, 4, NOW - guest.DIGEST_WINDOW - 1, old)
        self.add(PUBLIC, 5, NOW - 50, good, raw_type=(57 << 32) | 49)
        self.add(PUBLIC, 6, NOW - 40, card(item('Phishing', 'https://mp.weixin.qq.com.example.test/s/FIXTURE_123456789'), PUBLIC))
        self.add(OWNER, 1, NOW - 30, card(item('Private share', SHORT), PUBLIC))
        self.add(GROUP, 1, NOW - 20, card(item('Group share', SHORT), PUBLIC))
        self.add(INACTIVE, 1, NOW - 15, old, sender=6)
        self.add(ORPHAN, 1, NOW - 10, old, sender=7)
        self.add(NEWS, 1, NOW - 5, card(item('Another account', SHORT), NEWS), sender=2)
        result = self.run_guest('official_read', ids=[self.account_id], until=NOW)
        self.assertEqual(result['articles'], [
            {'url': ARTICLE, 'title': 'Fixture publication', 'account': 'Fixture bulletin', 'at': NOW - 80},
        ])
        self.assertFalse(result['truncated'])
        self.assertEqual(len(self.run_guest('official_read', ids=None, until=NOW)['articles']), 2)

    def test_multicard_deduplicates_newest_and_fails_closed_on_damaged_shapes(self):
        newest = card('<mmreader><category>'
                      '<item>' + item('Latest', ARTICLE + '&srcid=fixture') + '</item>'
                      '<item>' + item('Second', SHORT + '?tracker=fixture') + '</item>'
                      '<item>' + item('Mismatched', SHORT, NEWS) + '</item>'
                      '<item><url>https://example.test/unknown</url></item>'
                      '</category></mmreader>', PUBLIC)
        self.add(PUBLIC, 1, NOW - 70, card(item('Duplicate', ARTICLE.replace('signed', 'older')), PUBLIC))
        self.add(PUBLIC, 2, NOW - 60, newest)
        self.add(PUBLIC, 3, NOW - 50, '<!DOCTYPE msg [<!ENTITY x "unsafe">]>' + card(item('Entity &x;', ARTICLE), PUBLIC))
        self.add(PUBLIC, 4, NOW - 40, card('<mmreader><unknown><item>' + item('Unexpected schema', ARTICLE) +
                                          '</item></unknown></mmreader>', PUBLIC))
        self.add(PUBLIC, 5, NOW - 30, card('<mmreader><category>' +
                                          '<item>' + item('Too many', ARTICLE) + '</item></category></mmreader><mmreader/>', PUBLIC))
        self.add(PUBLIC, 6, NOW - 20, card(item('Ambiguous key', ARTICLE + '&sn=conflict'), PUBLIC))
        self.add(PUBLIC, 7, NOW - 10, card(item('Credential-bearing link', SHORT.replace('://', '://name@')), PUBLIC))
        result = self.run_guest('official_read', ids=None, until=NOW)
        self.assertEqual([(row['title'], row['url']) for row in result['articles']], [('Latest', ARTICLE), ('Second', SHORT)])

    def test_source_and_window_are_bounded(self):
        for index in range(guest.MAX_OFFICIAL_SESSION_ROWS + 4):
            url = ARTICLE.replace('mid=111', f'mid={index + 1}')
            self.add(PUBLIC, index + 1, NOW - 100 + index, card(item(f'Fixture {index}', url), PUBLIC))
        result = self.run_guest('official_read', ids=None, until=NOW)
        self.assertEqual(len(result['articles']), guest.MAX_OFFICIAL_SESSION_ROWS)
        self.assertTrue(result['truncated'])
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.run_guest('official_read', ids=None, until=NOW + 100)


class OfficialControlTest(unittest.TestCase):
    def test_binding_change_during_read_withholds_all_data(self):
        owner = SimpleNamespace(account_id=BOT, conversation_id=OWNER)
        other = SimpleNamespace(account_id='fixture_rebound', conversation_id=OWNER)
        reader = SimpleNamespace(read=lambda _request: {'account_id': BOT, 'articles': [], 'truncated': False})
        with patch.object(official, 'verified_owner_pin', side_effect=[(BINDING, owner), (BINDING, other)]), \
                patch.object(official, 'is_paused', return_value=False):
            with self.assertRaisesRegex(DatabaseUnavailable, 'official_scope_changed'):
                official.read_official_sources('official-read', {}, Path('unused'), Path('unused'),
                                               {'binding': BINDING, 'ids': None, 'until': NOW}, reader)


if __name__ == '__main__':
    unittest.main()
