"""Synthetic self-tests: no VM, live account, or running listener is accessed."""
from contextlib import ExitStack, nullcontext
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_self_test as probe
import wechat_listener as listener
from wechat_db_channel import DatabaseUnavailable
from wechat_db_intake import DbIntake, DbScope
from wechat_state import WeChatState


class SelfTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.db = self.root / 'fixture.db'
        self.settings = {'account_name': 'fixture', 'targets': {'private': {'title': 'Owner'}}}
        self.owner = {'account': 'fixture', 'title': 'Owner', 'fingerprint': 'a' * 64}
        path = self.root / 'owner.json'
        path.write_text(json.dumps(self.owner))
        path.chmod(0o600)
        self.binding = listener.private_binding_key(self.settings, self.owner)
        with WeChatState(self.db) as state:
            DbIntake(state, 'fixture_bot', self.owner['fingerprint'], (DbScope(self.binding, 'private', 'fixture_owner'),)).enroll()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        def mock(target, name, **kw):
            return self.stack.enter_context(patch.object(target, name, **kw))
        self.lock = mock(probe.ui, 'vm_operation', side_effect=lambda **kw: nullcontext())
        self.open = mock(probe.ui, 'open_target')
        self.title = mock(probe.ui, 'verify_title', return_value=True)
        self.owner_check = mock(listener, 'verify_owner')
        self.config = mock(probe.ui, 'config', return_value=self.settings)
        mock(probe.ui, 'realign_wechat')
        mock(probe.ui, 'refocus_wechat')
        self.paused = mock(probe, 'is_paused', return_value=False)
        self.priority = Mock()
        mock(listener, 'owner_priority_check', return_value=self.priority)
        self.reader = Mock()
        self.activity_at = 1
        self.activity_error = None
        self.database_read = Mock(return_value={'account_id': 'fixture_bot', 'cursors': {'fixture': {}}, 'since': 1, 'status': 'confirmed'})
        def read(request, **kwargs):
            if request['op'] == 'owner_activity':
                if self.activity_error:
                    raise self.activity_error
                return {'ok': True, 'at': self.activity_at}
            return self.database_read(request, **kwargs)
        self.reader.read.side_effect = read
        mock(probe, 'DatabaseReader', return_value=self.reader)
        self.clicks = 0
        self.before_click = lambda: None

        def send(*args, before_send, database_receipt, send_progress, require_database_receipt):
            self.assertTrue(require_database_receipt)
            confirm = database_receipt(args[2], kind='text')
            send_progress('paste', True)
            self.before_click()
            if not before_send():
                raise probe.ui.TestError('fixture')
            send_progress('click', True)
            self.clicks += 1
            send_progress('ocrReceipt', True)
            if not confirm():
                raise probe.ui.AttemptUncertain('fixture')
        self.send = mock(probe.ui, 'run_test', side_effect=send)
        self.request = {'id': 'e' * 64, 'text': '[fixture #1]'}

    def run_probe(self):
        return probe.self_test(self.settings, self.root, self.db, self.request)

    def test_success_requires_database_and_replay_never_clicks_twice(self):
        first = self.run_probe()
        self.assertEqual(first['status'], 'passed')
        self.assertTrue(first['stages']['dbReceipt'])
        self.assertEqual(self.run_probe()['status'], 'passed')
        self.assertEqual(self.clicks, 1)
        self.lock.assert_called_with(wait=60)
        self.assertEqual(self.settings['targets']['private']['title'], 'Owner')
        self.assertEqual(self.open.call_args.args[0], self.settings)  # restored
        self.assertEqual(self.reader.read.call_args.args[0]['conversation'], 'fixture_owner')
        self.owner_check.assert_called()
        self.assertNotIn('fixture_owner', json.dumps(first))

    def test_title_mismatch_and_ambiguous_search_never_paste_or_click(self):
        self.title.return_value = False
        self.assertEqual(self.run_probe()['code'], 'self_test_target')
        self.send.assert_not_called()
        self.title.return_value = True
        self.open.side_effect = probe.ui.TestError('fixture', code='send_target_ambiguous')
        self.assertEqual(self.run_probe()['code'], 'self_test_target')
        self.assertEqual(self.clicks, 0)

    def test_owner_card_mismatch_never_pastes_or_clicks(self):
        self.owner_check.side_effect = probe.ui.DiagnosticTestError('fixture', code='send_owner_binding_mismatch')
        result = self.run_probe()
        self.assertEqual((result['status'], result['code']), ('failed', 'self_test_target'))
        self.send.assert_not_called()

    def test_owner_drawer_failure_exposes_only_the_allowlisted_reason(self):
        self.owner_check.side_effect = probe.ui.DiagnosticTestError('hidden fixture text', code='drawer_state_unknown')
        result = self.run_probe()
        self.assertEqual(result['preflightReason'], 'drawer_state_unknown')
        self.assertEqual((result['status'], result['code']), ('failed', 'self_test_send'))
        self.assertNotIn('hidden fixture text', json.dumps(result))
        self.send.assert_not_called()

        self.owner_check.side_effect = probe.ui.DiagnosticTestError('fixture', code='unknown_reason')
        self.assertNotIn('preflightReason', self.run_probe())

    def test_lock_paused_and_real_message_yield(self):
        self.lock.side_effect = probe.ui.OperationBusy('fixture')
        self.assertEqual(self.run_probe()['status'], 'busy')
        self.lock.side_effect = lambda **kw: nullcontext()
        self.paused.return_value = True
        self.assertEqual(self.run_probe()['status'], 'paused')
        self.paused.return_value = False
        self.priority.side_effect = listener.ReplyYielded()
        self.assertEqual(self.run_probe()['status'], 'skipped')
        self.assertEqual(self.clicks, 0)

    def test_baseline_failure_stops_before_paste(self):
        self.database_read.side_effect = DatabaseUnavailable('guest_unreachable')
        result = self.run_probe()
        self.assertEqual((result['status'], result['code']), ('failed', 'self_test_db_unavailable'))
        self.assertFalse(result['stages']['paste'])
        self.assertEqual(self.clicks, 0)

    def test_database_timeout_even_with_ocr_is_uncertain_and_not_repeated(self):
        self.database_read.side_effect = [self.database_read.return_value] + [{'status': 'pending'}] * 5
        with patch.object(probe.time, 'monotonic', side_effect=iter(range(0, 1000, 5))), patch.object(probe.time, 'sleep'):
            result = self.run_probe()
        self.assertEqual((result['status'], result['code']), ('uncertain', 'self_test_db_unconfirmed'))
        self.assertEqual(self.run_probe()['status'], 'uncertain')
        self.assertEqual(self.clicks, 1)

    def test_settings_change_or_owner_activity_at_click_prevents_send(self):
        self.before_click = lambda: setattr(self.config, 'return_value', {**self.settings, 'changed': True})
        self.assertEqual(self.run_probe()['code'], 'self_test_settings_changed')
        self.assertEqual(self.clicks, 0)
        self.config.return_value = self.settings
        self.before_click = lambda: setattr(self.priority, 'side_effect', listener.ReplyYielded())
        self.assertEqual(self.run_probe()['status'], 'skipped')
        self.assertEqual(self.clicks, 0)

    def test_attempted_ledger_is_never_reclicked_and_payload_is_bounded(self):
        from hashlib import sha256
        with WeChatState(self.db) as state:
            probe.SelfTestLedger(state.db).begin(self.request['id'], sha256(self.request['text'].encode()).hexdigest())
        self.assertEqual(self.run_probe()['status'], 'uncertain')
        self.assertEqual(self.clicks, 0)
        for change in ({'id': 'bad'}, {'text': '\n'}, {'target': 'someone'}):
            with self.assertRaises(ValueError):
                probe.parse_request(json.dumps({**self.request, **change}))

    def completed_occurrence(self):
        with WeChatState(self.db) as state:
            state.db.execute('INSERT INTO wechat_occurrences VALUES (?,?,?,?,?,NULL)',
                             ('f' * 64, self.binding, 1, None, 'sent'))
            state.db.commit()

    def test_recent_native_activity_yields_with_null_completed_observation(self):
        self.completed_occurrence()
        self.activity_at = 701
        with patch.object(probe.time, 'time', return_value=1000):
            self.assertEqual(self.run_probe()['status'], 'skipped')
        self.send.assert_not_called()
        self.assertEqual(self.clicks, 0)
        self.reader.read.assert_called_once_with({'op': 'owner_activity', 'account_id': 'fixture_bot', 'owner_id': 'fixture_owner'})

    def test_old_native_activity_allows_send_with_null_completed_observation(self):
        self.completed_occurrence()
        self.activity_at = 699
        with patch.object(probe.time, 'time', return_value=1000):
            self.assertEqual(self.run_probe()['status'], 'passed')
        self.assertEqual(self.clicks, 1)
        self.assertEqual(sum(call.args[0]['op'] == 'owner_activity' for call in self.reader.read.call_args_list), 2)

    def test_unavailable_or_unknown_native_activity_yields(self):
        self.completed_occurrence()
        for at in (None, '701', True, 0, -1):
            with self.subTest(at=at):
                self.activity_at = at
                self.assertEqual(self.run_probe()['status'], 'skipped')
        self.activity_error = DatabaseUnavailable('guest_unreachable')
        self.assertEqual(self.run_probe()['status'], 'skipped')
        self.send.assert_not_called()
        self.assertEqual(self.clicks, 0)

    def test_new_native_activity_at_click_or_uncertain_queue_yields(self):
        self.completed_occurrence()
        self.before_click = lambda: setattr(self, 'activity_at', 1000)
        with patch.object(probe.time, 'time', return_value=1000):
            self.assertEqual(self.run_probe()['status'], 'skipped')
        self.assertEqual(self.clicks, 0)
        with WeChatState(self.db) as state:
            state.db.execute("UPDATE wechat_occurrences SET status='uncertain'")
            state.db.commit()
        self.reader.read.reset_mock()
        self.assertEqual(self.run_probe()['status'], 'skipped')
        self.reader.read.assert_not_called()
