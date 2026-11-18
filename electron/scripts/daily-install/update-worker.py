"""Stage or roll back the host listener while its paused heartbeat is current."""

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from install_config import context

STAGE, CONFIG, CHECKPOINT = context()
APP = Path(CONFIG['installedApp'])
WORKER = Path(CONFIG['workerDir'])
ROOT = Path(CONFIG['wechatRoot'])
RUNTIME = ROOT / 'listener'
PREINSTALL_BACKUP = STAGE / 'previous-wechat-worker'
BACKUP = CHECKPOINT / PREINSTALL_BACKUP.name
PAUSE_RECORD = STAGE / 'previous-worker-pause.json'
APPLIED_RECORD = STAGE / 'applied-worker.json'
LAUNCHD = Path(CONFIG['launchAgent'])
PYTHON = CONFIG['python']
SERVICE = f"gui/{os.getuid()}/{CONFIG['launchAgentLabel']}"
REQUIRED = {
    'deskpet_reply.cjs', 'reply_policy.cjs',
    'vm_console.py', 'wechat_listener.py', 'wechat_state.py',
    'wechat_db_guest.py', 'wechat_db_intake.py', 'wechat_db_channel.py',
}


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def require_private(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600) or
            (not directory and info.st_nlink != 1)):
        raise RuntimeError(f'Unexpected ownership or mode for {path.name}.')


def write_record(path, value):
    with path.open('x', encoding='utf-8') as record:
        json.dump(value, record, indent=2)
        record.write('\n')


def cli(command):
    return json.loads(subprocess.check_output([PYTHON, '-B', str(WORKER / 'wechat_listener.py'),
        '--config', str(ROOT / 'targets.json'), '--state', str(ROOT / 'listener.db'),
        '--runtime', str(RUNTIME), command], timeout=12))


def wait_for_pause(previous_pid=None):
    deadline = time.monotonic() + 55
    while time.monotonic() < deadline:
        try:
            status = cli('status')
            pid = status.get('pid')
            if (status['state'] == 'paused' and status['paused'] and not status['stale'] and
                    type(pid) is int and pid != previous_pid and time.time() - status['heartbeat_at'] < 25):
                os.kill(pid, 0)
                return status
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Listener did not reach a fresh paused heartbeat.')


def restart():
    subprocess.run(['/bin/launchctl', 'kickstart', '-k', SERVICE], check=True, timeout=20)


def copy_atomic(origin, destination):
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        item = Path(temp) / destination.name
        shutil.copyfile(origin, item)
        item.chmod(0o600)
        os.replace(item, destination)


def expected_resources():
    identity = json.loads((STAGE / 'package-identity.json').read_text())
    if sha(APP / 'Contents/Resources/app.asar') != identity['asarSHA256']:
        raise RuntimeError('Installed app differs from the reviewed artifact.')
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(APP)], check=True, timeout=35)
    runtime = APP / 'Contents/Resources/wechat-runtime'
    expected = identity['wechatRuntime']
    if not REQUIRED.issubset(expected):
        raise RuntimeError('The sealed app is missing required listener modules.')
    actual = {}
    for path in runtime.iterdir():
        if not path.is_file() or path.is_symlink():
            raise RuntimeError('The sealed app has an irregular listener resource.')
        actual[path.name] = sha(path)
    if actual != expected:
        raise RuntimeError('The sealed resources differ from the reviewed artifact.')
    return runtime, expected


def config_files():
    # status.json and the app's heartbeat are live runtime state, rewritten while the app shuts down.
    paths = {str(path.relative_to(ROOT)): path for path in RUNTIME.glob('*.json')
             if path.name not in {'status.json', 'app-heartbeat.json'}}
    paths['targets.json'] = ROOT / 'targets.json'
    for path in paths.values():
        require_private(path)
    return dict(sorted(paths.items()))


def backup_state(expected):
    for path in (WORKER, ROOT, RUNTIME, STAGE):
        require_private(path, directory=True)
    current = wait_for_pause()
    backup_tmp = Path(tempfile.mkdtemp(prefix='.wechat-worker-', dir=STAGE))
    try:
        saved_worker = backup_tmp / 'worker'; saved_worker.mkdir()
        saved_config = backup_tmp / 'config'; saved_config.mkdir()
        before_config = {name: sha(path) for name, path in config_files().items()}
        for name, path in config_files().items():
            destination = saved_config / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            if sha(destination) != before_config[name]:
                raise RuntimeError(f'Configuration changed during backup for {path.name}.')
        before_worker = {}
        for name in sorted(expected):
            path = WORKER / name
            if not path.exists() and not path.is_symlink():
                continue
            require_private(path)
            before_worker[name] = sha(path)
            shutil.copyfile(path, saved_worker / name)
            if sha(saved_worker / name) != before_worker[name]:
                raise RuntimeError(f'Worker changed during backup for {name}.')
        require_private(LAUNCHD)
        shutil.copyfile(LAUNCHD, backup_tmp / 'launch-agent.plist')
        database = ROOT / 'listener.db'
        require_private(database)
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10)) as source, \
                closing(sqlite3.connect(backup_tmp / 'listener.db')) as target:
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise RuntimeError('Listener DB backup failed integrity_check.')
        if (current['pid'] != wait_for_pause()['pid'] or
                before_config != {name: sha(path) for name, path in config_files().items()}):
            raise RuntimeError('Paused listener/configuration changed during backup.')
        manifest = {'priorPID': current['pid'], 'protocol': current['group_policy_version'],
                    'worker': before_worker, 'configuration': before_config,
                    'databaseSHA256': sha(backup_tmp / 'listener.db'),
                    'launchAgentSHA256': sha(backup_tmp / 'launch-agent.plist')}
        write_record(backup_tmp / 'manifest.json', manifest)
        if PREINSTALL_BACKUP.exists() or PREINSTALL_BACKUP.is_symlink():
            raise RuntimeError('Worker checkpoint already exists.')
        os.rename(backup_tmp, PREINSTALL_BACKUP)
    except BaseException:
        shutil.rmtree(backup_tmp, ignore_errors=True)
        raise
    print(json.dumps({'paused': True, 'workerBackup': str(PREINSTALL_BACKUP),
                      'databaseIntegrity': 'ok', 'configurationFiles': len(before_config),
                      'previousWorkerFiles': len(before_worker)}))
    return manifest


def publish_backup(manifest):
    require_private(CHECKPOINT, directory=True)
    if BACKUP.exists() or BACKUP.is_symlink():
        raise RuntimeError('The final worker backup already exists.')
    expected = {'listener.db': manifest['databaseSHA256'],
                'launch-agent.plist': manifest['launchAgentSHA256']}
    expected.update({f'worker/{name}': value for name, value in manifest['worker'].items()})
    expected.update({f'config/{name}': value for name, value in manifest['configuration'].items()})
    expected['manifest.json'] = sha(PREINSTALL_BACKUP / 'manifest.json')
    with tempfile.TemporaryDirectory(prefix='.wechat-worker-', dir=CHECKPOINT) as temporary:
        destination = Path(temporary) / BACKUP.name
        shutil.copytree(PREINSTALL_BACKUP, destination)
        for name, value in expected.items():
            file = destination / name
            require_private(file)
            if sha(file) != value:
                raise RuntimeError(f'Published backup mismatch for {file.name}.')
        os.rename(destination, BACKUP)


def restore_code(manifest, modified):
    for name in modified:
        if name in manifest['worker']:
            previous = BACKUP / 'worker' / name
            if sha(previous) != manifest['worker'][name]:
                raise RuntimeError(f'Invalid rollback resource {name}.')
            copy_atomic(previous, WORKER / name)
        else:
            (WORKER / name).unlink(missing_ok=True)


def swap_code():
    source, expected = expected_resources()
    manifest = json.loads((PREINSTALL_BACKUP / 'manifest.json').read_text())
    previous = wait_for_pause()
    if previous['pid'] != manifest['priorPID'] or APPLIED_RECORD.exists():
        raise RuntimeError('Listener restarted since its backup or already changed.')
    present_hashes = {name: sha(WORKER / name) for name in expected if (WORKER / name).exists()}
    if present_hashes != manifest['worker']:
        raise RuntimeError('Worker resources changed after backup.')
    if {name: sha(path) for name, path in config_files().items()} != manifest['configuration']:
        raise RuntimeError('Worker configuration changed after backup.')
    publish_backup(manifest)
    modified = [name for name, value in sorted(expected.items()) if present_hashes.get(name) != value]
    if not modified:
        print(json.dumps({'paused': True, 'pid': previous['pid'], 'changed': []}))
        return
    try:
        for name in modified:
            copy_atomic(source / name, WORKER / name)
        for name, value in expected.items():
            if sha(WORKER / name) != value:
                raise RuntimeError(f'Worker resource mismatch for {name}.')
        restart()
        current = wait_for_pause(previous['pid'])
        if current['group_policy_version'] != manifest['protocol']:
            raise RuntimeError('Listener protocol changed unexpectedly.')
        write_record(APPLIED_RECORD, {'pid': current['pid'], 'modified': modified})
    except BaseException:
        restore_code(manifest, modified)
        restart()
        wait_for_pause()
        raise
    print(json.dumps({'paused': True, 'pid': current['pid'], 'changed': modified}))


def main():
    os.umask(0o077)
    if len(sys.argv) != 2:
        raise SystemExit('Choose pause, backup, swap, rollback or resume.')
    command = sys.argv[1]
    if command == 'pause':
        prior = cli('status')
        write_record(PAUSE_RECORD, {'paused': prior['paused'], 'pid': prior['pid']})
        if not prior['paused']:
            cli('pause')
        print(json.dumps({'paused': True, 'pid': wait_for_pause()['pid']}))
    elif command == 'backup':
        # Use previously sealed candidate identity; active app may still be the predecessor.
        identity = json.loads((STAGE / 'package-identity.json').read_text())
        expected = identity['wechatRuntime']
        if not REQUIRED.issubset(expected):
            raise RuntimeError('The reviewed candidate is missing required database-enabled listener modules.')
        backup_state(expected)
    elif command == 'swap':
        swap_code()
    elif command == 'rollback':
        prior = wait_for_pause()
        applied = json.loads(APPLIED_RECORD.read_text())
        manifest = json.loads((BACKUP / 'manifest.json').read_text())
        restore_code(manifest, applied['modified'])
        restart()
        current = wait_for_pause(prior['pid'])
        APPLIED_RECORD.rename(STAGE / 'rolled-back-worker.json')
        print(json.dumps({'rolledBack': True, 'paused': True, 'pid': current['pid']}))
    elif command == 'resume':
        prior = json.loads(PAUSE_RECORD.read_text())
        wait_for_pause()
        if not prior['paused']:
            cli('resume')
        print(json.dumps({'resumeRequested': not prior['paused']}))
    else:
        raise SystemExit('Choose pause, backup, swap, rollback or resume.')


if __name__ == '__main__':
    main()
