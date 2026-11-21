"""Validate local reply preferences and available Ollama chat models."""

import hashlib
import json
import os
import re
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from wechat_service import _open_private, _replace_private, prepare_runtime


DEFAULT_REPLY = {"model": "qwen3.5:0.8b", "split": False, "stickers": False}
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}")
OLLAMA = "http://127.0.0.1:11434"
CLOUD_SETTINGS = "cloud-settings.json"
FRIEND_CLOUD_SETTINGS = "friend-cloud-settings.json"
CLOUD_GROUP_ID = re.compile(r"(?:legacy|[0-9a-f]{32})\Z")
FRIEND_ID = re.compile(r"[0-9a-f]{32}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def validate_reply_settings(value):
    if (not isinstance(value, dict) or set(value) != set(DEFAULT_REPLY)
            or not isinstance(value["model"], str) or not MODEL_NAME.fullmatch(value["model"])
            or type(value["split"]) is not bool or type(value["stickers"]) is not bool):
        raise ValueError("Invalid reply settings.")
    return value


def read_reply_settings(runtime):
    path = prepare_runtime(runtime) / "reply-settings.json"
    try:
        fd = _open_private(path, os.O_RDONLY)
    except FileNotFoundError:
        return DEFAULT_REPLY.copy()
    with os.fdopen(fd, "rb") as handle:
        data = handle.read(4097)
    if len(data) > 4096:
        raise ValueError("Reply settings exceed their size limit.")
    return validate_reply_settings(json.loads(data))


def read_cloud_route(runtime, target, group_id):
    """Return the selected route's fingerprint, or None for the isolated local model."""
    if target == "private" and group_id is None:
        scope = "private"
    elif target == "group" and isinstance(group_id, str) and CLOUD_GROUP_ID.fullmatch(group_id):
        scope = group_id
    elif target == 'friend' and isinstance(group_id, str) and FRIEND_ID.fullmatch(group_id):
        return read_friend_cloud_route(runtime, group_id)
    else:
        raise ValueError("Invalid cloud reply scope.")
    path = prepare_runtime(runtime) / CLOUD_SETTINGS
    try:
        fd = _open_private(path, os.O_RDONLY)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        raw = handle.read(16385)
    if len(raw) > 16384:
        raise ValueError("Cloud reply settings exceed their size limit.")
    data = json.loads(raw)
    if (not isinstance(data, dict) or set(data) not in ({"private", "groups"}, {"private", "groups", "destinations"})
            or not isinstance(data["groups"], dict) or len(data["groups"]) > 12
            or not all(CLOUD_GROUP_ID.fullmatch(key) for key in data["groups"])):
        raise ValueError("Invalid cloud reply settings.")
    destinations = data.get("destinations", {})
    if (not isinstance(destinations, dict) or len(destinations) > 13
            or any((key != "private" and not CLOUD_GROUP_ID.fullmatch(key))
                   or not isinstance(value, str) or not SHA256.fullmatch(value) for key, value in destinations.items())):
        raise ValueError("Invalid cloud reply destination pins.")
    route = data["private"] if target == "private" else data["groups"].get(group_id)
    if route is None and (target == "private" or group_id not in data["groups"]):
        if scope in destinations:
            raise ValueError("A cloud reply destination pin has no selected route.")
        return None
    return route_fingerprint(route, destinations.get(scope))


def read_friend_cloud_route(runtime, friend_id):
    try:
        fd = _open_private(prepare_runtime(runtime) / FRIEND_CLOUD_SETTINGS, os.O_RDONLY)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as handle:
        raw = handle.read(32_769)
    if len(raw) > 32_768:
        raise ValueError('Friend cloud reply settings exceed their size limit.')
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {'friends', 'destinations'}:
        raise ValueError('Invalid friend cloud settings.')
    routes, pins = data['friends'], data['destinations']
    if (not isinstance(routes, dict) or len(routes) > 20 or not all(FRIEND_ID.fullmatch(key) for key in routes)
            or not isinstance(pins, dict) or set(pins) != {'friend:' + key for key in routes}
            or any(not isinstance(value, str) or not SHA256.fullmatch(value) for value in pins.values())):
        raise ValueError('Invalid friend cloud settings.')
    return None if friend_id not in routes else route_fingerprint(routes[friend_id], pins['friend:' + friend_id])


def route_fingerprint(route, pin):
    keys = {"providerId", "model"}
    if (pin is None or not isinstance(route, dict)
            or set(route) != keys and (set(route) != keys | {"follow"} or route["follow"] is not True)
            or any(not isinstance(route[key], str) or not 1 <= len(route[key]) <= 240 or route[key] != route[key].strip()
                   or not route[key].isprintable() for key in keys)):
        raise ValueError("Invalid selected cloud reply route.")
    # Electron resolves the service default. The worker sends under the
    # configuration it authorized, using the original approval model as an anchor.
    parts = [route["providerId"], route["model"], pin]
    if route.get("follow") is True:
        parts.append(True)
    authority = json.dumps(parts, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(authority).hexdigest()


def ollama_json(path, value=None):
    data = json.dumps(value).encode() if value is not None else None
    request = Request(OLLAMA + path, data=data, headers={"Content-Type": "application/json"})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=3) as response:
        if response.url != request.full_url:
            raise ValueError("Unexpected Ollama response origin.")
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Ollama response exceeds its size limit.")
    return json.loads(raw)


def local_chat_model(model):
    try:
        metadata = ollama_json("/api/show", {"model": model, "verbose": False})
        return (metadata.get("details", {}).get("format") == "gguf"
                and bool(metadata.get("model_info", {}).get("general.architecture"))
                and "completion" in metadata.get("capabilities", ())
                and not metadata.get("remote_host") and not metadata.get("remote_model"))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def list_models():
    try:
        candidates = ollama_json("/api/tags").get("models", [])
    except (OSError, ValueError, TypeError, AttributeError):
        return []
    names = {
        entry.get("name") for entry in candidates[:32]
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
        and MODEL_NAME.fullmatch(entry["name"])
        and entry.get("details", {}).get("format") == "gguf"
        and not entry.get("remote_host") and not entry.get("remote_model")
    }
    return [name for name in sorted(names) if local_chat_model(name)]


def write_reply_settings(runtime, value):
    value = validate_reply_settings(value)
    if not local_chat_model(value["model"]):
        raise LookupError("Selected model is unavailable.")
    path = prepare_runtime(runtime) / "reply-settings.json"
    _replace_private(path, json.dumps(value, separators=(",", ":")).encode(), durable=True)
    return value
