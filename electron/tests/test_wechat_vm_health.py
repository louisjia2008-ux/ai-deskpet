"""VM health transport tests with a fake SSH process only."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_vm_health as health
import wechat_vm_health_guest as guest


class VmHealthTests(unittest.TestCase):
    def test_one_short_command_and_program_on_stdin(self):
        result = {'totalBytes': 100, 'freeBytes': 50, 'authLogBytes': 3, 'journalBytes': 4,
                  'uptimeSeconds': 5, 'wechatRunning': True}
        with patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(result).encode())) as run:
            self.assertEqual(health.vm_health(), result)
        run.assert_called_once()
        command = run.call_args.args[0][-1]
        self.assertEqual(command, 'ulimit -c 0 && sudo -n /usr/bin/python3 -I -B -')
        self.assertLess(len(command), 80)
        source = run.call_args.kwargs['input']
        self.assertIn(b'os.statvfs', source)
        self.assertNotIn('auth.log', command)
        self.assertNotIn('exec(', command)

    def test_fail_closed_for_unreachable_invalid_or_content_bearing_response(self):
        for code, raw in ((255, b''), (0, b'bad'), (0, b'{"text":"private"}'), (0, b'[]')):
            with self.subTest(code=code, raw=raw), patch.object(health.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, raw)):
                with self.assertRaises(ValueError):
                    health.vm_health()

    def test_guest_collects_only_numeric_metadata_and_boolean_process_state(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'auth').write_text('PRIVATE_LOG')
            journal = root / 'journal'
            journal.mkdir()
            (journal / 'sample').write_bytes(b'1234')
            (journal / 'link').symlink_to(root / 'auth')
            proc = root / 'proc'
            (proc / '1').mkdir(parents=True)
            (proc / '1' / 'comm').write_text('WeChat\n')
            (root / 'uptime').write_text('123.50 40.00\n')
            paths = {'/var/log/auth.log': root / 'auth', '/proc': proc, '/proc/uptime': root / 'uptime'}
            with (patch.object(guest, 'Path', side_effect=lambda name: paths.get(name, Path(name))),
                  patch.object(guest.os, 'statvfs', return_value=SimpleNamespace(f_blocks=100, f_bavail=50, f_frsize=4096)),
                  patch.object(guest.os, 'walk', return_value=[(str(journal), [], ['sample', 'link'])])):
                result = guest.collect()
            self.assertEqual(result, {'totalBytes': 409600, 'freeBytes': 204800, 'authLogBytes': 11,
                                      'journalBytes': 4, 'uptimeSeconds': 123, 'wechatRunning': True})
            self.assertTrue(all(type(value) in (int, bool) for value in result.values()))
            self.assertNotIn('PRIVATE_LOG', json.dumps(result))
