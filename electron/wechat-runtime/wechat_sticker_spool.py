"""Read the single approved sticker the host staged for a WeChat reply."""

import hashlib
import hmac
import os
import stat

from wechat_reply_settings import SHA256
from wechat_service import prepare_runtime


MAX_STICKER_BYTES = 2_000_000
STICKER_SPOOL = "sticker-spool"


def read_staged_sticker(runtime, event_id, digest):
    if not all(isinstance(value, str) and SHA256.fullmatch(value) for value in (event_id, digest)):
        raise ValueError("Invalid staged sticker identity.")
    directory = os.open(prepare_runtime(runtime) / STICKER_SPOOL, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("Sticker spool is not owner-only.")
        name = f"{event_id}.{digest}.png"
        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(handle, "rb") as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                    or not 0 < info.st_size <= MAX_STICKER_BYTES):
                raise PermissionError("Staged sticker is not an owner-only bounded file.")
            data = source.read(MAX_STICKER_BYTES + 1)
        if (len(data) > MAX_STICKER_BYTES or not data.startswith(b"\x89PNG\r\n\x1a\n")
                or not hmac.compare_digest(hashlib.sha256(data).hexdigest(), digest)):
            raise ValueError("Staged sticker did not match its PNG digest.")
        return data
    finally:
        os.close(directory)
