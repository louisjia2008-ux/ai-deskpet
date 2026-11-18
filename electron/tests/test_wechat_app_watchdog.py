from datetime import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

RUNTIME_CODE = Path(__file__).resolve().parents[1] / 'wechat-runtime'
sys.path.insert(0, str(RUNTIME_CODE))
from wechat_app_watchdog import AppWatchdog, outage_status
from wechat_state import WeChatState


class AppWatchdogTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.db_path = self.root / 'state.db'
        self.state = WeChatState(self.db_path)
        self.addCleanup(self.state.db.close)
        self.now = self.start = int(datetime(2026, 11, 18, 12).timestamp())
        self.mono = 0
        self.messages = []
        self.outcome = 'sent'
        self.watcher = self.reopen()

    def reopen(self):
        return AppWatchdog(self.state.db, self.root, self.send, clock=lambda: self.now, monotonic=lambda: self.mono)

    def send(self, identity, text, guard):
        if not guard():
            return 'retry'
        self.messages.append((identity, text))
        return self.outcome

    def beat(self, state='running'):
        path = self.root / 'app-heartbeat.json'
        path.write_text(json.dumps({'at': self.now, 'pid': 12, 'state': state}))
        path.chmod(0o600)

    def tick(self, paused=False):
        self.watcher.tick(paused=paused)

    def advance(self, seconds, paused=False):
        self.assertEqual(seconds % 60, 0)
        for _ in range(seconds // 60):
            self.now += 60
            self.mono += 60
            self.tick(paused)

    def test_normal_heartbeats_then_one_outage_and_one_recovery_across_restarts(self):
        self.beat()
        self.tick()
        self.advance(300)
        self.beat()
        self.advance(540)
        self.assertEqual(self.messages, [])
        self.advance(60)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('10 分钟', self.messages[0][1])
        self.watcher = self.reopen()
        self.tick()
        self.advance(600)
        self.assertEqual(len(self.messages), 1)
        self.beat()
        self.tick()
        self.watcher = self.reopen()
        self.advance(180)
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.messages[1][1], '【医生】桌宠恢复了。')
        self.assertEqual(outage_status(self.db_path), {'outage': {'startedAt': self.start + 300,
            'notifiedAt': self.start + 900, 'recoveredAt': self.start + 1500, 'recoveryNotifiedAt': self.start + 1500}})

    def test_sleep_wall_gap_resets_observation_even_if_monotonic_does_not_advance(self):
        self.beat()
        self.tick()
        self.advance(540)
        self.now += 3600
        self.tick()
        self.advance(540)
        self.assertEqual(self.messages, [])
        self.advance(60)
        self.assertEqual(len(self.messages), 1)

    def test_stopped_missing_and_paused_are_silent(self):
        self.tick()
        self.advance(600)
        self.assertEqual(self.messages, [])
        self.beat('stopped')
        self.advance(600)
        self.assertEqual(self.messages, [])
        self.beat()
        self.advance(1200, paused=True)
        self.assertEqual(outage_status(self.db_path), {'outage': None})
        self.tick()
        self.advance(540)
        self.assertEqual(self.messages, [])
        self.advance(60)
        self.assertEqual(len(self.messages), 1)

    def test_quiet_defers_a_still_open_outage_to_eight(self):
        self.now = int(datetime(2026, 11, 18, 7, 30).timestamp())
        self.beat()
        self.tick()
        self.advance(29 * 60)
        self.assertIsNone(outage_status(self.db_path)['outage']['notifiedAt'])
        self.assertEqual(self.messages, [])
        self.advance(60)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('30 分钟', self.messages[0][1])

    def test_no_alert_or_recovery_notice_when_already_recovered_at_eight(self):
        self.now = int(datetime(2026, 11, 18, 7, 30).timestamp())
        self.beat()
        self.tick()
        self.advance(29 * 60)
        self.beat()
        self.advance(60)
        self.assertEqual(self.messages, [])
        self.assertIsNotNone(outage_status(self.db_path)['outage']['recoveredAt'])

    def test_pre_send_failure_may_retry_but_uncertainty_is_never_repeated(self):
        self.outcome = 'busy'
        self.beat()
        self.tick()
        self.advance(600)
        self.outcome = 'uncertain'
        self.advance(60)
        self.watcher = self.reopen()
        self.tick()
        self.advance(660)
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.messages[0][0], self.messages[1][0])

    def test_command_reads_old_db_without_creating_runtime_or_migrating_tables(self):
        path = self.root / 'old.sqlite'
        db = sqlite3.connect(path)
        db.close()
        runtime = self.root / 'nonexistent-runtime'
        output = subprocess.check_output([sys.executable, '-B', str(RUNTIME_CODE / 'wechat_listener.py'),
            '--state', str(path), '--config', str(self.root / 'nonexistent-config'), '--runtime', str(runtime), 'app-outage-status'])
        self.assertEqual(json.loads(output), {'outage': None})
        self.assertEqual(path.stat().st_size, 0)
        self.assertFalse(runtime.exists())
