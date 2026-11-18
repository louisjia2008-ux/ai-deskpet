"""Control read-only discovery and bounded reads for cached official account articles."""

import json
import sys

from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_guest import MAX_OFFICIAL_ACCOUNTS, OPAQUE_ID
from wechat_db_intake import DbIntake
from wechat_service import is_paused
from wechat_state import WeChatState


MAX_REQUEST = 24_576


def verified_owner_pin(settings, runtime, database, *, unavailable="official_scope_unverified"):
    from wechat_listener import owner_record, private_binding_key

    owner = owner_record(settings, runtime)
    binding = private_binding_key(settings, owner)
    with WeChatState(database, read_only=True) as state:
        pinned = DbIntake.pins(state).get(binding)
    if (pinned is None or pinned.target != "private" or pinned.retired
            or pinned.owner_fingerprint != owner["fingerprint"]):
        raise DatabaseUnavailable(unavailable)
    return binding, pinned


def read_official_sources(action, settings, runtime, database, value=None, reader=None):
    binding, owner = verified_owner_pin(settings, runtime, database)
    request = {"account_id": owner.account_id, "owner_id": owner.conversation_id}
    if action == "official-list":
        request["op"] = "official_list"
    elif action == "official-read":
        if (not isinstance(value, dict) or set(value) != {"binding", "ids", "until"}
                or value["binding"] != binding or type(value["until"]) is not int or is_paused(runtime)):
            raise DatabaseUnavailable("official_scope_changed")
        ids = value["ids"]
        if ids is not None and (not isinstance(ids, list) or len(ids) > MAX_OFFICIAL_ACCOUNTS
                                or not all(isinstance(item, str) and OPAQUE_ID.fullmatch(item) for item in ids)
                                or len(set(ids)) != len(ids)):
            raise DatabaseUnavailable("official_scope_changed")
        request.update(op="official_read", ids=ids, until=value["until"])
    else:
        raise DatabaseUnavailable("official_scope_changed")
    result = (reader or DatabaseReader()).read(request)
    if result.get("account_id") != owner.account_id or verified_owner_pin(settings, runtime, database) != (binding, owner):
        raise DatabaseUnavailable("official_scope_changed")
    if action == "official-list":
        return {"accounts": result["accounts"]}
    if is_paused(runtime):
        raise DatabaseUnavailable("official_scope_changed")
    return {key: result[key] for key in ("articles", "truncated")}


def official_source_control(action, settings, runtime, database):
    value = None
    if action == "official-read":
        body = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(body) > MAX_REQUEST:
            raise DatabaseUnavailable("official_scope_changed")
        value = json.loads(body)
    result = read_official_sources(action, settings, runtime, database, value)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
