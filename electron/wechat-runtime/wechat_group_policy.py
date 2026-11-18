"""Local policy for deciding when the enrolled group receives a reply."""

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
import re
import time
import unicodedata
import uuid

from wechat_service import _open_private, _replace_private, prepare_runtime


MODES = ("mentions", "sender", "all", "off")
POLICY_FILE = "group-policy.json"
MAX_POLICY_BYTES = 2048
GROUPS_FILE = "groups.json"
MAX_GROUPS_BYTES = 262144
LEGACY_GROUP = "legacy"
GROUP_ID = re.compile(r"(?:legacy|[0-9a-f]{32})\Z")
FINGERPRINT = re.compile(r"[0-9a-f]{64}\Z")


@dataclass(frozen=True)
class GroupPolicy:
    mode: str
    sender: str | None
    revision: str

    def public(self):
        return {"mode": self.mode, "sender": self.sender}


@dataclass(frozen=True)
class BoundGroup:
    id: str
    title: str
    fingerprints: tuple[str, ...]


DEFAULT_GROUP_POLICY = GroupPolicy("mentions", None, "default")


@contextmanager
def group_policy_lock(runtime, *, wait=0.0):
    """Hold the binding lock; a caller that can wait retries until `wait` seconds have passed."""
    path = prepare_runtime(runtime) / "group-policy.lock"
    handle = _open_private(path, os.O_RDWR | os.O_CREAT)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)
        yield
    finally:
        os.close(handle)


def parse_policy(value):
    if not isinstance(value, dict) or set(value) != {"mode", "sender"} or value["mode"] not in MODES:
        raise ValueError("Invalid group policy.")
    mode, sender = value["mode"], value["sender"]
    if mode == "sender":
        if (not isinstance(sender, str) or not 1 <= len(sender) <= 80 or not sender.strip()
                or sender != sender.strip() or any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in sender)):
            raise ValueError("A valid exact group display name is required.")
        sender = unicodedata.normalize("NFC", sender)
    elif sender is not None:
        raise ValueError("A sender is only valid for sender mode.")
    return mode, sender


def private_json(path, limit, default):
    try:
        handle = _open_private(path, os.O_RDONLY)
    except FileNotFoundError:
        return default
    with os.fdopen(handle, "rb") as file:
        raw = file.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("Stored group settings exceed their size limit.")
    return json.loads(raw)


def policy_path(runtime, group_id):
    if not isinstance(group_id, str) or not GROUP_ID.fullmatch(group_id):
        raise ValueError("Invalid group identifier.")
    return prepare_runtime(runtime) / (POLICY_FILE if group_id == LEGACY_GROUP else f"group-policy-{group_id}.json")


def read_group_policy(runtime, group_id=LEGACY_GROUP):
    missing = object()
    data = private_json(policy_path(runtime, group_id), MAX_POLICY_BYTES, missing)
    if data is missing:
        return DEFAULT_GROUP_POLICY
    if not isinstance(data, dict) or set(data) != {"mode", "sender", "revision"}:
        raise ValueError("Invalid stored group policy.")
    revision = data.pop("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{32}", revision):
        raise ValueError("Invalid stored group policy revision.")
    return GroupPolicy(*parse_policy(data), revision)


def write_group_policy(runtime, value, group_id=LEGACY_GROUP):
    """Write policy while the caller owns the runtime's group policy lock."""
    mode, sender = parse_policy(value)
    try:
        previous = read_group_policy(runtime, group_id)
    except (OSError, ValueError):
        previous = None
    if previous is not None and (mode, sender) == (previous.mode, previous.sender):
        return previous
    policy = GroupPolicy(mode, sender, uuid.uuid4().hex)
    path = policy_path(runtime, group_id)
    data = json.dumps({**policy.public(), "revision": policy.revision}, ensure_ascii=False).encode("utf-8")
    _replace_private(path, data, durable=True)
    return policy


def parse_group_title(title):
    if (not isinstance(title, str) or not 1 <= len(title) <= 160 or not title.strip() or title != title.strip()
            or any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in title)):
        raise ValueError("Invalid group title.")
    return unicodedata.normalize("NFC", title)


def parse_fingerprints(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 15
            or not all(isinstance(item, str) and FINGERPRINT.fullmatch(item) for item in value)):
        raise ValueError("Invalid group avatar fingerprints.")
    return tuple(value)


def read_group_registry(runtime):
    data = private_json(prepare_runtime(runtime) / GROUPS_FILE, MAX_GROUPS_BYTES, {"legacy_removed": False, "groups": []})
    if (not isinstance(data, dict) or set(data) != {"legacy_removed", "groups"}
            or type(data["legacy_removed"]) is not bool or not isinstance(data["groups"], list)):
        raise ValueError("Invalid group registry.")
    groups = {}
    titles = set()
    for item in data["groups"]:
        if not isinstance(item, dict) or set(item) != {"id", "title", "fingerprints"}:
            raise ValueError("Invalid enrolled group.")
        group_id = item["id"]
        title = parse_group_title(item["title"])
        if (not isinstance(group_id, str) or group_id == LEGACY_GROUP or not GROUP_ID.fullmatch(group_id)
                or group_id in groups or title in titles):
            raise ValueError("Duplicate or invalid enrolled group.")
        groups[group_id] = BoundGroup(group_id, title, parse_fingerprints(item["fingerprints"]))
        titles.add(title)
    return data["legacy_removed"], groups


def write_group_registry(runtime, legacy_removed, groups):
    path = prepare_runtime(runtime) / GROUPS_FILE
    data = json.dumps({"legacy_removed": legacy_removed, "groups": [
        {"id": group.id, "title": group.title, "fingerprints": list(group.fingerprints)} for group in groups.values()
    ]}, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_GROUPS_BYTES:
        raise ValueError("Stored group settings exceed their size limit.")
    _replace_private(path, data, durable=True)
