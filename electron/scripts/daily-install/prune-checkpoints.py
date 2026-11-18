"""Keep the newest three install checkpoints, never the one just written."""

import os
import re
import shutil
import sys
from pathlib import Path
from install_config import context

_stage, CONFIG, _checkpoint = context()
ROOT = Path(CONFIG['backupRoot'])
NAME = re.compile(r'^install-\d{8}-[A-Za-z0-9._-]+$')
KEEP = 3


def main():
    current = Path(sys.argv[1]).resolve()
    if current.parent != ROOT or not current.is_dir():
        raise SystemExit('Pass the checkpoint this install just wrote.')
    items = [path for path in ROOT.iterdir() if NAME.match(path.name) and path.is_dir() and not path.is_symlink()]
    items.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    older = [path for path in items if path != current][KEEP - 1:]
    for path in older:
        shutil.rmtree(path)
    print({'kept': [path.name for path in items if path not in older], 'removed': [path.name for path in older]})


if __name__ == '__main__':
    main()
