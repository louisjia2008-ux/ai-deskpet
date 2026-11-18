"""Synthetic native SNS cache fixtures for friend Moments summaries."""

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
import wechat_friends_moments as moments
from wechat_db_channel import DatabaseUnavailable


ACCOUNT, OWNER, FRIEND = 'fixture_bot', 'fixture_owner', 'fixture_friend'
MISSING, REMOVED, PUBLIC = 'fixture_missing', 'fixture_removed', 'gh_fixture_public'
BINDING = 'a' * 64
STORAGE = Path('fixture/db_storage')
NOW = 10 * guest.DIGEST_WINDOW


def media(kind, extras='', url='<url>https://example.test/media</url>'):
    return f'<media><type>{kind}</type>{url}{extras}</media>'


def content(style, items, tag='type'):
    return f'<ContentObject><{tag}>{style}</{tag}><mediaList>{items}</mediaList></ContentObject>'


def sns_xml(author, when, text, extras=''):
    item = f'<TimelineObject><username>{author}</username><createTime>{when}</createTime><contentDesc>{escape(text)}</contentDesc>{extras}</TimelineObject>'
    return f'<SnsDataItem>{item}<commentList><comment>fixture_comment</comment></commentList></SnsDataItem>'


class FriendsMomentsGuestTest(unittest.TestCase):
    def setUp(self):
        self.contacts = sqlite3.connect(':memory:')
        self.sns = sqlite3.connect(':memory:')
        for db in (self.contacts, self.sns):
            db.row_factory = sqlite3.Row
            self.addCleanup(db.close)
        self.contacts.execute('CREATE TABLE contact(username,nick_name,delete_flag)')
        self.contacts.executemany('INSERT INTO contact VALUES (?,?,?)', (
            (OWNER, 'Fixture owner', 0), (ACCOUNT, 'Fixture bot', 0), (FRIEND, 'Fixture friend', 0),
            (REMOVED, 'Fixture removed', 1), (PUBLIC, 'Fixture public', 0),
        ))
        self.sns.execute('CREATE TABLE SnsTimeLine(tid,user_name,content,pack_info_buf)')

    def add(self, tid, author, raw):
        self.sns.execute('INSERT INTO SnsTimeLine VALUES (?,?,?,?)', (tid, author, raw, b'fixture_pack'))

    def read(self, days=1, until=NOW):
        @contextmanager
        def local_db(path, _keys):
            self.assertIn(path, (STORAGE / 'contact/contact.db', STORAGE / 'sns/sns.db'))
            yield (self.contacts if path.name == 'contact.db' else self.sns), None

        with patch.object(guest, 'open_logical', side_effect=local_db), patch.object(guest.time, 'time', return_value=NOW):
            return guest.respond({'op': 'friends_moments_read', 'account_id': ACCOUNT, 'owner_id': OWNER,
                                  'days': days, 'until': until}, STORAGE, ACCOUNT, b'fixture')

    def test_only_current_contacts_with_matching_native_authors_contribute(self):
        selected = sns_xml(FRIEND, NOW - 30, 'Fixture moved', content('1', media('2')))
        self.add(1, FRIEND, selected)
        self.add(2, FRIEND, sns_xml(OWNER, NOW - 24, 'mismatched row author'))
        self.add(3, ACCOUNT, sns_xml(ACCOUNT, NOW - 23, 'self'))
        self.add(4, MISSING, sns_xml(MISSING, NOW - 22, 'not a contact'))
        self.add(5, REMOVED, sns_xml(REMOVED, NOW - 21, 'removed contact'))
        self.add(6, PUBLIC, sns_xml(PUBLIC, NOW - 20, 'public account'))
        self.add(7, FRIEND, sns_xml(FRIEND, NOW - 19, 'duplicate author').replace(
            '</username>', f'</username><username>{OWNER}</username>'))
        self.add(8, FRIEND, '<!DOCTYPE msg [<!ENTITY x "unsafe">]>' + selected)
        result = self.read()
        self.assertEqual(result['posts'], [{'author': 'Fixture friend', 'at': NOW - 30, 'text': 'Fixture moved', 'images': 1}])
        self.assertFalse(result['truncated'])
        self.assertNotIn(FRIEND, json.dumps(result['posts']))
        self.assertNotIn('fixture_comment', json.dumps(result['posts']))
        self.assertNotIn('example.test', json.dumps(result['posts']))
        self.assertNotIn('fixture_pack', json.dumps(result['posts']))

    def test_only_proven_image_media_counts_thumbnails_and_videos_stay_out(self):
        mixed = media('2') + media('6', '<videoDuration>3</videoDuration>') + media(
            '2', url='<url videomd5="fixture">https://example.test/video</url>') + media(
            '2', url='<thumb>https://example.test/thumb</thumb>') + '<media><type>2</type><type>6</type></media>'
        self.add(1, FRIEND, sns_xml(FRIEND, NOW - 50, '', content('1', mixed)))
        self.add(2, FRIEND, sns_xml(FRIEND, NOW - 40, 'Fixture link', content('3', media('2'))))
        self.add(3, FRIEND, sns_xml(FRIEND, NOW - 30, 'Fixture video', content('15', media('6'), tag='contentStyle')))
        self.add(4, FRIEND, sns_xml(FRIEND, NOW - 20, 'Fixture alternate image', content('1', media('2'), tag='contentStyle')))
        self.add(5, FRIEND, sns_xml(FRIEND, NOW - 10, 'Fixture ambiguous style',
                                   '<ContentObject><type>1</type><contentStyle>15</contentStyle>'
                                   '<mediaList>' + media('2') + '</mediaList></ContentObject>'))
        found = [(entry['text'], entry['images']) for entry in self.read()['posts']]
        self.assertEqual(found, [('Fixture ambiguous style', 0), ('Fixture alternate image', 1), ('Fixture video', 0),
                                 ('Fixture link', 0), ('', 1)])

    def test_daily_and_weekly_windows_remain_bounded_and_deduplicated(self):
        later = sns_xml(FRIEND, NOW - 2 * guest.DIGEST_WINDOW, 'Weekly fixture')
        for tid, days in ((1, 8), (3, 2), (4, 0)):
            self.add(tid, FRIEND, sns_xml(FRIEND, NOW - days * guest.DIGEST_WINDOW, 'Fixture ' + str(tid)))
        self.add(3, FRIEND, later)
        self.assertEqual(self.read()['posts'], [])
        self.assertEqual(len(self.read(days=7)['posts']), 1)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.read(days=2)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            self.read(days=7, until=NOW + 100)
        with self.assertRaisesRegex(guest.LocalDataError, 'invalid_request'):
            guest.parse_request(b'{"op":"friends_moments_read","refresh":true}\n')

    def test_scan_and_output_caps_survive_long_cache(self):
        for index in range(guest.MAX_MOMENT_SCAN + 5):
            self.add(index + 1, FRIEND, sns_xml(FRIEND, NOW - 1_000 + index, '测' * 780))
        result = self.read()
        self.assertTrue(result['truncated'])
        self.assertEqual(result['posts'][0]['at'], NOW - 736)
        self.assertLessEqual(len(result['posts']), guest.MAX_FRIEND_MOMENTS)
        self.assertLessEqual(sum(len(post['author']) + len(post['text']) for post in result['posts']),
                             guest.MAX_MOMENT_CHARACTERS)


class FriendsMomentsControlTest(unittest.TestCase):
    def test_worker_verifies_binding_before_and_after_and_withholds_if_paused(self):
        owner = SimpleNamespace(account_id=ACCOUNT, conversation_id=OWNER)
        result = {'account_id': ACCOUNT, 'posts': [], 'truncated': False}
        reader = SimpleNamespace(read=lambda _request: result)
        request = {'binding': BINDING, 'until': NOW, 'days': 1}
        with patch.object(moments, 'verified_owner_pin', return_value=(BINDING, owner)), \
                patch.object(moments, 'is_paused', return_value=False):
            self.assertEqual(moments.read_friends_moments({}, Path('unused'), Path('unused'), request, reader),
                             {'posts': [], 'truncated': False})
            with self.assertRaisesRegex(DatabaseUnavailable, 'moments_scope_changed'):
                moments.read_friends_moments({}, Path('unused'), Path('unused'), dict(request, binding='f' * 64), reader)
        for paused, rebound in ((True, BINDING), (False, 'f' * 64)):
            with patch.object(moments, 'verified_owner_pin', side_effect=[(BINDING, owner), (rebound, owner)]), \
                    patch.object(moments, 'is_paused', side_effect=[False, paused]):
                with self.assertRaisesRegex(DatabaseUnavailable, 'moments_scope_changed'):
                    moments.read_friends_moments({}, Path('unused'), Path('unused'), request, reader)


if __name__ == '__main__':
    unittest.main()
