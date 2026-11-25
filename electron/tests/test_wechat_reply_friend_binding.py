"""Exercise native friend registration, the GUI identity check, and removal."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_db_guest as guest
from wechat_friend_replies import deliver_friend
import wechat_friends as friends
import wechat_listener as listener
import vm_console as ui
from wechat_db_channel import DatabaseUnavailable
from wechat_db_intake import DbIntake, DbScope
from wechat_messages import VisibleMessage
from wechat_service import is_paused, set_paused, write_status
from wechat_state import WeChatState


ACCOUNT = 'fixture_bot'
OWNER = 'fixture_owner'
NATIVE = 'fixture_friend'
ALIAS = 'fixture_alias'
TITLE = 'Fixture friend'
ROSTER_ID = guest.reply_friend_id(ACCOUNT, NATIVE)
OWNER_FINGERPRINT = 'a' * 64
AVATAR = 'b' * 64


def cursors(conversation, at=5):
    return {f'message_0.db/{conversation}': {'generation': 'c' * 32, 'local_id': at}}


def response(conversation, *, at=5, rows=None):
    return {'ok': True, 'account_id': ACCOUNT, 'rows': [] if rows is None else rows,
            'has_more': False, 'cursors': cursors(conversation, at)}


class FriendBindingTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix='fixture-reply-friend-')
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name)
        self.database = self.runtime / 'state.sqlite'
        self.settings = {'account_name': 'Fixture companion', 'targets': {'private': {'title': 'Fixture owner'}},
                         'ocr': 'fixture', 'header': 'header'}
        self.owner = {'account': self.settings['account_name'], 'title': 'Fixture owner', 'fingerprint': OWNER_FINGERPRINT}
        (self.runtime / 'owner.json').write_text(json.dumps(self.owner))
        self.private = listener.private_binding_key(self.settings, self.owner)
        with WeChatState(self.database) as state:
            intake = DbIntake(state, ACCOUNT, OWNER_FINGERPRINT, (DbScope(self.private, 'private', OWNER),))
            intake.enroll()
            intake.apply(intake.request(), response(OWNER))
        self.contacts = sqlite3.connect(':memory:')
        self.contacts.row_factory = sqlite3.Row
        self.addCleanup(self.contacts.close)
        self.contacts.execute('CREATE TABLE contact (username,nick_name,remark,alias,local_type,flag,delete_flag,verify_flag)')
        self.contacts.executemany('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)', [
            (OWNER, 'Fixture owner', '', '', 1, 3, 0, 0), (ACCOUNT, 'Fixture companion', '', '', 1, 3, 0, 0),
            ('fixture_deleted', 'Fixture deleted', '', '', 1, 3, 1, 0),
            ('fixture_unconfirmed', 'Fixture stranger', '', '', 1, 1, 0, 0),
            ('gh_fixture', 'Fixture official', '', '', 1, 3, 0, 0),
            ('fixture_room@chatroom', 'Fixture room', '', '', 1, 3, 0, 0),
            (NATIVE, 'Fixture nickname', TITLE, ALIAS, 1, 3, 0, 0),
        ])
        self.identifier = ALIAS
        self.requests = []
        self.open_error = None
        self.avatar_ready = True
        self.baseline_at = 5

    def read(self, request):
        self.requests.append(request)
        self.assertEqual((request['account_id'], request['owner_id']), (ACCOUNT, OWNER))
        if request['op'] == 'friend_poll':
            self.assertTrue(request['baseline'])
            self.assertEqual(request['friend_id'], ROSTER_ID)
            return response(ROSTER_ID, at=self.baseline_at)
        try:
            return {'ok': True, 'account_id': ACCOUNT} | guest.respond_to_reply_friend(
                request, None, None, self.contacts, ACCOUNT, OWNER,
            )
        except guest.LocalDataError as error:
            raise DatabaseUnavailable(str(error)) from error

    def run_control(self, action='bind-reply-friend', *, friend_id=None, error=None):
        def open_target(settings, _path, target, *, search_only):
            self.assertEqual(settings['targets'][target]['title'], TITLE)
            self.assertTrue(search_only)
            self.assertTrue(is_paused(self.runtime))
            if self.open_error:
                raise ui.DiagnosticTestError('Fixture open failure', code=self.open_error)

        args = SimpleNamespace(action=action, roster_id=ROSTER_ID, friend=friend_id, state=self.database)
        output = io.StringIO()
        with (patch.object(ui, 'vm_operation', lambda **_: listener.nullcontext()),
              patch.object(ui, 'open_target', side_effect=open_target),
              patch.object(ui, 'capture_wechat'), patch.object(ui, 'points', return_value=[]),
              patch.object(ui, 'active_friend_avatars', return_value=(AVATAR,) if self.avatar_ready else ()),
              patch.object(ui, 'verify_title', return_value=self.avatar_ready),
              patch.object(ui, 'active_window_id', return_value=99),
              patch.object(listener, 'owner_profile', return_value=('b' * 64, self.identifier)),
              patch.object(friends, 'DatabaseReader', return_value=SimpleNamespace(read=self.read)),
              redirect_stdout(output)):
            if not error:
                listener.control_friend_binding(args, self.settings, self.runtime)
            else:
                with self.assertRaises(SystemExit) as raised:
                    listener.control_friend_binding(args, self.settings, self.runtime)
                self.assertEqual(raised.exception.code, 1)
        result = json.loads(output.getvalue())
        if error:
            self.assertEqual(result, {'error': error})
        return result

    def test_roster_and_registry_expose_only_opaque_id_and_display_title(self):
        write_status(self.runtime, 'running')
        self.assertEqual(self.run_control('reply-friend-roster'), {'friends': [{'id': ROSTER_ID, 'title': TITLE}]})
        friend = self.run_control()
        self.assertRegex(friend['id'], r'^[a-f0-9]{32}$')
        self.assertEqual(self.run_control('list-reply-friends'), {'friends': [friend]})
        self.assertEqual(self.run_control('reply-friend-roster'), {'friends': []})
        self.assertFalse(is_paused(self.runtime))
        registry = self.runtime / friends.FRIENDS_FILE
        self.assertEqual(registry.stat().st_mode & 0o777, 0o600)
        self.assertIn(ROSTER_ID, registry.read_text())
        self.assertNotIn(NATIVE, registry.read_text())
        self.assertNotIn(ALIAS, registry.read_text())

    def test_same_name_wrong_contact_card_and_absent_avatar_fail_closed(self):
        self.contacts.execute('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)',
                              ('fixture_other', 'FixtureFriend', '', '', 1, 3, 0, 0))
        self.run_control(error='friend_title_ambiguous')
        self.contacts.execute('DELETE FROM contact WHERE username=?', ('fixture_other',))
        self.identifier = 'fixture_other_alias'
        self.run_control(error='friend_conversation_mismatch')
        self.avatar_ready = False
        self.run_control(error='friend_unverified')
        self.assertFalse(is_paused(self.runtime))
        self.assertFalse(friends.enrolled_friends(self.settings, self.runtime))
        self.assertNotIn('friend_poll', [request['op'] for request in self.requests])

    def test_search_failure_keeps_manual_pause(self):
        set_paused(self.runtime, True)
        self.open_error = 'send_target_ambiguous'
        self.run_control(error='send_target_ambiguous')
        self.assertTrue(is_paused(self.runtime))

    def test_unbind_retires_identity_and_resolves_pending_or_attempted_without_replay(self):
        registered = self.run_control()
        friend = friends.enrolled_friends(self.settings, self.runtime)[registered['id']]
        binding = friends.friend_binding_key(self.settings, self.owner, friend)
        with WeChatState(self.database) as state:
            attempted, pending = self.enqueue(state, binding, 6, 7)
            self.assertTrue(state.prepare(attempted.id, 'Fixture reply'))
            self.assertTrue(state.mark_attempted(attempted.id))
        self.assertEqual(self.run_control('remove-reply-friend', friend_id=registered['id']), {'removed': True})
        self.baseline_at = 7
        readded = self.run_control()
        self.assertNotEqual(registered['id'], readded['id'])
        current = friends.enrolled_friends(self.settings, self.runtime)[readded['id']]
        with WeChatState(self.database, read_only=True) as state:
            self.assertTrue(DbIntake.pins(state)[binding].retired)
            self.assertFalse(state.pending(binding))
            self.assertFalse(state.uncertain(binding))
            old = dict(state.db.execute('SELECT id,status FROM wechat_occurrences WHERE binding=?', (binding,)))
            self.assertEqual(old, {attempted.id: 'skipped', pending.id: 'skipped'})
            current_binding = friends.friend_binding_key(self.settings, self.owner, current)
            self.assertFalse(state.pending(current_binding))
            self.assertEqual(state.database_cursor(current_binding)[1], cursors(ROSTER_ID, at=7))

    def enqueue(self, state, binding, *positions):
        intake = DbIntake(state, ACCOUNT, OWNER_FINGERPRINT, (
            DbScope(self.private, 'private', OWNER), DbScope(binding, 'friend', ROSTER_ID, display_name=TITLE),
        ))
        request = intake.request_friend(binding)
        rows = [{'conversation_id': ROSTER_ID, 'sender_id': ROSTER_ID, 'local_id': position, 'server_id': str(position),
                 'database': 'message_0.db', 'created_at': 100, 'type': 1, 'body': 'Fixture message',
                 'native_mention_self': False, 'mention_ids': []} for position in positions]
        intake.apply(request, response(ROSTER_ID, at=max(positions), rows=rows))
        return state.pending(binding)

    def test_normal_delivery_rechecks_pinned_avatar_at_click_boundary(self):
        registered = self.run_control()
        friend = friends.enrolled_friends(self.settings, self.runtime)[registered['id']]
        binding = friends.friend_binding_key(self.settings, self.owner, friend)
        attempted_clicks = []

        def run_test(_action, target, text, active, _path, *, before_send, **_hooks):
            self.assertEqual((target, active['targets'][target]['title']), ('private', TITLE))
            if before_send():
                attempted_clicks.append(text)

        with WeChatState(self.database) as state:
            event, = self.enqueue(state, binding, 6)
            state.prepare(event.id, 'Fixture reply', presentation={'friendRoute': None, 'localModel': 'fixture-local'})
            prepared, = state.pending(binding)
            with (patch.object(ui, 'vm_operation', lambda **_: listener.nullcontext()), patch.object(ui, 'open_target'),
                  patch.object(ui, 'active_window_id', return_value=99),
                  patch.object(ui, 'verify_title', side_effect=[True, False]),
                  patch.object(ui, 'run_test', side_effect=run_test),
                  patch('wechat_friend_replies.read_reply_settings', return_value={'model': 'fixture-local'}),
                  patch('wechat_friend_replies.read_cloud_route', return_value=None)):
                outcome = deliver_friend(state, self.settings, self.runtime / 'unused.png', self.runtime,
                                         friend, binding, prepared, lambda **_: None)
            self.assertEqual(outcome, 'friend_binding_invalid')
            self.assertEqual(state.pending(binding), (prepared,))
            self.assertEqual(state.uncertain(binding), ())
            self.assertEqual(attempted_clicks, [])

    def test_visual_receipt_completes_reply_without_database_post_check(self):
        self.check_delivery_receipt(visual=True)

    def test_missing_visual_and_database_receipt_remains_uncertain_without_replay(self):
        self.check_delivery_receipt(visual=False)

    def check_delivery_receipt(self, *, visual):
        registered = self.run_control()
        friend = friends.enrolled_friends(self.settings, self.runtime)[registered['id']]
        binding = friends.friend_binding_key(self.settings, self.owner, friend)
        settings = {**self.settings, 'draft': [20, 20, 10, 10], 'draft_click': [25, 25],
                    'send': [40, 40, 10, 10], 'send_click': [45, 45], 'chat': [0, 0, 1, 1]}
        text = 'Fixture reply'
        clicks, requests = [], []
        reply = VisibleMessage('outgoing', settings['account_name'], text, False, False, (76, 76, 70, 26))
        cursor = cursors(ROSTER_ID, at=6)
        scope = {'account_id': ACCOUNT, 'owner_id': OWNER, 'friend_id': ROSTER_ID}

        def read(request):
            requests.append(request)
            if request['op'] == 'send_baseline':
                self.assertEqual(clicks, [])
                self.assertEqual(request, {'op': 'send_baseline', **scope})
                return {'account_id': ACCOUNT, 'cursors': cursor, 'since': 99}
            self.assertEqual(clicks, ['click'])
            self.assertEqual(request, {'op': 'send_receipt', **scope, 'cursors': cursor, 'since': 99,
                                       'kind': 'text', 'text': text, 'quoted_server_id': None})
            raise DatabaseUnavailable('guest_unreachable')

        with WeChatState(self.database) as state:
            event, = self.enqueue(state, binding, 6)
            state.prepare(event.id, text, presentation={'friendRoute': None, 'localModel': 'fixture-local'})
            prepared, = state.pending(binding)
            with (patch.object(ui, 'vm_operation', lambda **_: listener.nullcontext()), patch.object(ui, 'open_target'),
                  patch.object(ui, 'verify_title', return_value=True), patch.object(ui, 'active_window_id', return_value=99),
                  patch.object(ui, 'sticker_editor_ready', return_value=True),
                  patch.object(ui, 'read_draft', return_value=text), patch.object(ui, 'points', return_value=[]),
                  patch.object(ui, 'click'), patch.object(ui, 'paste'), patch.object(ui, 'clear_clipboard'),
                  patch.object(ui.time, 'sleep'), patch.object(ui, 'click_send', side_effect=lambda *_: clicks.append('click')),
                  patch.object(ui, 'conversation_messages', side_effect=lambda *_: (reply,) if visual and clicks else ()),
                  patch.object(listener.DatabaseReader, 'read', side_effect=read),
                  patch('wechat_friend_replies.read_reply_settings', return_value={'model': 'fixture-local'}),
                  patch('wechat_friend_replies.read_cloud_route', return_value=None)):
                result = deliver_friend(state, settings, self.runtime / 'unused.png', self.runtime, friend, binding,
                                        prepared, lambda **_: None)
            self.assertEqual(clicks, ['click'])
            self.assertFalse(state.pending(binding))
            if visual:
                self.assertEqual(result, 'ready')
                self.assertEqual([item['op'] for item in requests], ['send_baseline'])
                self.assertFalse(state.uncertain(binding))
                self.assertEqual(state.history(binding)[-1], {'role': 'assistant', 'text': text})
            else:
                self.assertEqual(result, 'friend_send_uncertain')
                self.assertEqual([item['op'] for item in requests], ['send_baseline', 'send_receipt'])
                unresolved, = state.uncertain(binding)
                self.assertEqual(unresolved.id, event.id)
                self.assertEqual(unresolved.observation['receipt_proof']['database_request'], requests[1])

    def test_friend_controls_require_new_live_worker(self):
        status = self.runtime / 'status.json'
        status.write_text(json.dumps({'state': 'running', 'heartbeat_at': time.time(), 'pid': 100,
                                      'group_policy_version': 4, 'reply_target_binding_version': 1}))
        status.chmod(0o600)
        self.run_control(error='reply_targets_worker_upgrade_required')
        self.assertEqual(self.requests, [])
        self.assertFalse(is_paused(self.runtime))

    def test_actual_gui_check_rejects_wrong_avatar_or_window_under_same_title(self):
        config = {**self.settings, 'search_results': [0, 0, 300, 400]}
        name = {'text': TITLE, 'x': 55, 'y': 100, 'width': 120, 'height': 15}
        path = self.runtime / 'fixture.png'

        def frame(avatar):
            image = Image.new('RGB', (300, 400), (255, 255, 255))
            image.putpixel((2, 104), ui.SELECTED_CHAT)
            image.paste(avatar, (11, 99, 36, 138))
            image.save(path)

        frame((20, 50, 80))
        with (patch.object(ui, 'capture_wechat'), patch.object(ui, 'points', return_value=[name]),
              patch.object(ui, 'recognize', return_value=[name]), patch.object(ui, 'active_window_id', return_value=99)):
            selected = {**config, 'targets': {'private': {'title': TITLE}}}
            fingerprints = ui.active_friend_avatars(selected, path, [name])
            self.assertTrue(fingerprints)
            friend = friends.BoundFriend('a' * 32, ROSTER_ID, TITLE, fingerprints)
            active = friends.settings_for_friend(config, friend)
            self.assertEqual(friends.verify_friend(active, path), 99)
            with self.assertRaises(ui.TestError):
                friends.verify_friend(active, path, window=105)
            frame((80, 50, 20))
            with self.assertRaises(ui.TestError) as raised:
                friends.verify_friend(active, path)
            self.assertEqual(raised.exception.code, 'send_friend_binding_mismatch')


if __name__ == '__main__':
    unittest.main()
