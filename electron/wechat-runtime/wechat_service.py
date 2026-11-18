"""Local controls for the isolated WeChat listener."""

from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import plistlib
import re
import stat
import sys
import tempfile
import time


STATES = {"starting", "running", "paused", "degraded", "stopped"}
STATUS_CODE = re.compile(r"[a-z0-9_.-]{1,64}")
STATUS_FILE = "status.json"
PAUSE_FILE = "paused"
TEMPORARY_PAUSE_LOCK = "reply-target-pause.lock"
LOCK_FILE = "listener.lock"
GROUP_POLICY_VERSION = 4
REPLY_TARGET_BINDING_VERSION = 2
GROUP_STATUS_ID = re.compile(r"(?:legacy|[0-9a-f]{32})\Z")


def prepare_runtime(path):
    path = Path(path).expanduser().absolute()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PermissionError("Listener runtime directory must be owner-owned with mode 0700.")
    return path


def _open_private(path, flags):
    handle = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(handle)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        os.close(handle)
        raise PermissionError("Listener runtime file is not owner-only.")
    return handle


@contextmanager
def service_lock(runtime):
    path = prepare_runtime(runtime) / LOCK_FILE
    handle = _open_private(path, os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BlockingIOError("A listener is already running for this runtime directory.") from error
        yield
    finally:
        os.close(handle)


def _sync_directory(path):
    handle = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def _replace_private(path, data, *, durable):
    handle, name = tempfile.mkstemp(prefix=".listener-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(data)
            if durable:
                file.flush()
                os.fsync(file.fileno())
        os.replace(temporary, path)
        if durable:
            _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def is_paused(runtime):
    root = prepare_runtime(runtime)
    try:
        handle = _open_private(root / PAUSE_FILE, os.O_RDONLY)
    except FileNotFoundError:
        pass
    else:
        os.close(handle)
        return True
    try:
        handle = _open_private(root / TEMPORARY_PAUSE_LOCK, os.O_RDWR)
    except FileNotFoundError:
        return False
    try:
        try:
            # A shared probe conflicts only with a binding's exclusive lock, not with other probes.
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(handle)


@contextmanager
def pause_for_target_binding(runtime):
    """Pause delivery for this operation, even when the caller is killed mid-bind."""
    path = prepare_runtime(runtime) / TEMPORARY_PAUSE_LOCK
    handle = _open_private(path, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(handle)


def set_paused(runtime, paused):
    if not isinstance(paused, bool):
        raise ValueError("Pause state must be a boolean.")
    path = prepare_runtime(runtime) / PAUSE_FILE
    if paused:
        _replace_private(path, b"paused\n", durable=True)
    else:
        path.unlink(missing_ok=True)
        _sync_directory(path.parent)
    return paused


def _details(reason=None, private=None, group=None, pending=None, uncertain=None, groups=None, dropped=None, dropped_at=None,
             skipped=None, skipped_at=None, skipped_kinds=None, friends=None):
    details = {}
    for key, value in (("reason", reason), ("private", private), ("group", group)):
        if value is None:
            continue
        if not isinstance(value, str) or not STATUS_CODE.fullmatch(value):
            raise ValueError(f"{key} must be a bounded status code.")
        details[key] = value
    for key, value in (("pending", pending), ("uncertain", uncertain), ("dropped", dropped), ("skipped", skipped)):
        if value is None:
            continue
        if type(value) is not int or not 0 <= value <= 1_000_000:
            raise ValueError(f"{key} must be a bounded nonnegative count.")
        details[key] = value
    if groups is not None:
        if not isinstance(groups, dict) or len(groups) > 12:
            raise ValueError("Invalid group status list.")
        for group_id, entry in groups.items():
            if (not isinstance(group_id, str) or not GROUP_STATUS_ID.fullmatch(group_id)
                    or not isinstance(entry, dict) or set(entry) != {"status", "pending", "uncertain"}
                    or not isinstance(entry["status"], str) or not STATUS_CODE.fullmatch(entry["status"])
                    or any(type(entry[key]) is not int or not 0 <= entry[key] <= 1_000_000
                           for key in ("pending", "uncertain"))):
                raise ValueError("Invalid group status.")
        details["groups"] = groups
    if friends is not None:
        codes = {'ready', 'checking', 'paused', 'friend_rate_limited', 'friend_send_uncertain',
                 'friend_binding_invalid', 'friend_database_unavailable', 'friend_reply_unavailable'}
        if (not isinstance(friends, list) or len(friends) > 20 or any(
                not isinstance(entry, dict) or set(entry) != {'status', 'pending', 'uncertain'}
                or entry['status'] not in codes or any(type(entry[key]) is not int or not 0 <= entry[key] <= 1_000_000
                                                     for key in ('pending', 'uncertain')) for entry in friends)):
            raise ValueError('Invalid friend statuses.')
        details['friends'] = friends
    for key, value in (("dropped_at", dropped_at), ("skipped_at", skipped_at)):
        if value is None:
            continue
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be a time.")
        details[key] = value
    if skipped_kinds is not None:
        if (not isinstance(skipped_kinds, list) or len(skipped_kinds) > 12
                or any(not isinstance(kind, str) or not STATUS_CODE.fullmatch(kind) for kind in skipped_kinds)):
            raise ValueError("Invalid skipped message kinds.")
        details["skipped_kinds"] = skipped_kinds
    return details


def write_status(runtime, state, *, reason=None, private=None, group=None, pending=None, uncertain=None, groups=None,
                 dropped=None, dropped_at=None, skipped=None, skipped_at=None, skipped_kinds=None, friends=None):
    if state not in STATES:
        raise ValueError("Unknown listener state.")
    path = prepare_runtime(runtime) / STATUS_FILE
    details = _details(reason=reason, private=private, group=group, pending=pending, uncertain=uncertain, groups=groups,
                       dropped=dropped, dropped_at=dropped_at, skipped=skipped, skipped_at=skipped_at,
                       skipped_kinds=skipped_kinds, friends=friends)
    payload = {"state": state, "heartbeat_at": time.time(), "pid": os.getpid(),
               "group_policy_version": GROUP_POLICY_VERSION,
               "reply_target_binding_version": REPLY_TARGET_BINDING_VERSION, **details}
    _replace_private(path, (json.dumps(payload, separators=(",", ":")) + "\n").encode("ascii"), durable=False)
    return payload


def read_status(runtime, *, stale_after=30.0):
    if not isinstance(stale_after, (int, float)) or not math.isfinite(stale_after) or stale_after <= 0:
        raise ValueError("Status freshness must be a positive number of seconds.")
    root = prepare_runtime(runtime)
    paused = is_paused(root)
    inactive = {"state": "stopped", "heartbeat_at": None, "pid": None, "paused": paused,
                "stale": False, "group_policy_version": None, "reply_target_binding_version": None}
    try:
        handle = _open_private(root / STATUS_FILE, os.O_RDONLY)
    except FileNotFoundError:
        return inactive
    with os.fdopen(handle, "rb") as file:
        try:
            data = json.loads(file.read(4097))
            state = data["state"]
            heartbeat = data["heartbeat_at"]
            pid = data["pid"]
            version = data.get("group_policy_version")
            reply_target_version = data.get("reply_target_binding_version")
            if (state not in STATES or type(heartbeat) not in (int, float) or not math.isfinite(heartbeat)
                    or heartbeat <= 0 or type(pid) is not int or pid <= 0):
                raise ValueError("Invalid listener status.")
            details = _details(**{key: data.get(key) for key in ("reason", "private", "group", "pending", "uncertain", "groups",
                                                                 "dropped", "dropped_at", "skipped", "skipped_at",
                                                                 "skipped_kinds", 'friends')})
        except (TypeError, ValueError, KeyError, UnicodeError):
            return {**inactive, "state": "degraded", "reason": "status_invalid", "stale": True}
    age = time.time() - heartbeat
    return {"state": state, "heartbeat_at": heartbeat, "pid": pid, "paused": paused,
            "group_policy_version": version if type(version) is int and version > 0 else None,
            "reply_target_binding_version": reply_target_version if type(reply_target_version) is int and reply_target_version > 0 else None,
            "stale": state != "stopped" and not -1 <= age <= stale_after, **details}


def reply_target_binding_supported(status, *, minimum_version=1):
    return not status["stale"] and (status["state"] == "stopped"
        or (status.get("reply_target_binding_version") or 0) >= minimum_version)


def _absolute_path(path):
    path = Path(path).expanduser()
    if not path.is_absolute():
        raise ValueError("LaunchAgent paths must be absolute.")
    return str(path)


def launchd_plist(config, runtime, script, *, state=None, label="local.deskpet.wechat-listener"):
    if not isinstance(label, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", label):
        raise ValueError("Invalid LaunchAgent label.")
    runtime_path = Path(_absolute_path(runtime))
    script_path = Path(_absolute_path(script))
    state_path = runtime_path / "attempts.db" if state is None else Path(_absolute_path(state))
    return plistlib.dumps({
        "Label": label,
        "ProgramArguments": [
            _absolute_path(sys.executable), str(script_path), "--config", _absolute_path(config),
            "--state", str(state_path), "--runtime", str(runtime_path), "run",
        ],
        "WorkingDirectory": str(script_path.parent),
        "LimitLoadToSessionType": "Aqua",
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "Umask": 0o077,
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "en_US.UTF-8"},
        "StandardOutPath": str(runtime_path / "listener.stdout.log"),
        "StandardErrorPath": str(runtime_path / "listener.stderr.log"),
    })
