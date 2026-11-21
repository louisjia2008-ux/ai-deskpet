"""Plan or apply an approved, Python-only host listener update."""

from contextlib import closing, contextmanager, suppress
import argparse
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import sqlite3
import stat
import subprocess
import tempfile
import time


PROJECT = Path(__file__).resolve().parents[2]
WORKER_PATH = 'electron/wechat-runtime/'
WORKER_NAME = re.compile(r'(?:[a-z][a-z0-9_]*\.(?:py|cjs)|acknowledged-cat\.png)\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
BUILD_FILES = ('package.json', 'package-lock.json', 'forge.config.ts', 'webpack.main.config.ts',
               'webpack.renderer.config.ts', 'webpack.rules.ts', 'webpack.build-identity.ts', 'tsconfig.json')
IDENTITY_HELPERS = ('scripts/daily-install/config.cjs', 'scripts/verify-mac-package.mjs')
SCHEMA_MODULES = {'wechat_state.py', 'wechat_owner_delivery.py', 'wechat_moments.py', 'wechat_replies.py'}
SCHEMA_SQL = re.compile(rb'\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)(?:TABLE|INDEX|VIEW|TRIGGER)\b'
                        rb'|\bALTER\s+TABLE\b|\bPRAGMA\s+(?:user_version|schema_version|writable_schema)\b', re.I)
SUPPORT_FILES = {
    'electron/docs/wechat-expansion-stage-0.md',
    'electron/scripts/daily-install/update-worker-only.py',
    'electron/scripts/daily-install/WORKER-ONLY.md',
    'electron/tests/test_daily_install_worker_only.py',
    'electron/tests/test_wechat_send_diagnostics.py',
    'electron/tests/test_wechat_owner_drawer.py',
}
IDENTITY = r'''
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { extractFile } from '@electron/asar';
import configModule from './scripts/daily-install/config.cjs';
import { verifyMacPackage } from './scripts/verify-mac-package.mjs';
const config = configModule.loadConfig(process.argv[1]);
if (realpathSync(config.installedApp) !== config.installedApp) throw Error('linked-app');
process.env.DESKPET_MAC_SIGN_IDENTITY = config.signingIdentity;
verifyMacPackage(config.installedApp, 'daily', true);
const appAsar = join(config.installedApp, 'Contents/Resources/app.asar');
const main = extractFile(appAsar, '.webpack/main/index.js').toString();
const sourceHashes = [...new Set([...main.matchAll(/sourceSHA256"?\s*:\s*"([a-f0-9]{64})"/gu)].map(row => row[1]))];
if (sourceHashes.length !== 1) throw Error('invalid-build-source-hash');
console.log(JSON.stringify({
  config, source: sourceHashes[0],
  asar: createHash('sha256').update(readFileSync(appAsar)).digest('hex'),
}));
'''


class UpdateError(RuntimeError):
    """An error safe to print without paths, service output or private data."""


def require(condition, code):
    if not condition:
        raise UpdateError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with open_regular(path) as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def command(args, **options):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=40, **options)


def installed_identity(project, config):
    env = {key: value for key, value in os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
    result = command(['node', '--input-type=module', '-e', IDENTITY, str(config)], cwd=project, env=env)
    require(result.returncode == 0, 'installed-app-identity-unverified')
    return json.loads(result.stdout)


def git(project, *args, data=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    result = subprocess.run(['/usr/bin/git', '--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
                             '-C', str(project), *args], input=data, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=40)
    require(result.returncode == 0, 'git-verification-failed')
    return result.stdout


def git_blobs(project, commit, paths):
    entries = {}
    for row in git(project, 'ls-tree', '-r', '-z', '--full-tree', commit, '--', *paths).split(b'\0'):
        if not row:
            continue
        mode, kind, oid, name = re.split(rb'[ \t]', row, maxsplit=3)
        require(kind == b'blob' and mode in (b'100644', b'100755'), 'non-regular-reviewed-resource')
        entries[name.decode('utf-8')] = oid
    unique = sorted(set(entries.values()))
    raw = git(project, 'cat-file', '--batch', data=b'\n'.join(unique) + b'\n')
    content = {}
    cursor = 0
    for oid in unique:
        end = raw.index(b'\n', cursor)
        got, kind, size = raw[cursor:end].split()
        require(got == oid and kind == b'blob', 'invalid-reviewed-blob')
        cursor = end + 1
        content[oid] = raw[cursor:cursor + int(size)]
        cursor += int(size) + 1
    return {name: content[oid] for name, oid in entries.items()}


def ordinary_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'non-regular-resource')
    return info


def open_regular(path):
    # Do not follow a replacement link between inventory and reading bytes.
    expected = ordinary_file(path)
    handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if not os.path.samestat(os.fstat(handle), expected):
        os.close(handle)
        raise UpdateError('resource-changed-during-read')
    return os.fdopen(handle, 'rb')


def directory(path, *, private=True):
    info = path.lstat()
    require(path.is_absolute() and path.resolve() == path and stat.S_ISDIR(info.st_mode)
            and (not private or (info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)),
            'unsafe-resource-directory')


def private_file(path):
    info = ordinary_file(path)
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe-private-resource')
    return info


def source_digest(files):
    # Match webpack.build-identity.ts: JavaScript sorts by UTF-16 code units.
    ordered = sorted(files, key=lambda name: name.encode('utf-16be'))
    return digest(encode([{'name': name, 'sha256': files[name]} for name in ordered]))


def disk_sources(project):
    directory(project / 'src', private=False)
    result = {}
    for path in (project / 'src').rglob('*'):
        require(not path.is_symlink(), 'linked-app-source')
        if path.is_file():
            result[path.relative_to(project).as_posix()] = file_digest(path)
        else:
            directory(path, private=False)
    for name in BUILD_FILES:
        ordinary_file(project / name)
        result[name] = file_digest(project / name)
    return result


def disk_runtime(path, *, live=False):
    directory(path, private=live)
    result = {}
    for item in path.iterdir():
        if live and item.name in {'node_modules', '__pycache__'}:
            directory(item, private=False)
            continue
        require(WORKER_NAME.fullmatch(item.name), 'unexpected-worker-resource')
        (private_file if live else ordinary_file)(item)
        result[item.name] = file_digest(item)
    return result


def reviewed_checkout(project, baseline):
    require(COMMIT.fullmatch(baseline), 'full-baseline-commit-required')
    status_args = ('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none')
    require(not git(project, *status_args), 'worktree-has-unreviewed-changes')
    candidate = git(project, 'rev-parse', 'HEAD').decode('ascii').strip()
    require(COMMIT.fullmatch(candidate), 'invalid-candidate-commit')
    git(project, 'merge-base', '--is-ancestor', baseline, candidate)
    changed = git(project, 'diff', '--no-relative', '--name-only', '--no-renames', '-z', baseline, candidate)
    worker_changes = []
    for name in (part.decode('utf-8') for part in changed.split(b'\0') if part):
        if name in SUPPORT_FILES:
            continue
        require(name.startswith(WORKER_PATH) and name.endswith('.py')
                and WORKER_NAME.fullmatch(name[len(WORKER_PATH):]), 'candidate-is-not-python-worker-only')
        require(name.removeprefix(WORKER_PATH) not in SCHEMA_MODULES, 'database-schema-review-requires-daily-install')
        worker_changes.append(name)
    changed_code = git_blobs(project, candidate, worker_changes) if worker_changes else {}
    require(not any(SCHEMA_SQL.search(data) for data in changed_code.values()),
            'database-schema-review-requires-daily-install')
    helpers = git_blobs(project, baseline, ['electron/' + name for name in IDENTITY_HELPERS])
    require(len(helpers) == len(IDENTITY_HELPERS) and all(
        file_digest(project / name) == digest(helpers['electron/' + name]) for name in IDENTITY_HELPERS),
        'unreviewed-identity-helper-on-disk')
    return candidate


def make_plan(project, identity, baseline):
    candidate = reviewed_checkout(project, baseline)
    sources = git_blobs(project, candidate, ['electron/src', *['electron/' + name for name in BUILD_FILES]])
    source_hashes = {name.removeprefix('electron/'): digest(data) for name, data in sources.items()}
    require(source_hashes == disk_sources(project), 'unreviewed-app-source-on-disk')
    require(source_digest(source_hashes) == identity['source'], 'installed-app-source-mismatch')

    def runtime(commit):
        result = {name.removeprefix(WORKER_PATH): data
                  for name, data in git_blobs(project, commit, [WORKER_PATH.rstrip('/')]).items()}
        require('wechat_listener.py' in result and all(WORKER_NAME.fullmatch(name) for name in result),
                'invalid-reviewed-worker-tree')
        return result

    previous = {name: digest(data) for name, data in runtime(baseline).items()}
    contents = runtime(candidate)
    manifest = {name: digest(data) for name, data in sorted(contents.items())}
    require(previous.keys() <= manifest.keys(), 'worker-only-deletions-not-supported')
    config = identity['config']
    sealed = Path(config['installedApp']) / 'Contents/Resources/wechat-runtime'
    require(previous == disk_runtime(sealed), 'installed-worker-resources-mismatch')
    require(manifest == disk_runtime(project / 'wechat-runtime'), 'unreviewed-worker-source-on-disk')
    require(previous == disk_runtime(Path(config['workerDir']), live=True), 'live-worker-is-not-sealed-baseline')
    modified = [name for name in manifest if manifest[name] != previous.get(name)]
    require(modified and all(name.endswith('.py') for name in modified), 'no-approved-python-worker-changes')
    require(reviewed_checkout(project, baseline) == candidate, 'worktree-changed-during-planning')
    payload = {'format': 1, 'baseline': baseline, 'candidate': candidate, 'appASARSHA256': identity['asar'],
               'sourceSHA256': identity['source'], 'configSHA256': digest(encode(dict(sorted(config.items())))),
               'previousWorker': previous, 'worker': manifest}
    return {**payload, 'workerSHA256': digest(encode(payload)), 'changed': modified}, contents


def sync_directory(path):
    handle = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def write_atomic(path, data):
    fd, name = tempfile.mkstemp(prefix='.worker-update-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


@contextmanager
def lock(path, *, create=False, timeout=0):
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    handle = os.open(path, flags | (os.O_CREAT if create else 0), 0o600)
    try:
        private_file(path)
        require(os.path.samestat(os.fstat(handle), path.lstat()), 'changed-lock-file')
        until = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= until:
                    raise UpdateError('worker-update-lock-held') from error
                time.sleep(0.25)
        yield
    finally:
        os.close(handle)


class Listener:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['wechatRoot'])
        self.worker = Path(config['workerDir'])
        self.runtime = self.root / 'listener'
        self.pause_file = self.runtime / 'paused'
        self.agent = Path(config['launchAgent'])
        self.domain = f'gui/{os.getuid()}'
        self.service = f'{self.domain}/{config["launchAgentLabel"]}'
        self.database = self.root / 'listener.db'
        self.backups = Path(config['backupRoot'])

    def inspect_agent(self):
        private_file(self.agent)
        require(self.agent.resolve() == self.agent, 'linked-launch-agent')
        with open_regular(self.agent) as handle:
            data = handle.read(65_537)
        require(len(data) <= 65_536, 'unexpected-listener-launch-agent')
        plist = plistlib.loads(data)
        args = plist.get('ProgramArguments', [])
        require(len(args) == 9 and Path(args[0]).resolve() == Path(self.config['python']).resolve()
                and args[1:] == [str(self.worker / 'wechat_listener.py'), '--config', str(self.root / 'targets.json'),
                                 '--state', str(self.database), '--runtime', str(self.runtime), 'run']
                and plist.get('Label') == self.config['launchAgentLabel']
                and plist.get('WorkingDirectory') == str(self.worker)
                and plist.get('RunAtLoad') is True, 'unexpected-listener-launch-agent')
        return digest(data)

    def job(self):
        result = command(['/bin/launchctl', 'print', self.service])
        if result.returncode:
            require(b'Could not find service' in result.stderr, 'listener-launchd-status-unavailable')
            return False, None
        pid = re.search(rb'^\s*pid = ([0-9]+)\s*$', result.stdout, re.M)
        return True, int(pid[1]) if pid else None

    def paused(self):
        if not self.pause_file.exists() and not self.pause_file.is_symlink():
            return False
        private_file(self.pause_file)
        return True

    def pause(self, value):
        if value and not self.paused():
            write_atomic(self.pause_file, b'paused\n')
        if not value and self.paused():
            self.pause_file.unlink()
            sync_directory(self.runtime)

    def pause_token(self):
        require(self.paused(), 'listener-pause-changed-during-update')
        info = private_file(self.pause_file)
        return info.st_dev, info.st_ino, info.st_mtime_ns

    def status(self):
        file = self.runtime / 'status.json'
        private_file(file)
        # The listener replaces the file atomically, so either snapshot is safe.
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(file, flags), 'rb') as handle:
            data = json.loads(handle.read(4097))
        if not isinstance(data, dict):
            raise ValueError('invalid-listener-status')
        return data

    def heartbeat(self, *, paused, after, same_pid=None, new_from=None, protocol=None, timeout=55):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                status = self.status()
            except (OSError, ValueError):
                time.sleep(1)
                continue
            pid = status.get('pid')
            heartbeat = status.get('heartbeat_at')
            version = status.get('group_policy_version')
            state = 'paused' if paused else 'running'
            if (status.get('state') == state and self.paused() == paused
                    and type(pid) is int and pid > 0 and (same_pid is None or pid == same_pid)
                    and pid != new_from and type(heartbeat) in (int, float)
                    and after < heartbeat <= time.time() and time.time() - heartbeat < 25
                    and type(version) is int and version > 0 and (protocol is None or version == protocol)
                    and self.job() == (True, pid)):
                return status
            time.sleep(1)
        raise UpdateError('listener-paused-heartbeat-missing' if paused else 'listener-running-heartbeat-missing')

    def stop(self):
        if self.job()[0]:
            result = command(['/bin/launchctl', 'bootout', self.service])
            require(result.returncode == 0 and not self.job()[0], 'listener-could-not-stop')

    def start(self, agent_digest):
        require(self.inspect_agent() == agent_digest, 'listener-launch-agent-changed')
        result = command(['/bin/launchctl', 'bootstrap', self.domain, str(self.agent)])
        require(result.returncode == 0, 'listener-could-not-start')


def backup(listener, plan):
    checkpoint = Path(tempfile.mkdtemp(prefix='worker-only-', dir=listener.backups))
    worker = checkpoint / 'worker'
    worker.mkdir(mode=0o700)
    for name, expected in plan['previousWorker'].items():
        with open_regular(listener.worker / name) as handle:
            data = handle.read()
        require(digest(data) == expected, 'live-worker-changed-during-backup')
        write_atomic(worker / name, data)
    private_file(listener.database)
    copy = checkpoint / 'listener.db'
    with closing(sqlite3.connect(listener.database.as_uri() + '?mode=ro', uri=True, timeout=10)) as source, \
            closing(sqlite3.connect(copy)) as target:
        source.backup(target)
        require(target.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'listener-backup-integrity-failed')
    private_file(copy)
    with copy.open('rb') as handle:
        os.fsync(handle.fileno())
    write_atomic(checkpoint / 'manifest.json', encode({
        **plan, 'databaseSHA256': file_digest(copy),
    }) + b'\n')
    sync_directory(listener.backups)
    return checkpoint


def replace_worker(listener, names, contents, pause_token):
    cache = listener.worker / '__pycache__'
    if cache.exists() or cache.is_symlink():
        directory(cache, private=False)
    for name in names:
        require(listener.pause_token() == pause_token, 'listener-pause-changed-during-update')
        if cache.exists():
            for file in cache.glob(Path(name).stem + '.*.pyc'):
                ordinary_file(file)
                file.unlink()
        path = listener.worker / name
        if name in contents:
            write_atomic(path, contents[name])
        else:
            path.unlink(missing_ok=True)
    sync_directory(listener.worker)


def restore_pause(listener, was_paused, paused, token):
    require(listener.pause_token() == token, 'listener-pause-changed-during-update')
    if not was_paused:
        listener.pause(False)
        listener.heartbeat(paused=False, after=paused['heartbeat_at'], same_pid=paused['pid'],
                           protocol=paused['group_policy_version'])


def apply_update(listener, plan, contents, approved):
    require(HEX.fullmatch(approved) and hmac.compare_digest(approved, plan['workerSHA256']),
            'worker-update-not-approved')
    for path in (listener.root, listener.runtime, listener.worker, listener.backups):
        directory(path)
    installed = Path(listener.config['installedApp']) / 'Contents/Resources/app.asar'
    with lock(listener.backups / '.worker-only.lock', create=True), \
            lock(listener.runtime / 'doctor-install.lock', create=True, timeout=25):
        agent_digest = listener.inspect_agent()
        was_paused = listener.paused()
        initial = listener.heartbeat(paused=was_paused, after=time.time() - 25)
        protocol = initial['group_policy_version']
        checkpoint = None
        operation_started = False
        worker_touched = False
        try:
            listener.pause(True)
            pause_token = listener.pause_token()
            paused = listener.heartbeat(paused=True, after=max(time.time(), initial['heartbeat_at']),
                                        same_pid=initial['pid'], protocol=protocol)
            require(disk_runtime(listener.worker, live=True) == plan['previousWorker'], 'live-worker-changed')
            checkpoint = backup(listener, plan)
            listener.heartbeat(paused=True, after=paused['heartbeat_at'], same_pid=paused['pid'], protocol=protocol)
            require(listener.pause_token() == pause_token, 'listener-pause-changed-during-update')
            require(file_digest(installed) == plan['appASARSHA256'], 'installed-app-changed')
            require(listener.inspect_agent() == agent_digest, 'listener-launch-agent-changed')
            require(disk_runtime(listener.worker, live=True) == plan['previousWorker'], 'live-worker-changed')
            operation_started = True
            listener.stop()
            with lock(listener.runtime / 'listener.lock', timeout=20):
                require(listener.pause_token() == pause_token, 'listener-pause-changed-during-update')
                require(disk_runtime(listener.worker, live=True) == plan['previousWorker'], 'live-worker-changed')
                worker_touched = True
                replace_worker(listener, plan['changed'], contents, pause_token)
                require(disk_runtime(listener.worker, live=True) == plan['worker'], 'updated-worker-hash-mismatch')
            require(listener.pause_token() == pause_token, 'listener-pause-changed-during-update')
            started_after = time.time()
            listener.start(agent_digest)
            current = listener.heartbeat(paused=True, after=started_after, new_from=initial['pid'], protocol=protocol)
            require(file_digest(installed) == plan['appASARSHA256'], 'installed-app-changed')
            restore_pause(listener, was_paused, current, pause_token)
        except BaseException as error:
            keep_paused = was_paused or str(error) == 'listener-pause-changed-during-update'
            try:
                if operation_started:
                    listener.pause(True)
                    rollback_pause = listener.pause_token()
                    listener.stop()
                    with lock(listener.runtime / 'listener.lock', timeout=20):
                        if worker_touched:
                            previous = {}
                            for name in plan['changed']:
                                if name in plan['previousWorker']:
                                    with open_regular(checkpoint / 'worker' / name) as handle:
                                        previous[name] = handle.read()
                            require(all(digest(data) == plan['previousWorker'][name] for name, data in previous.items()),
                                    'rollback-worker-backup-hash-mismatch')
                            replace_worker(listener, plan['changed'], previous, rollback_pause)
                        require(disk_runtime(listener.worker, live=True) == plan['previousWorker'],
                                'rolled-back-worker-hash-mismatch')
                    rolled_back_at = time.time()
                    listener.start(agent_digest)
                    current = listener.heartbeat(paused=True, after=rolled_back_at, protocol=protocol)
                    restore_pause(listener, keep_paused, current, rollback_pause)
                elif not keep_paused:
                    listener.pause(False)
            except BaseException as rollback_error:
                with suppress(OSError, UpdateError):
                    listener.pause(True)
                raise UpdateError('worker-rollback-incomplete') from rollback_error
            if operation_started:
                raise UpdateError('worker-update-rolled-back') from error
            raise
    return {'updated': True, 'keptPaused': was_paused, 'databaseBackupIntegrity': 'ok',
            'changedCount': len(plan['changed']), 'workerSHA256': approved}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--plan', action='store_true')
    modes.add_argument('--approved-worker', metavar='HASH')
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--baseline', required=True, help='Full Git commit of the signed installed baseline')
    args = parser.parse_args()
    os.umask(0o077)

    def interrupted(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        identity, plan, contents = prepare_plan(PROJECT, args.config, args.baseline)
        result = plan if args.plan else apply_update(Listener(identity['config']), plan, contents, args.approved_worker)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except UpdateError as error:
        parser.exit(1, f'{error}\n')
    except (ValueError, OSError, KeyError, subprocess.SubprocessError, sqlite3.Error, KeyboardInterrupt):
        parser.exit(1, 'worker-update-failed\n')


def prepare_plan(project, config, baseline):
    candidate = reviewed_checkout(project, baseline)
    identity = installed_identity(project, config)
    plan, contents = make_plan(project, identity, baseline)
    require(plan['candidate'] == candidate, 'worktree-changed-during-planning')
    return identity, plan, contents


if __name__ == '__main__':
    main()
