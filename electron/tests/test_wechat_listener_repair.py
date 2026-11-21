"""Run the listener restart control on temporary owner-only status files."""
from pathlib import Path
import json
import os
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_service as service


class WeChatListenerRepairTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = Path(self.tmp.name)
        self.kick = self.enterContext(patch.object(service.subprocess, 'run', side_effect=self.publish_heartbeat))

    def publish_heartbeat(self, *args, **kwargs):
        self.write_status('running', time.time(), 102)

    def write_status(self, state, heartbeat_at, pid):
        service._replace_private(self.runtime / service.STATUS_FILE,
                                 json.dumps({'state': state, 'pid': pid, 'heartbeat_at': heartbeat_at}).encode(),
                                 durable=True)

    def test_stopped_and_stale_listeners_get_a_new_heartbeat(self):
        for state, last_seen in [('stopped', time.time()), ('running', time.time() - 220), ('degraded', time.time())]:
            with self.subTest(state=state, last_seen=last_seen):
                self.write_status(state, last_seen, 101)
                self.kick.reset_mock()
                started = service.restart_listener(self.runtime)
                self.assertEqual(started['pid'], 101)
                self.assertTrue(started['started'])
                self.assertEqual(self.kick.call_args.args[0], [
                    '/bin/launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/local.deskpet.wechat-listener'])
                self.kick.assert_called_once()
                current = service.read_status(self.runtime)
                self.assertEqual(current['state'], 'running')
                self.assertEqual(current['pid'], 102)
                self.assertGreaterEqual(current['heartbeat_at'], started['after'])
                self.assertEqual(service.restart_listener(self.runtime), {'started': False})
                self.kick.assert_called_once()

    def test_user_pause_target_binding_and_install_lock_block_restart(self):
        self.write_status('stopped', time.time(), 101)
        service.set_paused(self.runtime, True)
        self.assertEqual(service.restart_listener(self.runtime), {'started': False})
        service.set_paused(self.runtime, False)
        with service.pause_for_target_binding(self.runtime):
            self.assertEqual(service.restart_listener(self.runtime), {'started': False})
        with service.repair_install_lock(self.runtime):
            self.assertEqual(service.restart_listener(self.runtime), {'started': False})
        self.kick.assert_not_called()
