"""Read cached friend Moments without interacting with the official client."""

import json
import sys

from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_official_digest import verified_owner_pin
from wechat_service import is_paused


MAX_REQUEST = 1_024


def read_friends_moments(settings, runtime, database, value, reader=None):
    if (not isinstance(value, dict) or set(value) != {"binding", "until", "days"}
            or type(value["until"]) is not int or type(value["days"]) is not int or value["days"] not in (1, 7)
            or is_paused(runtime)):
        raise DatabaseUnavailable("moments_scope_changed")
    binding, owner = verified_owner_pin(settings, runtime, database, unavailable="moments_scope_unverified")
    if value["binding"] != binding:
        raise DatabaseUnavailable("moments_scope_changed")
    request = {"op": "friends_moments_read", "account_id": owner.account_id, "owner_id": owner.conversation_id,
               "until": value["until"], "days": value["days"]}
    result = (reader or DatabaseReader()).read(request)
    if (result.get("account_id") != owner.account_id or is_paused(runtime)
            or verified_owner_pin(settings, runtime, database, unavailable="moments_scope_unverified") != (binding, owner)):
        raise DatabaseUnavailable("moments_scope_changed")
    return {key: result[key] for key in ("posts", "truncated")}


def friends_moments_control(settings, runtime, database):
    source = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(source) > MAX_REQUEST:
        raise DatabaseUnavailable("moments_scope_changed")
    result = read_friends_moments(settings, runtime, database, json.loads(source))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
