"""Synthetic fixtures for reading this account's own Moments and confirming a post."""
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_db_guest as guest
import wechat_moments as moments

OWN = 'wxid_own'


def row(tid, user, text, created, private=1):
    xml = (f'<SnsDataItem><TimelineObject><id>{tid}</id><username>{user}</username><createTime>{created}</createTime>'
           f'<contentDesc>{text}</contentDesc><private>{private}</private></TimelineObject></SnsDataItem>')
    return tid, user, xml


class OwnMomentsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE SnsTimeLine(tid INTEGER, user_name TEXT, content TEXT, pack_info_buf BLOB)')
        self.db.execute('CREATE TABLE SnsPendingDraftDeletionTable(local_id INTEGER, create_time INTEGER, ui_type INTEGER, '
                        'content TEXT, client_id TEXT, status INTEGER, tid TEXT)')

    def read(self, since):
        @contextmanager
        def fake_open(path, keys):
            self.assertEqual(path, Path('storage/sns/sns.db'))
            yield self.db, None

        with patch.object(guest, 'open_logical', new=fake_open):
            return guest.own_moments(Path('storage'), None, OWN, since)

    def test_returns_only_this_accounts_newer_posts_with_exact_text_and_visibility(self):
        self.db.executemany('INSERT INTO SnsTimeLine (tid, user_name, content) VALUES (?, ?, ?)', [
            row(1, OWN, '旧的', 100), row(2, 'wxid_friend', '朋友的', 300), row(3, OWN, '新的\n第二行', 300, private=0),
            (4, OWN, '<not xml'), row(5, OWN, '换了主人', 300)[:2] + (row(5, 'wxid_x', '换了主人', 300)[2],),
        ])
        self.assertEqual(self.read(200), [{'id': '3', 'created': 300, 'text': '新的\n第二行', 'private': False}])
        with self.assertRaises(guest.LocalDataError):
            self.read(-1)

    def test_reads_publish_records_the_server_accepted(self):
        def record(local_id, text, created, *, status=3, tid='15054574517181747918', privacy=2, finished='true'):
            xml = (f'<publish_data><create_time>{created}</create_time><content_desc>{text}</content_desc>'
                   f'<upload_media_list><upload_media><is_finished>{finished}</is_finished></upload_media></upload_media_list>'
                   f'<privacyType>{privacy}</privacyType></publish_data>')
            return local_id, created, 0, xml, 'c', status, tid
        self.db.executemany('INSERT INTO SnsPendingDraftDeletionTable VALUES (?,?,?,?,?,?,?)', [
            record(1, '已发出', 300), record(2, '公开', 300, privacy=0), record(3, '上传中', 300, finished='false'),
            record(4, '没编号', 300, tid=''), record(5, '失败', 300, status=1), record(6, '太早', 100),
        ])
        self.assertEqual(self.read(200), [
            {'id': '15054574517181747918', 'created': 300, 'text': '公开', 'private': False},
            {'id': '15054574517181747918', 'created': 300, 'text': '已发出', 'private': True},
        ])

    def test_request_shape(self):
        self.assertEqual(guest.parse_request(b'{"op":"own_moments","since":5}\n'), {'op': 'own_moments', 'since': 5})
        with self.assertRaises(guest.LocalDataError):
            guest.parse_request(b'{"op":"own_moments","since":5,"account_id":"x","extra":1}\n')


class ConfirmTest(unittest.TestCase):
    class Reader:
        def __init__(self, *answers):
            self.answers = list(answers)

        def read(self, request):
            assert request == {'op': 'own_moments', 'since': 50}
            return {'moments': self.answers.pop(0)}

    def test_needs_the_exact_text_and_visibility(self):
        request = {'text': '今天降温了\n好冷', 'visibility': 'private'}
        reader = self.Reader([], [{'text': '今天降温了\n好冷', 'private': True}])
        with patch.object(moments.time, 'sleep'):
            self.assertTrue(moments.confirmed(request, 50, reader))
        public = self.Reader(*([[{'text': '今天降温了\n好冷', 'private': True}]] * 20))
        with patch.object(moments.time, 'sleep'), patch.object(moments.time, 'monotonic', side_effect=[0] + [2 * i for i in range(1, 20)]):
            self.assertFalse(moments.confirmed({**request, 'visibility': 'all'}, 50, public))


if __name__ == '__main__':
    unittest.main()
