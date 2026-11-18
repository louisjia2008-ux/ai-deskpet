"""Restore the just-replaced binary if the app has not changed its checkpointed profile."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from install_config import context

STAGE, CONFIG, CHECKPOINT = context()
APP = Path(CONFIG['installedApp'])
PROFILE = Path(CONFIG['profileRoot'])
OLD_APP = CHECKPOINT / 'previous-app.app'
NEW_APP = CHECKPOINT / 'rolled-back-new-app.app'
ASAR = 'Contents/Resources/app.asar'
VERIFY = str(Path(__file__).resolve().parent.parent / 'verify-mac-package.mjs')


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def no_writers():
    processes = subprocess.check_output(['/bin/ps', '-axo', 'command='], text=True)
    prefixes = tuple(str(path) + '/Contents/' for path in (APP, OLD_APP, NEW_APP))
    if any(command.lstrip().startswith(prefixes) for command in processes.splitlines()):
        raise RuntimeError('Quit the DeskPet daily app before rolling back.')
    names = {entry.name for entry in PROFILE.iterdir()}
    if names.intersection({'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'restore-pending.json', 'recovery', '.staging'}) or any('.corrupt-' in name for name in names):
        raise RuntimeError('The stopped profile has a lock or unresolved recovery.')


def same_profile():
    manifest = json.loads((CHECKPOINT / 'profile-manifest.json').read_text())
    if manifest['data'] != str(PROFILE) or PROFILE.resolve() != PROFILE:
        raise RuntimeError('The saved profile identity does not match.')
    for entry in manifest['files']:
        relative = Path(entry['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Unexpected profile manifest path.')
        current = PROFILE / relative
        saved = CHECKPOINT / 'previous-profile' / relative
        if current.resolve() != current or saved.resolve() != saved or digest(current) != entry['sha256'] or digest(saved) != entry['sha256']:
            raise RuntimeError('The profile changed after the upgrade. Rollback needs fresh review.')


def verify(app, expected):
    if app.resolve() != app or digest(app / ASAR) != expected:
        raise RuntimeError('The app does not match its reviewed identity.')
    subprocess.run(['node', VERIFY, str(app), 'daily'], check=True, timeout=45)


def main():
    identity = json.loads((STAGE / 'package-identity.json').read_text())
    info = CHECKPOINT.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) != 0o700 or NEW_APP.exists() or NEW_APP.is_symlink()):
        raise RuntimeError('Unexpected rollback checkpoint.')
    if APP.stat().st_dev != info.st_dev:
        raise RuntimeError('Binary rollback requires same-filesystem renames.')
    no_writers()
    same_profile()
    verify(APP, identity['asarSHA256'])
    verify(OLD_APP, identity['previousAppASARSHA256'])
    no_writers()
    os.rename(APP, NEW_APP)
    try:
        os.rename(OLD_APP, APP)
    except BaseException:
        os.rename(NEW_APP, APP)
        raise
    verify(APP, identity['previousAppASARSHA256'])
    print(json.dumps({'appRolledBack': str(APP), 'newBuildKept': str(NEW_APP), 'profileUnmodified': True}))


if __name__ == '__main__':
    main()
