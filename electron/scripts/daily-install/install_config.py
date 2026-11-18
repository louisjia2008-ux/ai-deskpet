"""Shared protected stage configuration; no machine-specific defaults in executable scripts."""
import json
import os
from pathlib import Path
import stat


def context():
    stage = Path(os.environ['DESKPET_INSTALL_STAGE'])
    assert stage.is_absolute() and stage.resolve() == stage and not stage.is_symlink()
    info = stage.stat()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
    file = stage / 'install-config.json'
    info = file.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
    config = json.loads(file.read_text())
    assert stage.parent == Path(config['stageRoot']) and file.resolve() == file
    record = json.loads((stage / 'install-context.json').read_text())
    assert record['stage'] == str(stage)
    checkpoint = Path(record['checkpoint'])
    assert checkpoint.parent == Path(config['backupRoot']) and checkpoint.name.startswith('install-')
    return stage, config, checkpoint
