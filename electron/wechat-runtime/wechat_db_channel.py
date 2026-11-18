"""Send bounded read-only database requests to the dedicated Lima guest."""

import base64
import json
from pathlib import Path
import re
import shlex
import subprocess

import vm_console as ui


MAX_RESPONSE = 1_048_576
MAX_REQUEST = 65_536
ERROR_CODE = re.compile(r"[a-z0-9_]{1,64}\Z")


class DatabaseUnavailable(ui.DiagnosticTestError):
    def __init__(self, code):
        self.code = code
        super().__init__(f"微信数据库读取失败（{code}）。")


# sudo logs its whole command line on every poll, so the guest program travels
# on stdin ahead of the request: a byte-length line, the program, then the request.
BOOTSTRAP = ('import sys;r=sys.stdin.buffer;n=int(r.readline(16));'
             'exec(compile(r.read(n),"wechat_db_guest.py","exec"))')


class DatabaseReader:
    def __init__(self):
        source = Path(__file__).with_name("wechat_db_guest.py").read_bytes()
        self.preamble = f"{len(source)}\n".encode() + source
        self.command = [
            "/usr/bin/ssh", "-F", str(ui.SSH_CONFIG), "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=4", ui.SSH_HOST,
            "ulimit -c 0 && sudo -n /usr/bin/python3 -I -B -c " + shlex.quote(BOOTSTRAP),
        ]

    def voice_baseline(self, account_id, owner_id):
        result = self.read({"op": "voice_baseline", "account_id": account_id, "owner_id": owner_id})
        if (result.get("account_id") != account_id or not isinstance(result.get("cursors"), dict)
                or not result["cursors"] or type(result.get("since")) is not int):
            raise DatabaseUnavailable("guest_response_invalid")
        return {"cursors": result["cursors"], "since": result["since"]}

    def voice_receipt(self, account_id, owner_id, baseline, expected_duration_ms):
        result = self.read({"op": "voice_receipt", "account_id": account_id, "owner_id": owner_id,
                            "cursors": baseline["cursors"], "since": baseline["since"],
                            "expected_duration_ms": expected_duration_ms})
        if result.get("account_id") != account_id:
            raise DatabaseUnavailable("guest_response_invalid")
        result.pop("ok")
        result.pop("account_id")
        return result

    def voice_audio(self, account_id, owner_id, server_id, *, friend_id=None):
        """One bound conversation's stored voice, or None while it is still downloading."""
        request = {"op": "voice_audio", "account_id": account_id, "owner_id": owner_id, "server_id": server_id}
        if friend_id is not None:
            request["friend_id"] = friend_id
        result = self.read(request)
        if result.get("account_id") != account_id or result.get("status") not in ("ready", "pending"):
            raise DatabaseUnavailable("guest_response_invalid")
        if result["status"] == "pending":
            return None
        try:
            return base64.b64decode(result["audio"], validate=True)
        except (KeyError, TypeError, ValueError) as error:
            raise DatabaseUnavailable("guest_response_invalid") from error

    def read(self, request, *, timeout=16):
        payload = (json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        if len(payload) > MAX_REQUEST:
            raise DatabaseUnavailable("request_too_large")
        try:
            completed = subprocess.run(self.command, input=self.preamble + payload, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            raise DatabaseUnavailable("guest_unreachable") from error
        if len(completed.stdout) > MAX_RESPONSE:
            raise DatabaseUnavailable("response_too_large")
        try:
            result = json.loads(completed.stdout)
        except ValueError as error:
            code = "guest_unreachable" if completed.returncode == 255 else "guest_response_invalid"
            raise DatabaseUnavailable(code) from error
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise DatabaseUnavailable("guest_response_invalid")
        if not result["ok"]:
            code = result.get("error")
            raise DatabaseUnavailable(code if isinstance(code, str) and ERROR_CODE.fullmatch(code)
                                      else "guest_response_invalid")
        if completed.returncode:
            raise DatabaseUnavailable("guest_response_invalid")
        return result
