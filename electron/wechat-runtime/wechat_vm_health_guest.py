"""Read-only guest metadata. This whole program is supplied on stdin, never argv."""
import json
import os
from pathlib import Path
import stat


def collect():
    disk = os.statvfs('/')
    auth = Path('/var/log/auth.log')
    auth_bytes = auth.stat().st_size if auth.exists() else 0
    journal_bytes = 0

    def fail(error):
        raise error

    for root, _, names in os.walk('/var/log/journal', followlinks=False, onerror=fail):
        for name in names:
            try:
                info = (Path(root) / name).lstat()
                if stat.S_ISREG(info.st_mode):
                    journal_bytes += info.st_size
            except FileNotFoundError:
                pass  # Journal rotation may remove a file during a read.
    running = False
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if (entry / 'comm').read_text().strip().casefold() in ('wechat', 'weixin'):
                running = True
                break
        except (FileNotFoundError, ProcessLookupError):
            pass
    uptime = int(float(Path('/proc/uptime').read_text().split()[0]))
    return {'totalBytes': disk.f_blocks * disk.f_frsize, 'freeBytes': disk.f_bavail * disk.f_frsize,
            'authLogBytes': auth_bytes, 'journalBytes': journal_bytes, 'uptimeSeconds': uptime, 'wechatRunning': running}


if __name__ == '__main__':
    print(json.dumps(collect()))
