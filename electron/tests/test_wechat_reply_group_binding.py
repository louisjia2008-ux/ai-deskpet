"""Exercise roster-based reply enrollment with an isolated runtime and database."""

from contextlib import redirect_stdout
import fcntl
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))

import wechat_listener as listener
from wechat_db_guest import digest_group_id
from wechat_db_intake import DbIntake, DbScope
from wechat_group_policy import BoundGroup, read_group_registry, write_group_registry
from wechat_messages import VisibleMessage
from wechat_service import TEMPORARY_PAUSE_LOCK, is_paused, pause_for_target_binding, set_paused, write_status
from wechat_state import WeChatState


ACCOUNT = 'fixture_bot'
OWNER = 'fixture_owner'
ROOM = 'fixture_room@chatroom'
TITLE = 'Fixture reply room'
OWNER_FINGERPRINT = 'a' * 64
GROUP_FINGERPRINTS = tuple(f'{index:064x}' for index in range(15))
ROSTER_ID = digest_group_id(ACCOUNT, ROOM)


def cursors(conversation):
    return {f'message_0.db/{conversation}': {'generation': 'c' * 32, 'local_id': 5}}


class GroupBindingTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix='fixture-reply-group-')
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name)
        self.database = self.runtime / 'state.sqlite'
        self.settings = {'account_name': 'Fixture companion', 'targets': {'private': {'title': 'Fixture owner'}}}
        self.owner = {'account': self.settings['account_name'], 'title': 'Fixture owner', 'fingerprint': OWNER_FINGERPRINT}
        (self.runtime / 'owner.json').write_text(json.dumps(self.owner))
        self.private = listener.private_binding_key(self.settings, self.owner)
        self.roster = [{'id': ROSTER_ID, 'title': TITLE}]
        self.discovered = ROOM
        self.requests = []
        self.open_error = None
        self.opened_title = TITLE
        self.witnesses = ['Fixture first statement', 'Fixture second statement']
        with WeChatState(self.database) as state:
            intake = DbIntake(state, ACCOUNT, OWNER_FINGERPRINT, (DbScope(self.private, 'private', OWNER),))
            intake.enroll()
            intake.apply(intake.request(), self.baseline(OWNER))

    def baseline(self, conversation):
        return {'ok': True, 'account_id': ACCOUNT, 'rows': [], 'has_more': False, 'cursors': cursors(conversation)}

    def read(self, request):
        self.assertTrue(is_paused(self.runtime))
        self.requests.append(request)
        op = request['op']
        if op == 'digest_group_list':
            self.assertEqual(request, {'op': op, 'account_id': ACCOUNT, 'owner_id': OWNER, 'group_ids': []})
            return {'account_id': ACCOUNT, 'groups': self.roster}
        if op == 'discover':
            self.assertEqual(request, {'op': op, 'owner': {'id': OWNER}, 'groups': [{'title': TITLE}]})
            return {'account_id': ACCOUNT, 'owner': {'id': OWNER}, 'groups': [{'id': self.discovered}]}
        if op == 'attest':
            self.assertEqual(request, {'op': op, 'account_id': ACCOUNT, 'owner_id': OWNER,
                'group_ids': [ROOM], 'witnesses': [{'group_id': ROOM, 'bodies': list(reversed(self.witnesses))}]})
            return {'account_id': ACCOUNT, 'results': [{'group_id': ROOM, 'matched': True}]}
        self.assertTrue(request['baseline'])
        self.assertEqual(request['group_ids'], [ROOM])
        return {**self.baseline(ROOM), 'cursors': {**cursors(OWNER), **cursors(ROOM)}}

    def run_control(self, error=None):
        def open_target(settings, _path, target, *, search_only):
            self.assertTrue(search_only)
            self.assertEqual((settings['targets'][target]['title'], target), (TITLE, 'group'))
            self.assertTrue(is_paused(self.runtime))
            if self.open_error:
                raise listener.ui.TestError('Fixture failure', code=self.open_error)

        messages = tuple(VisibleMessage('incoming', 'Fixture sender', text, False, False, (0, 0, 20, 20))
                         for text in self.witnesses)
        args = SimpleNamespace(action='bind-reply-group', roster_id=ROSTER_ID, state=self.database)
        output = io.StringIO()
        with (patch.object(listener.ui, 'vm_operation', lambda **_: listener.nullcontext()),
              patch.object(listener.ui, 'open_target', side_effect=open_target),
              patch.object(listener, 'active_group', return_value=(self.opened_title, GROUP_FINGERPRINTS)),
              patch.object(listener, 'thread_snapshot', return_value=SimpleNamespace(messages=messages)),
              patch.object(listener, 'verify_group'),
              patch.object(listener.ui, 'copy_group_sticker_message', side_effect=lambda _cfg, _path, message: message.text),
              patch.object(listener, 'DatabaseReader', return_value=SimpleNamespace(read=self.read)),
              redirect_stdout(output)):
            if error is None:
                listener.control_group_binding(args, self.settings, self.runtime)
            else:
                with self.assertRaises(SystemExit) as raised:
                    listener.control_group_binding(args, self.settings, self.runtime)
                self.assertEqual(raised.exception.code, 1)
        result = json.loads(output.getvalue())
        if error is not None:
            self.assertEqual(result, {'error': error})
        return result

    def test_verified_group_starts_at_baseline_and_defaults_to_mentions(self):
        write_status(self.runtime, 'running')
        result = self.run_control()
        self.assertEqual([request['op'] for request in self.requests], ['digest_group_list', 'discover', 'attest', 'poll'])
        self.assertEqual(result['policy'], {'mode': 'mentions', 'sender': None})
        self.assertEqual(result['title'], TITLE)
        self.assertFalse(is_paused(self.runtime))
        _, groups = read_group_registry(self.runtime)
        group = groups[result['id']]
        self.assertEqual(group.fingerprints, GROUP_FINGERPRINTS)
        binding = listener.group_binding_key(self.settings, self.owner, group)
        with WeChatState(self.database, read_only=True) as state:
            self.assertEqual(DbIntake.pins(state)[binding].conversation_id, ROOM)
            self.assertEqual(state.database_cursor(binding), ('default', cursors(ROOM)))
            self.assertFalse(state.pending(binding))

    def test_preserves_original_manual_pause(self):
        set_paused(self.runtime, True)
        self.open_error = 'send_target_ambiguous'
        self.run_control('send_target_ambiguous')
        self.assertTrue(is_paused(self.runtime))

    def test_concurrent_pause_probes_do_not_report_a_binding_pause(self):
        lock = self.runtime / TEMPORARY_PAUSE_LOCK
        handle = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            # Another process may be inside is_paused at the same moment.
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            self.assertFalse(is_paused(self.runtime))
        finally:
            os.close(handle)
        with pause_for_target_binding(self.runtime):
            self.assertTrue(is_paused(self.runtime))
        self.assertFalse(is_paused(self.runtime))

    def test_same_name_and_search_or_open_failure_leave_no_binding_or_pause(self):
        self.roster.append({'id': digest_group_id(ACCOUNT, 'fixture_duplicate@chatroom'), 'title': TITLE})
        self.run_control('group_title_ambiguous')
        self.assertFalse(is_paused(self.runtime))
        self.roster.pop()
        self.open_error = 'send_target_ambiguous'
        self.run_control('send_target_ambiguous')
        self.assertFalse(is_paused(self.runtime))
        self.open_error = None
        self.opened_title = 'Different fixture room'
        self.run_control('title_mismatch')
        self.assertFalse(is_paused(self.runtime))
        self.assertFalse(read_group_registry(self.runtime)[1])
        self.assertEqual({request['op'] for request in self.requests}, {'digest_group_list'})

    def test_discovery_mismatch_stops_before_attestation_or_baseline(self):
        self.discovered = 'different_room@chatroom'
        self.run_control('group_conversation_mismatch')
        self.assertFalse(is_paused(self.runtime))
        self.assertEqual([request['op'] for request in self.requests], ['digest_group_list', 'discover'])
        self.assertFalse(read_group_registry(self.runtime)[1])

    def test_requires_message_evidence_after_a_correct_discovery(self):
        self.witnesses = []
        self.run_control('group_unverified')
        self.assertFalse(is_paused(self.runtime))
        self.assertEqual([request['op'] for request in self.requests], ['digest_group_list', 'discover'])

    def test_rejects_thirteenth_group_before_reading_roster(self):
        groups = {f'{index:032x}': BoundGroup(f'{index:032x}', f'Fixture room {index}', GROUP_FINGERPRINTS)
                  for index in range(12)}
        write_group_registry(self.runtime, True, groups)
        self.run_control('group_limit')
        self.assertEqual(self.requests, [])
        self.assertFalse(is_paused(self.runtime))

    def test_previous_live_worker_is_refused_before_reading_roster(self):
        status = self.runtime / 'status.json'
        status.write_text(json.dumps({'state': 'running', 'heartbeat_at': time.time(), 'pid': 100,
                                      'group_policy_version': 4}))
        status.chmod(0o600)
        self.run_control('reply_targets_worker_upgrade_required')
        self.assertEqual(self.requests, [])
        self.assertFalse(is_paused(self.runtime))

    def test_search_only_refuses_two_native_results_even_when_title_is_open(self):
        def line(text, y):
            return {'text': text, 'x': 55, 'y': y, 'width': 100, 'height': 15}

        settings = {'targets': {'group': {'title': TITLE}}, 'ocr': 'fixture', 'search': [0, 0, 100, 100],
                    'search_click': [50, 50], 'search_results': [0, 0, 300, 400]}
        rows = [line('群聊', 80), line(TITLE, 120), line(TITLE, 160), line('聊天记录', 200), line(TITLE, 250)]
        with (patch.object(listener.ui, 'capture_wechat'), patch.object(listener.ui, 'active_window_id', return_value=99),
              patch.object(listener.ui, 'points', return_value=rows), patch.object(listener.ui, 'verify_title', return_value=True),
              patch.object(listener.ui, 'paste'), patch.object(listener.ui, 'clear_clipboard'),
              patch.object(listener.ui, 'click') as click, patch.object(listener.ui, 'guest') as guest,
              patch.object(listener.time, 'sleep')):
            with self.assertRaises(listener.ui.TestError) as raised:
                listener.ui.open_target(settings, self.runtime / 'unused.png', 'group', search_only=True)
        self.assertEqual(raised.exception.code, 'send_target_ambiguous')
        click.assert_called_once_with(50, 50)
        guest.assert_called_once_with('xdotool key --clearmodifiers Escape')


if __name__ == '__main__':
    unittest.main()
