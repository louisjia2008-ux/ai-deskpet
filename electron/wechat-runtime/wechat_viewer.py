"""Restore the loopback-only browser viewer for the dedicated guest."""

import subprocess
import time
from urllib.request import ProxyHandler, build_opener

import vm_console as ui
from wechat_reply_settings import NoRedirect


VIEWER = "http://127.0.0.1:15939/vnc.html?autoconnect=1&resize=scale"
FORWARD = "127.0.0.1:15939:127.0.0.1:5939"


def viewer_ready():
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(VIEWER, timeout=1) as response:
            return response.url == VIEWER and b"noVNC" in response.read(4096)
    except OSError:
        return False


def start_viewer():
    if viewer_ready():
        return VIEWER
    ui.guest(
        "if ! ss -H -ltn 'sport = :5939' | grep -Fq '127.0.0.1:5939'; then "
        "command -v websockify >/dev/null && test -f /usr/share/novnc/vnc.html && "
        "websockify --daemon --web=/usr/share/novnc 127.0.0.1:5939 127.0.0.1:5938; fi"
    )
    subprocess.run(["/usr/bin/ssh", "-F", str(ui.SSH_CONFIG), "-O", "forward", "-L", FORWARD, ui.SSH_HOST],
                   capture_output=True, check=False, timeout=6)
    for _ in range(8):
        if viewer_ready():
            return VIEWER
        time.sleep(.25)
    raise ui.TestError("微信虚拟机查看窗口暂不可用。")
