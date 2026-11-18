"""Disposable repositories, app resources, service controls and databases for worker updates."""

from contextlib import closing
import copy
import importlib.util
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/daily-install/update-worker-only.py'
spec = importlib.util.spec_from_file_location('worker_only', SCRIPT)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class FixtureListener(updater.Listener):
    def __init__(self, config, failure=None):
        super().__init__(config)
        self.actions = []
        self.pid = 41
        self.failure = failure
        self.started = 0

    def heartbeat(self, *, paused, after, same_pid=None, new_from=None, protocol=None, timeout=55):
        self.actions.append(('heartbeat', paused, self.pid))
        if self.failure == 'resume' and not paused and self.started == 1:
            # Emulate a cursor admitted before an unhealthy candidate was noticed.
            with closing(sqlite3.connect(self.database)) as db, db:
                db.execute("INSERT INTO cursor VALUES ('new')")
            raise updater.UpdateError('mock-resume-failure')
        assert self.paused() == paused and self.pid is not None
        assert (same_pid is None or same_pid == self.pid) and new_from != self.pid
        assert protocol in (None, 4)
        return {'heartbeat_at': max(after, time.time()) + 0.01, 'pid': self.pid, 'group_policy_version': 4}

    def stop(self):
        assert self.paused()
        self.actions.append(('stop', self.pid))
        self.pid = None

    def start(self, agent_digest):
        assert self.paused() and self.pid is None
        self.started += 1
        self.actions.append(('start', self.started))
        if self.failure == 'start' and self.started == 1:
            raise updater.UpdateError('mock-start-failure')
        self.pid = 41 + self.started
        if self.failure == 'pause-change' and self.started == 1:
            self.pause(False)
            self.pause(True)


class WorkerOnlyTest(unittest.TestCase):
    def setUp(self):
        fixture = TemporaryDirectory(prefix='worker-only-test-')
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name).resolve()
        self.addCleanup(os.umask, os.umask(0o077))
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.project = self.repo / 'electron'
        self.project.mkdir()
        self.git('init', '-q')
        self.put(self.repo / '.gitignore', b'ignored.ts\n')
        self.put(self.project / 'src/nested/source.ts', b'app source')
        for name in updater.BUILD_FILES:
            self.put(self.project / name, name.encode())
        for name in updater.IDENTITY_HELPERS:
            self.put(self.project / name, name.encode())
        self.runtime_source = self.project / 'wechat-runtime'
        self.app = self.root / 'DeskPet Electron.app'
        self.sealed = self.app / 'Contents/Resources/wechat-runtime'
        self.worker = self.root / 'worker'
        self.wechat = self.root / 'wechat'
        self.runtime = self.wechat / 'listener'
        self.backups = self.root / 'backups'
        self.backups.mkdir()
        self.asar = self.app / 'Contents/Resources/app.asar'
        self.put(self.asar, b'verified asar fixture')
        self.agent = self.root / 'listener.plist'
        self.put(self.agent, plistlib.dumps({
            'Label': 'test.fixture', 'WorkingDirectory': str(self.worker), 'RunAtLoad': True,
            'ProgramArguments': [sys.executable, str(self.worker / 'wechat_listener.py'),
                                 '--config', str(self.wechat / 'targets.json'), '--state',
                                 str(self.wechat / 'listener.db'), '--runtime', str(self.runtime), 'run'],
        }))
        self.put(self.runtime / 'listener.lock', b'')
        for path in (self.runtime_source, self.worker, self.sealed):
            self.put(path / 'wechat_listener.py', b'old code')
            self.put(path / 'reply_policy.cjs', b'unchanged')
        with closing(sqlite3.connect(self.wechat / 'listener.db')) as db, db:
            db.execute('CREATE TABLE cursor(value TEXT)')
            db.execute("INSERT INTO cursor VALUES ('old')")
        self.baseline = self.commit()
        self.config = {'installedApp': str(self.app), 'workerDir': str(self.worker),
                       'wechatRoot': str(self.wechat), 'backupRoot': str(self.backups), 'launchAgent': str(self.agent),
                       'launchAgentLabel': 'test.fixture', 'python': sys.executable}
        self.identity = {'config': self.config, 'asar': updater.file_digest(self.asar),
                         'source': updater.source_digest(updater.disk_sources(self.project))}

    def put(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-C', str(self.repo), *args], stderr=subprocess.PIPE)

    def commit(self):
        self.git('add', '--', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture')
        return self.git('rev-parse', 'HEAD').decode('ascii').strip()

    def candidate(self):
        self.put(self.runtime_source / 'wechat_listener.py', b'new code')
        self.put(self.runtime_source / 'wechat_new.py', b'new module')
        self.commit()

    def plan(self):
        return updater.make_plan(self.project, self.identity, self.baseline)

    def test_hash_covers_exact_candidate_baseline_and_app(self):
        self.candidate()
        plan, contents = self.plan()
        self.assertEqual(plan['changed'], ['wechat_listener.py', 'wechat_new.py'])
        self.assertEqual(plan['worker']['wechat_listener.py'], updater.digest(contents['wechat_listener.py']))
        self.assertEqual(self.plan()[0]['workerSHA256'], plan['workerSHA256'])
        self.identity['asar'] = 'a' * 64
        self.assertNotEqual(self.plan()[0]['workerSHA256'], plan['workerSHA256'])

    def test_changes_besides_committed_python_are_refused(self):
        self.candidate()
        source = self.project / 'src/nested/source.ts'
        old = source.read_bytes()
        self.put(source, b'unstaged')
        with self.assertRaisesRegex(updater.UpdateError, 'worktree-has-unreviewed-changes'):
            self.plan()
        self.git('add', '--', 'electron/src')
        with self.assertRaisesRegex(updater.UpdateError, 'worktree-has-unreviewed-changes'):
            self.plan()
        self.git('reset', '-q', 'HEAD', '--', 'electron/src')
        self.put(source, old)
        self.put(self.project / 'src/untracked.ts', b'untracked')
        with self.assertRaisesRegex(updater.UpdateError, 'worktree-has-unreviewed-changes'):
            self.plan()
        (self.project / 'src/untracked.ts').unlink()
        self.put(self.project / 'src/ignored.ts', b'ignored')
        with self.assertRaisesRegex(updater.UpdateError, 'unreviewed-app-source-on-disk'):
            self.plan()
        (self.project / 'src/ignored.ts').unlink()
        self.put(source, b'committed app change')
        self.commit()
        with self.assertRaisesRegex(updater.UpdateError, 'candidate-is-not-python-worker-only'):
            self.plan()

    def test_sealed_app_and_live_worker_need_same_baseline(self):
        self.candidate()
        identity = copy.deepcopy(self.identity)
        self.identity['source'] = 'a' * 64
        with self.assertRaisesRegex(updater.UpdateError, 'installed-app-source-mismatch'):
            self.plan()
        self.identity = identity
        self.put(self.sealed / 'reply_policy.cjs', b'sealed resource differs')
        with self.assertRaisesRegex(updater.UpdateError, 'installed-worker-resources-mismatch'):
            self.plan()
        self.put(self.sealed / 'reply_policy.cjs', b'unchanged')
        self.put(self.worker / 'wechat_listener.py', b'previous patch')
        with self.assertRaisesRegex(updater.UpdateError, 'live-worker-is-not-sealed-baseline'):
            self.plan()

    def test_identity_helpers_are_attested_before_they_can_run(self):
        self.candidate()
        helper = updater.IDENTITY_HELPERS[0]
        self.git('update-index', '--assume-unchanged', 'electron/' + helper)
        self.put(self.project / helper, b'unreviewed runtime code')
        with patch.object(updater, 'installed_identity') as inspect:
            with self.assertRaisesRegex(updater.UpdateError, 'unreviewed-identity-helper-on-disk'):
                updater.prepare_plan(self.project, self.root / 'fixture.json', self.baseline)
            inspect.assert_not_called()

    def test_schema_module_and_new_migration_are_refused(self):
        self.candidate()
        new_module = self.runtime_source / 'wechat_new.py'
        self.put(new_module, b'sql = "CREATE TABLE new_schema(id int)"')
        self.commit()
        with self.assertRaisesRegex(updater.UpdateError, 'database-schema-review-requires-daily-install'):
            self.plan()
        self.put(new_module, b'new module')
        self.put(self.runtime_source / 'wechat_state.py', b'changed a schema module')
        self.commit()
        with self.assertRaisesRegex(updater.UpdateError, 'database-schema-review-requires-daily-install'):
            self.plan()

    def test_bad_approval_performs_no_operations(self):
        self.candidate()
        plan, contents = self.plan()
        listener = FixtureListener(self.config)
        with self.assertRaisesRegex(updater.UpdateError, 'worker-update-not-approved'):
            updater.apply_update(listener, plan, contents, 'f' * 64)
        self.assertEqual(listener.actions, [])
        self.assertEqual(list(self.backups.iterdir()), [])
        self.assertFalse(listener.paused())

    def test_update_keeps_owner_pause_and_other_resources(self):
        self.candidate()
        plan, contents = self.plan()
        listener = FixtureListener(self.config)
        listener.pause(True)
        pycache = self.worker / '__pycache__'
        self.put(pycache / 'wechat_listener.cpython-314.pyc', b'stale changed module')
        self.put(pycache / 'unrelated.cpython-314.pyc', b'unrelated')
        result = updater.apply_update(listener, plan, contents, plan['workerSHA256'])
        self.assertTrue(result['keptPaused'])
        self.assertTrue(listener.paused())
        self.assertEqual(listener.actions[-1], ('heartbeat', True, 42))
        self.assertEqual((self.worker / 'wechat_listener.py').read_bytes(), b'new code')
        self.assertEqual((self.worker / 'reply_policy.cjs').read_bytes(), b'unchanged')
        self.assertFalse((pycache / 'wechat_listener.cpython-314.pyc').exists())
        self.assertTrue((pycache / 'unrelated.cpython-314.pyc').exists())
        checkpoint, = self.backups.glob('worker-only-*')
        with closing(sqlite3.connect(checkpoint / 'listener.db')) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(db.execute('SELECT value FROM cursor').fetchall(), [('old',)])

    def test_candidate_boot_or_resume_failure_rolls_back_without_replaying_cursors(self):
        self.candidate()
        plan, contents = self.plan()
        for failure in ('start', 'resume'):
            with self.subTest(failure=failure):
                listener = FixtureListener(self.config, failure=failure)
                with self.assertRaisesRegex(updater.UpdateError, 'worker-update-rolled-back'):
                    updater.apply_update(listener, plan, contents, plan['workerSHA256'])
                self.assertEqual(listener.started, 2)
                self.assertFalse(listener.paused())
                self.assertEqual((self.worker / 'wechat_listener.py').read_bytes(), b'old code')
                self.assertFalse((self.worker / 'wechat_new.py').exists())
                with closing(sqlite3.connect(listener.database)) as db:
                    expected = [('old',), ('new',)] if failure == 'resume' else [('old',)]
                    self.assertEqual(db.execute('SELECT value FROM cursor ORDER BY rowid').fetchall(), expected)

    def test_backup_failure_preserves_prior_state_and_never_stops_service(self):
        self.candidate()
        plan, contents = self.plan()
        listener = FixtureListener(self.config)
        with patch.object(updater, 'backup', side_effect=updater.UpdateError('mock-failed-integrity')):
            with self.assertRaisesRegex(updater.UpdateError, 'mock-failed-integrity'):
                updater.apply_update(listener, plan, contents, plan['workerSHA256'])
        self.assertFalse(listener.paused())
        self.assertTrue(all(action[0] == 'heartbeat' for action in listener.actions))
        self.assertEqual((self.worker / 'wechat_listener.py').read_bytes(), b'old code')

    def test_owner_pause_change_during_restart_aborts_and_leaves_rollback_paused(self):
        self.candidate()
        plan, contents = self.plan()
        listener = FixtureListener(self.config, failure='pause-change')
        with self.assertRaisesRegex(updater.UpdateError, 'worker-update-rolled-back'):
            updater.apply_update(listener, plan, contents, plan['workerSHA256'])
        self.assertTrue(listener.paused())
        self.assertEqual(listener.actions[-1], ('heartbeat', True, 43))
        self.assertEqual((self.worker / 'wechat_listener.py').read_bytes(), b'old code')

    def test_old_or_unrelated_heartbeats_are_ignored(self):
        listener = updater.Listener(self.config)
        now = time.time()
        listener.pause(True)
        common = {'state': 'paused', 'group_policy_version': 4}
        values = [{**common, 'heartbeat_at': now - 5, 'pid': 41},
                  {**common, 'heartbeat_at': now - 3, 'pid': 42},
                  {**common, 'heartbeat_at': now - 2, 'pid': 41}]
        with patch.object(listener, 'status', side_effect=values) as status, \
                patch.object(listener, 'job', return_value=(True, 41)), patch.object(updater.time, 'sleep'):
            result = listener.heartbeat(paused=True, after=now - 4, protocol=4)
        self.assertEqual(status.call_count, 3)
        self.assertEqual(result['pid'], 41)


if __name__ == '__main__':
    unittest.main()
