"""Authorize group digest reads from current account pins, never from a send route."""

import json
import re
import sys

from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_guest import digest_group_id
from wechat_db_intake import DbIntake
from wechat_group_policy import group_policy_lock, private_json
from wechat_service import _replace_private, is_paused, prepare_runtime
from wechat_state import WeChatState


SELECTION_FILE = "group-digest-sources.json"
MAX_SELECTIONS = 12
MAX_REQUEST = 4_096
HASH = re.compile(r"[a-f0-9]{64}\Z")
LOCK_WAIT = 20


def valid_id(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def validate_selection(value):
    if (not isinstance(value, dict) or set(value) != {"binding", "ids"} or not valid_id(value["binding"])
            or not isinstance(value["ids"], list) or len(value["ids"]) > MAX_SELECTIONS
            or not all(valid_id(item) for item in value["ids"]) or len(set(value["ids"])) != len(value["ids"])):
        raise DatabaseUnavailable("digest_scope_changed")
    return value


def selection_path(runtime):
    return prepare_runtime(runtime) / SELECTION_FILE


def read_selection(runtime):
    missing = object()
    value = private_json(selection_path(runtime), MAX_REQUEST, missing)
    return None if value is missing else validate_selection(value)


def is_digest_group(runtime, account_id, conversation):
    selected = read_selection(runtime)
    return selected is not None and digest_group_id(account_id, conversation) in selected["ids"]


def request(value, action):
    if action == "digest-group-select":
        return validate_selection(value)
    if (not isinstance(value, dict) or set(value) != {"binding", "id", "until"}
            or not valid_id(value["binding"]) or not valid_id(value["id"]) or type(value["until"]) is not int):
        raise DatabaseUnavailable("digest_scope_changed")
    return value


def current_pins(state, settings, runtime):
    from wechat_listener import enrolled_bindings, owner_record

    owner = owner_record(settings, runtime)
    bindings = enrolled_bindings(settings, runtime)
    pins = DbIntake.pins(state)
    private = pins.get(bindings["private"])
    if (private is None or private.target != "private" or private.retired
            or private.owner_fingerprint != owner["fingerprint"]):
        raise DatabaseUnavailable("digest_scope_unverified")
    reply_groups = []
    for group, binding in bindings.items():
        if group == "private":
            continue
        pin = pins.get(binding)
        if (pin is None or pin.target != "group" or pin.retired or pin.account_id != private.account_id
                or pin.owner_fingerprint != private.owner_fingerprint):
            raise DatabaseUnavailable("digest_scope_unverified")
        reply_groups.append(pin.conversation_id)
    return bindings["private"], private, reply_groups


def digest_groups(action, settings, runtime, database, value=None, reader=None):
    if action not in {"digest-group-list", "digest-group-select", "digest-group-read"}:
        raise DatabaseUnavailable("digest_scope_changed")
    # The listener holds this lock for each database poll, every few seconds, so a scheduled read waits its turn.
    with group_policy_lock(runtime, wait=LOCK_WAIT), WeChatState(database, read_only=True) as state:
        binding, private, reply_groups = current_pins(state, settings, runtime)
        if action != "digest-group-list":
            value = request(value, action)
            if value["binding"] != binding:
                raise DatabaseUnavailable("digest_scope_changed")
        base = {"account_id": private.account_id, "owner_id": private.conversation_id, "group_ids": reply_groups}
        if action == "digest-group-read":
            selected = read_selection(runtime)
            if (is_paused(runtime) or not selected or selected["binding"] != binding
                    or value["id"] not in selected["ids"]):
                raise DatabaseUnavailable("digest_scope_changed")
            operation = base | {"op": "digest_group_read", "id": value["id"], "until": value["until"]}
        else:
            operation = base | {"op": "digest_group_list"}
        reader = reader or DatabaseReader()
        if action == "digest-group-select" and not value["ids"]:
            result = {"account_id": private.account_id, "groups": []}
        else:
            result = reader.read(operation)
        if result.get("account_id") != private.account_id:
            raise DatabaseUnavailable("digest_scope_changed")
        if action == "digest-group-read":
            return {key: result[key] for key in ("rows", "truncated")}
        roster = result["groups"]
        if action == "digest-group-list":
            return {"groups": roster}
        if not set(value["ids"]) <= {group["id"] for group in roster}:
            raise DatabaseUnavailable("digest_scope_changed")
        _replace_private(selection_path(runtime), json.dumps(value, separators=(",", ":")).encode("ascii"), durable=True)
        return {"ok": True}


def digest_group_control(action, settings, runtime, database):
    value = None
    if action != "digest-group-list":
        source = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(source) > MAX_REQUEST:
            raise DatabaseUnavailable("digest_scope_changed")
        value = json.loads(source)
    result = digest_groups(action, settings, runtime, database, value)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
