"""One guest call, no GUI lock, no message/log contents, and a short sudo argv."""
import json
from pathlib import Path
import subprocess

import vm_console as ui


FIELDS = {'totalBytes', 'freeBytes', 'authLogBytes', 'journalBytes', 'uptimeSeconds', 'wechatRunning'}
COMMAND = 'ulimit -c 0 && sudo -n /usr/bin/python3 -I -B -'


def vm_health():
    source = Path(__file__).with_name('wechat_vm_health_guest.py').read_bytes()
    completed = subprocess.run([
        '/usr/bin/ssh', '-F', str(ui.SSH_CONFIG), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', ui.SSH_HOST, COMMAND,
    ], input=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=16, check=False)
    if completed.returncode or len(completed.stdout) > 4096:
        raise ValueError('vm_health_unavailable')
    result = json.loads(completed.stdout)
    if (not isinstance(result, dict) or set(result) != FIELDS or type(result['wechatRunning']) is not bool
            or any(type(result[field]) is not int or not 0 <= result[field] <= 2 ** 53 - 1
                   for field in FIELDS - {'wechatRunning'})
            or result['totalBytes'] <= 0 or result['freeBytes'] > result['totalBytes']):
        raise ValueError('vm_health_unavailable')
    return result


def vm_health_control():
    from wechat_listener import control_error
    try:
        print(json.dumps(vm_health()))
    except (OSError, ValueError, subprocess.SubprocessError):
        control_error('vm_health_unavailable')
