"""Apply verified guest database observations without taking over WeChat sends."""

from dataclasses import asdict, dataclass, replace
from hashlib import sha256
import json
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from xml.etree import ElementTree

from wechat_group_policy import GroupPolicy
from wechat_rich_message import (
    FORWARD_TYPE, forward_card_key, forward_owner_command, parse_rich_message, quote_forward_reference,
    quote_save_command, rich_display_text, valid_quote_excerpt, valid_rich,
)
from wechat_state import Occurrence, QUEUE_COMMANDS, StateConflict, WeChatState


_HASH = re.compile(r"[0-9a-f]{64}\Z")
_GENERATION = re.compile(r"[0-9a-f]{32}\Z")
_USER = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")
_GROUP = re.compile(r"[A-Za-z0-9_.-]{1,128}@chatroom\Z")
_SHARD = re.compile(r"message_[0-9]{1,5}\.db\Z")
_SERVER = re.compile(r"(?:0|[1-9][0-9]{0,19})\Z")
_PRIVATE_REVISION = "private"
_FRIEND_REVISION = "friend"
_MAX_GROUPS = 12
_MAX_FRIENDS = 20
_MAX_SCOPES = 1 + _MAX_GROUPS + _MAX_FRIENDS
_MAX_SHARDS = 64
_MAX_INTEGER = 2**63 - 1
_MAX_SERVER_ID = 2**64 - 1
_MAX_QUEUE = 6
_MAX_CONTROLS = 32
_TEXT_TYPE = 1
OWNER_PLAIN_TEXT_LIMIT = 1_000
_VOICE_TYPE = 34
_ARTICLE_TYPE = 49
_ARTICLE_SUBTYPE = 5
_ARTICLE_TYPES = {_ARTICLE_TYPE, (_ARTICLE_SUBTYPE << 32) | _ARTICLE_TYPE}
_QUOTE_SUBTYPE = 57
_QUOTE_TYPES = {_ARTICLE_TYPE, (_QUOTE_SUBTYPE << 32) | _ARTICLE_TYPE}
_ARTICLE_HOST = "mp.weixin.qq.com"
_ARTICLE_SHORT_PATH = re.compile(r"/s/[A-Za-z0-9_-]{10,80}\Z")
_ARTICLE_FIELDS = {"__biz", "mid", "idx", "sn"}
_ARTICLE_PUBLIC_FIELDS = _ARTICLE_FIELDS | {"chksm"}
_ARTICLE_FIELD_VALUE = re.compile(r"[A-Za-z0-9_+/=\-]{1,160}\Z")
_SKIPPED_KINDS = {1: "text", 3: "image", 34: "voice", 42: "card", 43: "video", 47: "sticker", 48: "location",
                  50: "call", 10000: "system", 10002: "recall"}
_SKIPPED_CARDS = {5: "link", 6: "file", 19: "forward", 33: "miniprogram", 36: "miniprogram", 57: "quote",
                  2000: "transfer", 2001: "redpacket"}
# Admitted in place of a voice message the local listener could not make out.
VOICE_UNHEARD = "[没听清的语音]"


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _integer(value, low=0, high=_MAX_INTEGER):
    return type(value) is int and low <= value <= high


@dataclass(frozen=True)
class DbPin:
    account_id: str
    owner_fingerprint: str
    target: str
    conversation_id: str
    sender_id: str | None = None
    sender_revision: str | None = None
    retired: bool = False

    def identity(self):
        return self.account_id, self.owner_fingerprint, self.target, self.conversation_id


@dataclass(frozen=True)
class DbScope:
    binding: str
    target: str
    conversation_id: str
    policy: GroupPolicy | None = None
    sender_id: str | None = None
    display_name: str | None = None

    @property
    def revision(self):
        if self.target == "friend":
            return _FRIEND_REVISION
        return _PRIVATE_REVISION if self.policy is None else self.policy.revision


@dataclass(frozen=True)
class DbIntakeResult:
    statuses: dict[str, str]
    has_more: bool
    baselined: tuple[str, ...]


def _verified_pin(pin):
    if not isinstance(pin.target, str):
        return False
    pattern = {"group": _GROUP, "friend": _HASH, "private": _USER}.get(pin.target)
    return (pattern is not None and _matches(_USER, pin.account_id)
            and _matches(_HASH, pin.owner_fingerprint) and _matches(pattern, pin.conversation_id)
            and pin.conversation_id != pin.account_id
            and type(pin.retired) is bool and (not pin.retired or pin.target != "private")
            and (pin.sender_id is None and pin.sender_revision is None
                 or pin.target == "group" and _matches(_USER, pin.sender_id) and pin.sender_id != pin.account_id
                 and isinstance(pin.sender_revision, str) and 0 < len(pin.sender_revision) <= 80))


def _authorized_sender(scope, account_id, sender_id, mentioned):
    if not _matches(_USER, sender_id) or sender_id == account_id:
        return False
    if scope.target in ("private", "friend"):
        return sender_id == scope.conversation_id
    if scope.policy.mode == "mentions":
        return mentioned
    if scope.policy.mode == "sender":
        return sender_id == scope.sender_id
    return scope.policy.mode == "all"


def _is_voice(scope, message_type):
    return scope.target in ("private", "friend") and type(message_type) is int and message_type & 0xFFFFFFFF == _VOICE_TYPE


def _canonical_article_url(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (not value.lower().startswith(("http://", "https://"))
            or any(not character.isprintable() or character.isspace() for character in value)):
        return None
    try:
        url = urlsplit(value)
        if url.scheme not in ("http", "https") or url.netloc.lower() != _ARTICLE_HOST:
            return None
        if _ARTICLE_SHORT_PATH.fullmatch(url.path):
            return urlunsplit(("https", _ARTICLE_HOST, url.path, "", ""))
        if url.path not in ("/s", "/s/"):
            return None
        params = [(name, item) for name, item in parse_qsl(url.query, keep_blank_values=True, max_num_fields=80)
                  if name in _ARTICLE_PUBLIC_FIELDS]
        keys = {name for name, _ in params}
        if (not _ARTICLE_FIELDS <= keys or len(keys) != len(params)
                or any(not _ARTICLE_FIELD_VALUE.fullmatch(item) for _, item in params)):
            return None
        canonical = urlunsplit(("https", _ARTICLE_HOST, "/s", urlencode(params), ""))
        return canonical if len(canonical) <= 500 else None
    except ValueError:
        return None


def _article_label(value, limit):
    # Count UTF-16 units so a supplementary character cannot exceed the socket limit.
    label = " ".join("".join(char if char.isprintable() and unicodedata.category(char)[0] != "C" else " "
                            for char in value).split())
    return label.encode("utf-16-le")[:limit * 2].decode("utf-16-le", errors="ignore").rstrip()


def _article_from_xml(body):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", body, re.IGNORECASE):
        return None
    try:
        root = ElementTree.fromstring(body.lstrip())
    except (ElementTree.ParseError, UnicodeError, ValueError):
        return None
    cards = root.findall("appmsg") if root.tag == "msg" else []
    if len(cards) != 1:
        return None
    card = cards[0]
    types, urls = card.findall("type"), card.findall("url")
    if len(types) != 1 or types[0].text != str(_ARTICLE_SUBTYPE) or len(urls) != 1:
        return None
    url = _canonical_article_url(urls[0].text)
    if url is None:
        return None
    return {"url": url, "title": _article_label(card.findtext("title", ""), 160) or "公众号文章",
            "account": _article_label(card.findtext("sourcedisplayname", ""), 80)}


def skipped_kind(message_type):
    """A coarse label for an owner message the listener could not answer; never its content."""
    kind, subtype = message_type & 0xFFFFFFFF, message_type >> 32
    if kind == _ARTICLE_TYPE:
        return _SKIPPED_CARDS.get(subtype, "card")
    return _SKIPPED_KINDS.get(kind, "other")


def valid_article(value):
    return (isinstance(value, dict) and set(value) == {"url", "title", "account"}
            and isinstance(value["url"], str) and len(value["url"]) <= 500
            and _canonical_article_url(value["url"]) == value["url"]
            and isinstance(value["title"], str) and bool(value["title"])
            and _article_label(value["title"], 160) == value["title"]
            and isinstance(value["account"], str) and _article_label(value["account"], 80) == value["account"])


def _row_identity(binding, row):
    source = ("server", row["server_id"]) if row["server_id"] != "0" else (
        "local", row["database"], row["generation"], row["local_id"],
    )
    return sha256(json.dumps(["wechat-db", binding, *source], separators=(",", ":")).encode("ascii")).hexdigest()


def _parse_cursors(value, conversations):
    if not isinstance(value, dict) or not value or len(value) > _MAX_SCOPES * _MAX_SHARDS:
        raise ValueError("Invalid database cursor inventory.")
    inventory = {conversation: {} for conversation in conversations}
    for name, position in value.items():
        if not isinstance(name, str) or name.count("/") != 1:
            raise ValueError("Invalid database cursor key.")
        shard, conversation = name.split("/")
        if (not _matches(_SHARD, shard) or conversation not in inventory or not isinstance(position, dict)
                or set(position) != {"generation", "local_id"} or not _matches(_GENERATION, position["generation"])
                or not _integer(position["local_id"])):
            raise ValueError("Invalid database cursor.")
        inventory[conversation][name] = position
    if value:
        shards = {name.split("/")[0]: position["generation"] for name, position in value.items()}
        if (len(shards) > _MAX_SHARDS or any(
            {name.split("/")[0]: position["generation"] for name, position in positions.items()} != shards
            for positions in inventory.values()
        )):
            raise ValueError("Incomplete database cursor inventory.")
    return inventory


def _validate_row(row, account_id, cursors, *, beyond_cursor=False):
    required = {"conversation_id", "sender_id", "local_id", "server_id", "database",
                "created_at", "type", "body", "native_mention_self", "mention_ids"}
    allowed = required | {"raw_body", "sender_display_name", "body_available", "transcript"}
    if not isinstance(row, dict) or not required <= row.keys() <= allowed:
        raise ValueError("Invalid database message shape.")
    conversation, sender = row["conversation_id"], row["sender_id"]
    shard, mentions = row["database"], row["mention_ids"]
    if (not isinstance(conversation, str) or not _matches(_SHARD, shard)
            or (sender != "" and not _matches(_USER, sender))
            or not _integer(row["local_id"], 1) or not _matches(_SERVER, row["server_id"])
            or int(row["server_id"]) > _MAX_SERVER_ID or not _integer(row["created_at"], high=2**53 - 1)
            or not _integer(row["type"]) or type(row["native_mention_self"]) is not bool
            or not isinstance(mentions, list) or len(mentions) > 1000
            or any(not _matches(_USER, name) and name != "notify@all" for name in mentions)
            or row["native_mention_self"] != (account_id in mentions)
            or type(row.get("body_available", True)) is not bool
            or any(not isinstance(row[name], str) or len(row[name]) > 65_536
                   for name in ("body", "raw_body", "sender_display_name") if name in row)
            or ("transcript" in row and (not isinstance(row["transcript"], str) or len(row["transcript"]) > 500))):
        raise ValueError("Invalid database message.")
    key = f"{shard}/{conversation}"
    position = cursors.get(key)
    if position is None or (not beyond_cursor and row["local_id"] > position["local_id"]):
        raise ValueError("Database message is outside its cursor inventory.")
    return key


class DbIntake:
    """Bridge a pinned official-client account into the existing reply ledger.

    Construct only from a current, verified owner fingerprint and enrolled
    binding IDs. A UI name is a hint for an existing binding, never identity.
    """

    def __init__(self, state: WeChatState, account_id: str, owner_fingerprint: str, scopes):
        self.state = state
        self.account_id = account_id
        self.owner_fingerprint = owner_fingerprint
        scopes = tuple(scopes)
        self.scopes = {scope.binding: scope for scope in scopes}
        private = [scope for scope in self.scopes.values() if scope.target == "private"]
        if (len(private) != 1 or len(self.scopes) != len(scopes) or len(self.scopes) > _MAX_SCOPES
                or sum(scope.target == "group" for scope in scopes) > _MAX_GROUPS
                or sum(scope.target == "friend" for scope in scopes) > _MAX_FRIENDS
                or len(set(scope.conversation_id for scope in self.scopes.values())) != len(self.scopes)):
            raise ValueError("Invalid database binding set.")
        for scope in self.scopes.values():
            self._check_scope(scope)
        self.owner = private[0]

    @staticmethod
    def pins(state: WeChatState) -> dict[str, DbPin]:
        """Return stored stable IDs, with an empty result for an older database."""
        return DbIntake._decode_pins(state.database_pins())

    @staticmethod
    def _decode_pins(raw):
        pins = {binding: DbPin(**value) for binding, value in raw.items()}
        if any(not _matches(_HASH, binding) or not _verified_pin(pin) for binding, pin in pins.items()):
            raise ValueError("Invalid persisted database binding.")
        return pins

    def _check_scope(self, scope):
        if (not _matches(_HASH, scope.binding) or not _verified_pin(self._pin(scope))
                or (scope.target != "group") != (scope.policy is None)
                or (scope.policy is not None and (scope.policy.mode not in ("off", "mentions", "sender", "all")
                    or not isinstance(scope.policy.revision, str) or not 0 < len(scope.policy.revision) <= 80
                    or (scope.sender_id is not None and scope.policy.mode != "sender")))):
            raise ValueError("Invalid database scope.")

    def _pin(self, scope):
        return DbPin(self.account_id, self.owner_fingerprint, scope.target, scope.conversation_id,
                     scope.sender_id, scope.revision if scope.sender_id is not None else None)

    def enroll(self, *, retired_bindings=()):
        """Persist attested IDs; the owner pin cannot be retired or reassigned."""
        saved = self.state.database_pins()
        pins = self._decode_pins(saved)
        retired = frozenset(retired_bindings)
        if (retired.intersection(self.scopes)
                or any(not _matches(_HASH, binding) or binding not in pins or pins[binding].target == "private"
                       for binding in retired)):
            raise ValueError("Invalid retired database bindings.")
        updated = {}
        for scope in self.scopes.values():
            pin = self._pin(scope)
            prior = pins.get(scope.binding)
            if prior is not None and (prior.retired or prior.identity() != pin.identity()
                    or pin.sender_revision is not None and pin.sender_revision == prior.sender_revision
                    and pin.sender_id != prior.sender_id):
                raise StateConflict("A database binding cannot be reassigned.")
            for other, value in pins.items():
                if other == scope.binding or value.retired or value.identity() != pin.identity():
                    continue
                if other not in retired:
                    raise StateConflict("A database conversation already has a binding.")
                updated[other] = asdict(replace(value, retired=True))
            if prior is None or pin.sender_id is not None and prior != pin:
                updated[scope.binding] = asdict(pin)
        self.state.pin_database_bindings(saved, updated)

    def _active(self):
        saved = self.state.database_pins()
        pins = self._decode_pins(saved)
        statuses, active, baselines = {}, {}, {}
        for binding, scope in self.scopes.items():
            pin = pins.get(binding)
            if pin is None or pin.retired or pin.identity() != self._pin(scope).identity():
                statuses[binding] = "database_unbound"
                continue
            if (scope.policy is not None and scope.policy.mode == "sender"
                    and (scope.sender_id is None or pin.sender_revision != scope.revision or pin.sender_id != scope.sender_id)):
                statuses[binding] = "database_sender_unverified"
                continue
            current = self.state.database_cursor(binding)
            statuses[binding] = "off" if scope.policy is not None and scope.policy.mode == "off" else "ready"
            if current is None or current[0] != scope.revision:
                baselines[binding] = (scope, saved[binding], current)
            elif statuses[binding] != "off":
                active[binding] = (scope, saved[binding], current)
        return statuses, active, baselines

    def _request(self, limit, *, friend_binding=None):
        if not _integer(limit, 1, 100):
            raise ValueError("Invalid database intake limit.")
        statuses, active, baselines = self._active()
        if self.owner.binding not in active and self.owner.binding not in baselines:
            raise StateConflict("The owner database binding is unavailable.")
        request = {"account_id": self.account_id, "owner_id": self.owner.conversation_id, "limit": limit}
        if friend_binding is not None:
            scope = self.scopes.get(friend_binding)
            if scope is None or scope.target != "friend" or (friend_binding not in baselines and friend_binding not in active):
                raise StateConflict("The friend database binding is unavailable.")
            selected = {friend_binding: baselines.get(friend_binding) or active[friend_binding]}
            statuses = {friend_binding: statuses[friend_binding]}
            request.update(op="friend_poll", friend_id=scope.conversation_id)
        else:
            selected = {binding: item for binding, item in baselines.items() if item[0].target != "friend"} or {
                binding: item for binding, item in active.items() if item[0].target != "friend"}
            request.update(op="poll", group_ids=sorted(scope.conversation_id for scope, _, _ in selected.values()
                                                       if scope.target == "group"))
            statuses = {binding: status for binding, status in statuses.items() if self.scopes[binding].target != "friend"}
        if any(binding in baselines for binding in selected):
            request["baseline"] = True
        else:
            request["cursors"] = {name: cursor for _, _, current in selected.values()
                                  for name, cursor in current[1].items()}
        return request, statuses, selected

    def request(self, limit=100):
        return self._request(limit)[0]

    def request_friend(self, binding, limit=100):
        return self._request(limit, friend_binding=binding)[0]

    def apply(self, request, response):
        friend_binding = None
        if request.get("op") == "friend_poll":
            friend_binding = next((scope.binding for scope in self.scopes.values()
                                   if scope.target == "friend" and scope.conversation_id == request.get("friend_id")), None)
            if friend_binding is None:
                raise StateConflict("The friend database binding is unavailable.")
        expected_request, statuses, selected = self._request(request["limit"], friend_binding=friend_binding)
        if request != expected_request:
            raise StateConflict("Database intake request is stale.")
        fields = {"ok", "account_id", "rows", "cursors", "has_more"}
        if (not isinstance(response, dict) or not fields <= response.keys() <= fields | {"controls"}
                or response["ok"] is not True or response["account_id"] != self.account_id
                or not isinstance(response["rows"], list) or len(response["rows"]) > request["limit"]
                or not isinstance(response.get("controls", []), list) or len(response.get("controls", [])) > _MAX_CONTROLS
                or (friend_binding is not None and response.get("controls"))
                or type(response["has_more"]) is not bool):
            raise ValueError("Invalid database poll response.")

        baseline = request.get("baseline") is True
        if baseline and (response["rows"] or response["has_more"] or response.get("controls")):
            raise ValueError("A baseline cannot contain messages.")
        conversations = (request["friend_id"],) if friend_binding is not None else (request["owner_id"], *request["group_ids"])
        inventory = _parse_cursors(response["cursors"], conversations)
        grouped, ignored_owner_at, skipped = self._rows(request, response, inventory, selected)
        batches = {binding: (current, scope.revision, inventory[scope.conversation_id], pin, grouped[binding])
                   for binding, (scope, pin, current) in selected.items()}
        full = self.state.commit_database_batch(batches, baseline=baseline, max_queue=_MAX_QUEUE,
                                                ignored_owner_at=ignored_owner_at, skipped=skipped)
        statuses.update({binding: "queue_full" for binding in full})
        return DbIntakeResult(statuses, response["has_more"] or bool(full), tuple(selected) if baseline else ())

    def _rows(self, request, response, inventory, selected):
        cursors = response["cursors"]
        previous = request.get("cursors")
        by_conversation = {scope.conversation_id: scope for scope, _, _ in selected.values()}
        grouped = {binding: [] for binding in selected}
        ignored_owner_at = {}
        skipped = []
        if previous is None:
            return grouped, ignored_owner_at, skipped
        if previous.keys() != cursors.keys() or any(
            position["generation"] != cursors[key]["generation"] or position["local_id"] > cursors[key]["local_id"]
            for key, position in previous.items()
        ):
            raise StateConflict("Database cursor generation changed.")
        seen = set()
        observed = {key: position["local_id"] for key, position in previous.items()}
        for row in response["rows"]:
            key = _validate_row(row, self.account_id, cursors)
            identity = (key, row["local_id"])
            if row["local_id"] <= previous[key]["local_id"] or identity in seen:
                raise ValueError("Database message position was replayed.")
            seen.add(identity)
            observed[key] = max(observed[key], row["local_id"])
            scope = by_conversation[row["conversation_id"]]
            candidate = self._observation(scope, row, inventory[scope.conversation_id][key]["generation"])
            if candidate is not None:
                grouped[scope.binding].append((_row_identity(scope.binding, candidate["database"]), candidate))
            elif scope.target == "private" and row["sender_id"] in ("", scope.conversation_id):
                # An owner attachment, disabled voice input or unreadable message can still end adjacency.
                ignored_owner_at[scope.binding] = max(ignored_owner_at.get(scope.binding, 0), row["created_at"])
                if row["sender_id"] == scope.conversation_id:
                    skipped.append((scope.binding, skipped_kind(row["type"]), row["created_at"]))
        if any(position["local_id"] != observed[key] for key, position in cursors.items()):
            raise ValueError("Database cursor advanced past observed messages.")
        for row in response.get("controls", []):
            key = _validate_row(row, self.account_id, cursors, beyond_cursor=True)
            identity = (key, row["local_id"])
            if (row["conversation_id"] != self.owner.conversation_id or row["sender_id"] != self.owner.conversation_id
                    or row["local_id"] <= cursors[key]["local_id"] or identity in seen
                    or row["body"].strip().lower() not in QUEUE_COMMANDS):
                raise ValueError("Invalid database queue-control lookahead.")
            candidate = self._observation(self.owner, row, cursors[key]["generation"])
            if candidate is None:
                raise ValueError("Unverified database queue-control lookahead.")
            seen.add(identity)
            grouped[self.owner.binding].append((_row_identity(self.owner.binding, candidate["database"]), candidate))
        return grouped, ignored_owner_at, skipped

    def _observation(self, scope, row, generation):
        if not _authorized_sender(scope, self.account_id, row["sender_id"], row["native_mention_self"]):
            return None
        # A private voice message arrives already heard, as its transcript.
        voice = _is_voice(scope, row["type"]) and "transcript" in row
        heard = voice and bool(row["transcript"].strip())
        article = None
        rich = None
        quote = None
        forward_reference = None
        if voice:
            text = row["transcript"] if heard else VOICE_UNHEARD
        elif row["type"] != 3 and not row.get("body_available", True) and not (scope.target == "private" and row["type"] == FORWARD_TYPE):
            return None
        elif row["type"] == _TEXT_TYPE:
            text = row["body"]
            if scope.target == "private" and (url := _canonical_article_url(text)) is not None:
                article = {"url": url, "title": "公众号文章", "account": ""}
                text = url
        elif scope.target == "private" and row["type"] in _ARTICLE_TYPES and (article := _article_from_xml(row["body"])):
            text = article["url"]
        elif rich := parse_rich_message(row["type"], row["body"], owner_forward=scope.target == "private"):
            if scope.target != "private" and rich["kind"] in {"transfer", "redpacket"}:
                return None
            if rich["kind"] == "quote":
                text = rich.pop("title")
                if scope.target == "private":
                    forward_reference = quote_forward_reference(row["body"], scope.binding)
                if scope.target != "private" or not quote_save_command(text):
                    quote = rich["evidence"]
                    rich = None
            else:
                text = rich_display_text(rich)
        else:
            return None
        owner_plain_text = scope.target == "private" and row["type"] == _TEXT_TYPE and article is None
        length_limit = OWNER_PLAIN_TEXT_LIMIT if owner_plain_text else 500
        if (not 0 < len(text) <= length_limit or not text.strip()
                or any(unicodedata.category(char) == "Cs" or char == "\x00" for char in text)):
            return None
        database = {key: row[key] for key in ("conversation_id", "sender_id", "server_id", "database", "local_id",
                                             "created_at", "type", "mention_ids")}
        database.update(account_id=self.account_id, generation=generation, target=scope.target)
        display = scope.display_name if scope.target != "group" else row.get("sender_display_name")
        display = "".join(char for char in (display or "") if char.isprintable()).strip()[:80]
        result = {"direction": "incoming", "sender": display or row["sender_id"], "text": text,
                  "mentions_account": row["native_mention_self"], "database": database}
        if scope.policy is not None:
            result["group_policy_revision"] = scope.revision
        if voice:
            result["voice"] = {"heard": heard}
        if article is not None:
            result["article"] = article
        if rich is not None:
            if rich["kind"] == "forward" and scope.target == "private":
                rich["forwardKey"] = forward_card_key(scope.binding, row["server_id"]) or _row_identity(scope.binding, database)
            result["rich"] = rich
        if quote is not None:
            result["quote"] = quote
        if forward_reference is not None:
            result["forwardReference"] = forward_reference
        if scope.target == "private" and row["type"] == _TEXT_TYPE and forward_owner_command(text):
            result["forwardCommand"] = True
        return result

    def event_authorized(self, event: Occurrence):
        """Recheck current account/scope/policy and a persisted, actionable event."""
        scope = self.scopes.get(event.binding)
        observation = event.observation or {}
        source = observation.get("database")
        if scope is None or not isinstance(source, dict) or not self.state.database_event_is_current(
            event.binding, event.id, observation
        ):
            return False
        _, active, _ = self._active()
        if event.binding not in active:
            return False
        _, _, (_, cursors) = active[event.binding]
        cursor = cursors.get(f'{source["database"]}/{source["conversation_id"]}')
        mentions = source["mention_ids"]
        mentioned = self.account_id in mentions
        # The verified private control lane can persist commands beyond a
        # deliberately held cursor so a full paused ordinary queue can resume.
        voice = isinstance(observation.get("voice"), dict) and _is_voice(scope, source["type"])
        article = observation.get("article")
        is_article = (scope.target == "private" and valid_article(article) and observation["text"] == article["url"]
                      and (source["type"] in _ARTICLE_TYPES or source["type"] == _TEXT_TYPE))
        rich = observation.get("rich")
        if rich is not None and scope.target != "private" and ("forwardKey" in rich or "record" in rich):
            return False
        if "quote" in observation:
            accepted = (rich is None and article is None and not voice and source["type"] in _QUOTE_TYPES
                        and valid_quote_excerpt(observation["quote"]))
        elif "rich" in observation:
            accepted = (article is None and not voice and valid_rich(rich, source["type"])
                        and not (scope.target != "private" and rich["kind"] in {"transfer", "redpacket"})
                        and ("title" not in rich if rich["kind"] == "quote"
                             else observation["text"] == rich_display_text(rich)))
        else:
            # Keep private quote events already pending at upgrade. Their
            # original observation was admitted before evidence was supported.
            legacy_quote = scope.target == "private" and source["type"] in _QUOTE_TYPES and article is None
            accepted = source["type"] == _TEXT_TYPE or voice or is_article or legacy_quote
        control = (scope.target == "private" and source["type"] == _TEXT_TYPE
                   and observation["text"].strip().lower() in QUEUE_COMMANDS)
        return (cursor is not None and cursor["generation"] == source["generation"]
                and (control or 0 < source["local_id"] <= cursor["local_id"])
                and source["account_id"] == self.account_id and source["target"] == scope.target
                and source["conversation_id"] == scope.conversation_id and accepted
                and observation["direction"] == "incoming" and observation["mentions_account"] is mentioned
                and observation.get("group_policy_revision") == (scope.revision if scope.policy is not None else None)
                and _authorized_sender(scope, self.account_id, source["sender_id"], mentioned)
                and event.id == _row_identity(scope.binding, source))
