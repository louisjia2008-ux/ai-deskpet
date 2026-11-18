"""Manage confirmed reply-only WeChat friend bindings."""

from dataclasses import asdict, dataclass, replace
import json
import re
import uuid

import vm_console as ui
from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_intake import DbIntake, DbScope
from wechat_group_policy import parse_fingerprints, parse_group_title, private_json
from wechat_service import _replace_private, prepare_runtime
from wechat_state import binding_key


FRIEND_ID = re.compile(r"[a-f0-9]{32}\Z")
FRIEND_ROSTER_ID = re.compile(r"[a-f0-9]{64}\Z")
MAX_FRIENDS = 20
MAX_ROSTER = 250
FRIENDS_FILE = "reply-friends.json"
MAX_FRIENDS_BYTES = 65_536


@dataclass(frozen=True)
class BoundFriend:
    id: str
    conversation: str
    title: str
    fingerprints: tuple[str, ...]

    def public(self):
        return {"id": self.id, "title": self.title}


def friend_registry(runtime, owner_binding):
    path = prepare_runtime(runtime) / FRIENDS_FILE
    missing = object()
    saved = private_json(path, MAX_FRIENDS_BYTES, missing)
    if saved is missing:
        return {}
    if (not isinstance(saved, dict) or set(saved) != {"owner", "friends"}
            or not isinstance(saved["owner"], str) or not FRIEND_ROSTER_ID.fullmatch(saved["owner"])
            or not isinstance(saved["friends"], list) or len(saved["friends"]) > MAX_FRIENDS):
        raise ValueError("Invalid friend registry.")
    if saved["owner"] != owner_binding:
        return {}
    friends, conversations, titles = {}, set(), set()
    for item in saved["friends"]:
        if not isinstance(item, dict) or set(item) != {"id", "conversation", "title", "fingerprints"}:
            raise ValueError("Invalid friend binding.")
        friend_id, conversation = item["id"], item["conversation"]
        title = parse_group_title(item["title"])
        normalized = ui.normalize(title)
        if (not isinstance(friend_id, str) or not FRIEND_ID.fullmatch(friend_id) or friend_id in friends
                or not isinstance(conversation, str) or not FRIEND_ROSTER_ID.fullmatch(conversation)
                or conversation in conversations or normalized in titles):
            raise ValueError("Duplicate or invalid friend binding.")
        friends[friend_id] = BoundFriend(friend_id, conversation, title, parse_fingerprints(item["fingerprints"]))
        conversations.add(conversation)
        titles.add(normalized)
    return friends


def write_friend_registry(runtime, owner_binding, friends):
    data = json.dumps({"owner": owner_binding, "friends": [asdict(friend) for friend in friends.values()]},
                      ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_FRIENDS_BYTES:
        raise ValueError("Friend registry is too large.")
    _replace_private(prepare_runtime(runtime) / FRIENDS_FILE, data, durable=True)


def enrolled_friends(settings, runtime, owner=None):
    from wechat_listener import owner_record, private_binding_key

    if owner is None:
        owner = owner_record(settings, runtime)
    return friend_registry(runtime, private_binding_key(settings, owner))


def friend_binding_key(settings, owner, friend):
    return binding_key(settings["account_name"], "friend", friend.title, f'{owner["fingerprint"]}:{friend.id}')


def settings_for_friend(settings, friend):
    return {**settings, "targets": {**settings["targets"], "private": {"title": friend.title}}, "_bound_friend": friend}


def verify_friend(settings, path, *, window=None):
    """Passively verify the current WeChat window, header, and selected avatar."""
    if window is None:
        window = ui.active_window_id()
    if (settings.get("_bound_friend") is None or ui.active_window_id() != window
            or not ui.verify_title(settings, path, "private") or ui.active_window_id() != window):
        raise ui.DiagnosticTestError("好友私聊与绑定的窗口、标题或头像不符。", code="send_friend_binding_mismatch")
    return window


def roster_authority(state, settings, runtime):
    from wechat_listener import owner_record, private_binding_key

    owner = owner_record(settings, runtime)
    binding = private_binding_key(settings, owner)
    private = DbIntake.pins(state).get(binding)
    if (private is None or private.target != "private" or private.retired
            or private.owner_fingerprint != owner["fingerprint"]):
        raise DatabaseUnavailable("friend_unverified")
    return owner, binding, private


def read_roster(reader, private):
    result = reader.read({"op": "friend_list", "account_id": private.account_id, "owner_id": private.conversation_id})
    if (result.get("account_id") != private.account_id or not isinstance(result.get("friends"), list)
            or len(result["friends"]) > MAX_ROSTER):
        raise DatabaseUnavailable("friend_unverified")
    for row in result["friends"]:
        if (not isinstance(row, dict) or set(row) != {"id", "title"} or not isinstance(row["id"], str)
                or not FRIEND_ROSTER_ID.fullmatch(row["id"])):
            raise DatabaseUnavailable("friend_unverified")
        parse_group_title(row["title"])
    return result["friends"]


def reply_friend_roster(state, settings, runtime, *, reader=None):
    _, binding, private = roster_authority(state, settings, runtime)
    enrolled = {friend.conversation for friend in friend_registry(runtime, binding).values()}
    return [row for row in read_roster(reader or DatabaseReader(), private) if row["id"] not in enrolled]


def bind_reply_friend(state, settings, path, runtime, roster_id, *, reader=None):
    from wechat_listener import owner_profile

    owner, owner_binding, private = roster_authority(state, settings, runtime)
    friends = friend_registry(runtime, owner_binding)
    if len(friends) >= MAX_FRIENDS:
        raise OverflowError("Friend enrollment is full.")
    reader = reader or DatabaseReader()
    roster = read_roster(reader, private)
    choices = [row for row in roster if row["id"] == roster_id]
    if len(choices) != 1 or any(friend.conversation == roster_id for friend in friends.values()):
        raise ui.DiagnosticTestError("选中的好友已不在可添加列表中。", code="friend_not_found")
    exact_title = choices[0]["title"]
    title = parse_group_title(exact_title)
    normalized = ui.normalize(title)
    if (sum(ui.normalize(row["title"]) == normalized for row in roster) != 1
            or any(ui.normalize(friend.title) == normalized for friend in friends.values())):
        raise ui.DiagnosticTestError("存在同名微信好友，请先区分联系人名称。", code="friend_title_ambiguous")
    selected = {**settings, "targets": {**settings["targets"], "private": {"title": title}}}
    ui.open_target(selected, path, "private", search_only=True)
    window = ui.active_window_id()
    ui.capture_wechat(selected, path)
    header = ui.points(selected["ocr"], path, selected["header"])
    fingerprints = ui.active_friend_avatars(selected, path, header)
    if not fingerprints or ui.active_window_id() != window:
        raise ui.DiagnosticTestError("无法核对选中好友的原生标题或头像。", code="friend_unverified")
    _, identifier = owner_profile(selected, path)
    proof = reader.read({"op": "friend_verify", "account_id": private.account_id,
                         "owner_id": private.conversation_id, "friend_id": roster_id,
                         "title": exact_title, "alias": identifier})
    if (proof.get("account_id") != private.account_id
            or proof.get("friend") != {"id": roster_id, "title": exact_title}):
        raise ui.DiagnosticTestError("资料卡与选中的好友会话不符。", code="friend_conversation_mismatch")
    friend = BoundFriend(uuid.uuid4().hex, roster_id, title, parse_fingerprints(list(fingerprints)))
    verify_friend(settings_for_friend(settings, friend), path, window=window)
    binding = friend_binding_key(settings, owner, friend)
    intake = DbIntake(state, private.account_id, owner["fingerprint"], (
        DbScope(owner_binding, "private", private.conversation_id),
        DbScope(binding, "friend", friend.conversation, display_name=title),
    ))
    active = {friend_binding_key(settings, owner, previous) for previous in friends.values()}
    intake.enroll(retired_bindings={key for key, saved in DbIntake.pins(state).items()
                                  if saved.target == "friend" and key not in active and key != binding})
    request = intake.request_friend(binding)
    if request.get("baseline") is not True:
        raise ValueError("A new friend requires a fresh database cursor.")
    intake.apply(request, reader.read(request))
    friends[friend.id] = friend
    write_friend_registry(runtime, owner_binding, friends)
    return friend


def remove_reply_friend(state, settings, runtime, friend_id):
    from wechat_listener import owner_record, private_binding_key

    owner = owner_record(settings, runtime)
    owner_binding = private_binding_key(settings, owner)
    friends = friend_registry(runtime, owner_binding)
    if (friend := friends.pop(friend_id, None)) is None:
        raise ui.DiagnosticTestError("没有找到已绑定的好友。", code="friend_not_found")
    binding = friend_binding_key(settings, owner, friend)
    saved = state.database_pins()
    pin = DbIntake.pins(state).get(binding)
    if pin is not None and not pin.retired:
        state.pin_database_bindings(saved, {binding: asdict(replace(pin, retired=True))})
    for event in state.pending(binding):
        state.skip(event.id)
    state.recover_attempted(binding)
    for event in state.uncertain(binding):
        state.give_up(event.id, "friend_unbound")
    write_friend_registry(runtime, owner_binding, friends)
