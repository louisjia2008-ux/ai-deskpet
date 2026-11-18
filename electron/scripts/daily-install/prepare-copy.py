import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from install_config import context

root, config, _checkpoint = context()
identity = json.loads((root / 'package-identity.json').read_text())
app = Path(config['installedApp'])
data = Path(config['profileRoot'])
digest = lambda value: hashlib.sha256(value).hexdigest()
assert digest((app / 'Contents/Resources/app.asar').read_bytes()) == identity['previousAppASARSHA256']

def processes():
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True)
    return [(int(row.strip().split(None, 1)[0]), row.strip().split(None, 1)[1]) for row in rows.splitlines() if row.strip()]

def possible_writers():
    prefix = str(app) + '/Contents/'
    runner = prefix + 'MacOS/deskpet-electron '
    commands = [command for _, command in processes() if command.startswith(prefix)]
    isolated = [command for command in commands if command.startswith(runner)
                and ' --deskpet-isolated-profile=' in command and ' --use-mock-keychain' in command]
    if len(isolated) != 1:
        return commands
    profile = isolated[0].split(' --deskpet-isolated-profile=', 1)[1].split(' ', 1)[0]
    if not (profile.startswith('/private/var/folders/') and '/T/deskpet-wechat-replies-' in profile):
        return commands
    return [command for command in commands if command != isolated[0]
            and not (command.startswith(prefix + 'Frameworks/') and f'--user-data-dir={profile}/profile' in command)]

assert not possible_writers(), 'Close the DeskPet daily app normally before taking the stopped copy.'
assert data.is_dir() and not data.is_symlink() and data.resolve() == data

def stopped():
    names = {entry.name for entry in data.iterdir()}
    blocked = {'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'restore-pending.json', 'recovery', '.staging'}
    assert not names.intersection(blocked) and not any('.corrupt-' in name for name in names), 'Stopped-profile/recovery gate failed.'

stopped()
def inventory():
    result = []
    for path in sorted(data.rglob('*')):
        info = path.lstat()
        assert not path.is_symlink() and path.resolve() == path, 'Linked profile inventory entry.'
        if stat.S_ISREG(info.st_mode):
            result.append({'path': str(path.relative_to(data)), 'bytes': info.st_size, 'sha256': digest(path.read_bytes())})
        else:
            assert stat.S_ISDIR(info.st_mode), 'Irregular profile inventory entry.'
    return result

full_before = inventory()
copy = root / 'stopped-profile'
copy.mkdir(mode=0o700)
files = ['profile.enc.json', 'settings.json', 'vault/vault-key.safe', 'qq-channel-state.enc.json',
         'qq-channel-vault/vault-key.safe', 'telegram-channel-state.enc.json', 'telegram-channel-vault/vault-key.safe',
         'persona.enc.json', 'character.enc.json', 'diary.enc.json', 'voice-settings.json', 'speech-input.json']
before = []
for name in files:
    source = data / name
    if not source.exists():
        assert name not in {'profile.enc.json', 'vault/vault-key.safe'}, 'Required profile input missing.'
        before.append({'path': name, 'present': False})
        continue
    info = source.lstat()
    assert stat.S_ISREG(info.st_mode) and source.resolve() == source, 'Linked or irregular profile input.'
    content = source.read_bytes()
    target = copy / name
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with target.open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(content)
    before.append({'path': name, 'present': True, 'bytes': len(content), 'sha256': digest(content)})

stopped()
assert not possible_writers()
assert full_before == inventory(), 'Full profile inventory changed during copy.'
with (root / 'source-profile-inventory.json').open('x') as output:
    os.fchmod(output.fileno(), 0o600)
    json.dump(full_before, output)
for entry in before:
    source = data / entry['path']
    if entry['present']:
        assert digest(source.read_bytes()) == entry['sha256'] == digest((copy / entry['path']).read_bytes()), 'Profile changed during copy.'
    else:
        assert not source.exists(), 'Profile changed during copy.'
record = {'operation': 'stopped-encrypted-copy', 'normalQuitRequested': False, 'previousPID': None,
          'profile': str(data), 'copy': str(copy), 'sourceUnchanged': True, 'providerSecretValuesRead': False,
          'plaintextExported': False, 'files': before}
with (root / 'stopped-copy.json').open('x') as output:
    os.fchmod(output.fileno(), 0o600)
    json.dump(record, output, indent=2)
print(json.dumps({key: record[key] for key in ['operation', 'normalQuitRequested', 'sourceUnchanged', 'plaintextExported', 'copy']}))
