"""Installer safety helpers against disposable fixtures; no real app/listener calls."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts' / 'daily-install'
sys.path.insert(0, str(SCRIPTS))


class DailyInstallTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory(prefix='deskpet-install-fixture-')
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.old_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.old_umask)
        self.stages = self.root / 'stages'; self.stages.mkdir(mode=0o700)
        self.stage = self.stages / 'fixture'; self.stage.mkdir(mode=0o700)
        self.backups = self.root / 'backups'; self.backups.mkdir(mode=0o700)
        self.checkpoint = self.backups / 'install-20261115-fixture'
        self.worker = self.root / 'worker'; self.worker.mkdir(mode=0o700)
        self.wechat = self.root / 'wechat'; self.wechat.mkdir(mode=0o700)
        self.runtime = self.wechat / 'listener'; self.runtime.mkdir(mode=0o700)
        self.config = {'stageRoot': str(self.stages), 'backupRoot': str(self.backups), 'workerDir': str(self.worker),
                       'wechatRoot': str(self.wechat), 'installedApp': str(self.root / 'DeskPet Electron.app'),
                       'profileRoot': str(self.root / 'profile'), 'launchAgent': str(self.root / 'agent.plist'),
                       'launchAgentLabel': 'test.deskpet.fixture', 'python': sys.executable}
        self.write(self.stage / 'install-config.json', self.config)
        self.write(self.stage / 'install-context.json', {'stage': str(self.stage), 'checkpoint': str(self.checkpoint)})
        environment = patch.dict(os.environ, {'DESKPET_INSTALL_STAGE': str(self.stage)})
        environment.start(); self.addCleanup(environment.stop)

    def write(self, file, value):
        file.write_text(json.dumps(value)); file.chmod(0o600)

    def module(self, name):
        spec = importlib.util.spec_from_file_location('fixture_' + name, SCRIPTS / (name + '.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module

    def test_pause_and_resume_preserve_a_preexisting_owner_pause(self):
        module = self.module('update-worker')
        with patch.object(sys, 'argv', ['fixture', 'pause']), patch.object(module, 'cli', return_value={'paused': True, 'pid': 101}) as cli, \
                patch.object(module, 'wait_for_pause', return_value={'pid': 101}):
            module.main(); self.assertEqual(cli.call_args_list[0].args, ('status',)); self.assertEqual(cli.call_count, 1)
        self.assertEqual((module.PAUSE_RECORD.stat().st_mode & 0o777), 0o600)
        with patch.object(sys, 'argv', ['fixture', 'resume']), patch.object(module, 'cli') as cli, patch.object(module, 'wait_for_pause'):
            module.main(); cli.assert_not_called()
        self.write(module.PAUSE_RECORD, {'paused': False, 'pid': 101})
        with patch.object(sys, 'argv', ['fixture', 'resume']), patch.object(module, 'cli') as cli, patch.object(module, 'wait_for_pause'):
            module.main(); cli.assert_called_once_with('resume')

    def test_backup_checks_integrity_and_swap_failure_restores_only_code(self):
        module = self.module('update-worker')
        self.write(self.wechat / 'targets.json', {'fixture': True})
        self.write(self.runtime / 'owner.json', {'syntheticBinding': True})
        Path(self.config['launchAgent']).write_text('synthetic launchd plist')
        database = self.wechat / 'listener.db'
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('CREATE TABLE cursor(value TEXT)'); db.execute("INSERT INTO cursor VALUES ('must-not-reset')")
        database.chmod(0o600)
        old = self.worker / 'wechat_listener.py'; old.write_text('old fixture code')
        source = self.root / 'sealed'; source.mkdir(mode=0o700)
        (source / old.name).write_text('new fixture code'); (source / 'reply_policy.cjs').write_text('new helper')
        expected = {file.name: module.sha(file) for file in source.iterdir()}
        status = {'pid': 101, 'group_policy_version': 1}
        with patch.object(module, 'wait_for_pause', return_value=status):
            manifest = module.backup_state(expected)
        with closing(sqlite3.connect(module.PREINSTALL_BACKUP / 'listener.db')) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone(), ('ok',))
        self.checkpoint.mkdir(mode=0o700)
        with patch.object(module, 'expected_resources', return_value=(source, expected)), patch.object(module, 'restart') as restart, \
                patch.object(module, 'wait_for_pause', side_effect=[status, {'pid': 102, 'group_policy_version': 2}, status]):
            with self.assertRaisesRegex(RuntimeError, 'protocol changed'):
                module.swap_code()
            self.assertEqual(restart.call_count, 2)
        self.assertEqual(old.read_text(), 'old fixture code')
        self.assertFalse((self.worker / 'reply_policy.cjs').exists())
        self.assertEqual(module.sha(module.BACKUP / 'listener.db'), manifest['databaseSHA256'])
        with closing(sqlite3.connect(database)) as db:
            self.assertEqual(db.execute('SELECT value FROM cursor').fetchone(), ('must-not-reset',))

    def test_swap_checks_and_copies_the_sealed_reply_policy_with_its_entrypoint(self):
        module = self.module('update-worker')
        resources = module.APP / 'Contents/Resources'
        source = resources / 'wechat-runtime'; source.mkdir(parents=True)
        asar = resources / 'app.asar'; asar.write_bytes(b'candidate')
        actual_source = SCRIPTS.parents[1] / 'wechat-runtime'
        for name in module.REQUIRED:
            (source / name).write_bytes((actual_source / name).read_bytes())
        expected = {file.name: module.sha(file) for file in source.iterdir()}
        identity = {'asarSHA256': module.sha(asar), 'wechatRuntime': expected}
        self.write(self.stage / 'package-identity.json', identity)
        self.write(self.wechat / 'targets.json', {'fixture': True})
        Path(self.config['launchAgent']).write_text('synthetic launchd plist')
        with closing(sqlite3.connect(self.wechat / 'listener.db')) as db, db:
            db.execute('CREATE TABLE cursor(value TEXT)')
        self.checkpoint.mkdir(mode=0o700)
        paused = {'pid': 101, 'group_policy_version': 1}
        restarted = {'pid': 102, 'group_policy_version': 1}
        with patch.object(module.subprocess, 'run'), patch.object(module, 'restart') as restart, \
                patch.object(module, 'wait_for_pause', side_effect=[paused, paused, paused, restarted]):
            module.backup_state(expected)
            module.swap_code()
            restart.assert_called_once_with()
        for name in ('deskpet_reply.cjs', 'reply_policy.cjs'):
            self.assertEqual(module.sha(self.worker / name), expected[name])

        identity['wechatRuntime'] = {name: value for name, value in expected.items() if name != 'reply_policy.cjs'}
        self.write(self.stage / 'package-identity.json', identity)
        with patch.object(module.subprocess, 'run'), self.assertRaisesRegex(RuntimeError, 'missing required listener modules'):
            module.expected_resources()

    def test_pruning_keeps_current_and_two_newest_other_checkpoints_and_ignores_links(self):
        module = self.module('prune-checkpoints')
        checkpoints = []
        for n in range(5):
            directory = self.backups / f'install-20261115-fixture-{n}'
            directory.mkdir(mode=0o700); os.utime(directory, (100 + n, 100 + n)); checkpoints.append(directory)
        unrelated = self.backups / 'unrelated'; unrelated.mkdir()
        link = self.backups / 'install-20261115-link'; link.symlink_to(unrelated, target_is_directory=True)
        with patch.object(sys, 'argv', ['fixture', str(checkpoints[0])]):
            module.main()
        self.assertEqual([path.exists() for path in checkpoints], [True, False, False, True, True])
        self.assertTrue(unrelated.exists()); self.assertTrue(link.is_symlink())


if __name__ == '__main__':
    unittest.main()
