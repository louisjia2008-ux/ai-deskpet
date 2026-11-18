"""Run DeskPet replies against the two explicitly bound Linux WeChat conversations."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
from unicodedata import normalize

import vm_console as ui
from wechat_db_intake import valid_article
from wechat_messages import MessageSnapshot, key, new_messages, select_quote
from wechat_reply_settings import CLOUD_GROUP_ID, FRIEND_ID, SHA256
from wechat_rich_message import forward_owner_command, valid_quote_excerpt, valid_rich
from wechat_service import prepare_runtime
from wechat_state import HISTORY_TURNS


CLOUD_REQUEST_LIMIT = 32_768
CLOUD_RESPONSE_LIMIT = 4_096
CLOUD_SOCKET = "cloud.sock"
# DeskPet allows the assistant 300 s, then answers within its 30 s socket margin.
PRIVATE_REPLY_TIMEOUT = 335
# A group turn may search the web; DeskPet allows it 120 s.
GROUP_REPLY_TIMEOUT = 150
ASSISTANT_REPLY_LIMIT = 500
ARTICLE_ACTIONS = {"收藏", "收藏这篇", "先放着", "收藏列表", "我的收藏", "继续聊"}
ARTICLE_COLLECTION_COMMAND = re.compile(r"(?:打开收藏\s+[a-fA-F0-9]{8,12}|(?:收藏列表|我的收藏)\s+[0-9]{1,3})\Z")
ARTICLE_QUESTION = re.compile(r"^(?:问文章|/article ask)\s+\S", re.IGNORECASE)
INBOX_ACTIONS = {"收件箱", "存一下", "收一下", "存", "存进收件箱", "收进收件箱"}
DIGEST_GROUP_COMMAND = re.compile(r"展开[^\S\r\n]+群[^\S\r\n]*[0-9]{1,2}\Z")
FOLLOWUP_COMMAND = re.compile(r"(?:待跟进|等你处理|(?:展开|完成)\s*跟进\s+[a-f0-9]{12}|稍后\s*跟进\s+[a-f0-9]{12}(?:\s+[0-9]{1,5})?)\Z", re.IGNORECASE)
OFFICIAL_BRIEF_COMMAND = re.compile(r"(?:收藏|展开)[^\S\r\n]+[0-9]{1,2}\Z")
OFFICIAL_BRIEF_QUESTION = re.compile(r"问[^\S\r\n]+[0-9]{1,2}[^\S\r\n]+\S[^\r\n]{0,349}\Z")
INBOX_ARGUMENT_COMMAND = re.compile(r"(?:收件箱[^\S\r\n]+[0-9]{1,4}|找[^\S\r\n]+\S[^\r\n]{0,159})\Z")


def log(event, **details):
    print(json.dumps({"event": event, **details}, ensure_ascii=False), flush=True)


def thread_snapshot(settings, path, target):
    ui.open_target(settings, path, target)
    return MessageSnapshot(target, ui.conversation_messages(settings, path, target))


def was_mentioned(settings, path):
    lines = ui.points(settings["ocr"], path, settings["search_results"])
    group = ui.matching(lines, settings["targets"]["group"]["title"])
    if len(group) != 1:
        return False
    x, y = group[0]["x"], group[0]["y"]
    return any(
        abs(line["x"] - x) <= 12 and 11 <= line["y"] - y <= 34
        and ("[youwerementioned]" in ui.normalize(line["text"]) or
             "[有人@我]" in ui.normalize(line["text"]) or "[有人艾特我]" in ui.normalize(line["text"]))
        for line in lines
    )


class ReplyRejected(ui.TestError):
    """The model returned no safe, usable text for this message."""


class ReplyYielded(RuntimeError):
    """The owner's queue took priority before a friend reply was attempted."""


def valid_daily_digests(value):
    if (not isinstance(value, dict) or set(value) != {'items', 'expiresAt'}
            or type(value['expiresAt']) is not int or not 0 < value['expiresAt'] <= 253_402_300_799
            or not isinstance(value['items'], list) or not 1 <= len(value['items']) <= 12):
        return False
    items = value['items']
    return all(isinstance(item, str) and 1 <= len(item) <= 500 and item.strip() == item and item.isprintable()
               for item in items) and sum(len(item.encode('utf-8')) for item in items) <= 6_000


def cloud_request_from_bytes(raw):
    if len(raw) > CLOUD_REQUEST_LIMIT or not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ValueError("Invalid cloud reply framing.")
    request = json.loads(raw.decode("utf-8"))
    required = {"target", "groupId", "binding", "eventId", "text", "history", "split", "stickers"}
    # A group request names who spoke: the owner or another member.
    speaker = {"speaker", "ownerName"} & set(request) if isinstance(request, dict) else set()
    if speaker and (speaker != {"speaker", "ownerName"} or request.get("target") != "group"
                    or request["speaker"] not in ("owner", "member") or not isinstance(request["ownerName"], str)
                    or not 1 <= len(request["ownerName"]) <= 80 or not request["ownerName"].isprintable()):
        raise ValueError("Invalid cloud reply speaker.")
    fields = set(request) - speaker - {"quote", "dailyDigests", "friendId"} if isinstance(request, dict) else set()
    if (not isinstance(request, dict) or fields not in (
            required, required | {"contextOnly", "localModel"}, required | {"ownerCommand"},
            required | {"readTool"}, required | {"article"}, required | {"rich"},
            required | {"stickerSelection", "reply", "sticker"})
            or ("quote" in request and (fields not in (required, required | {"contextOnly", "localModel"})
                or not valid_quote_excerpt(request["quote"])))
            or ("dailyDigests" in request and (fields != required or request['target'] != 'private'
                or not valid_daily_digests(request['dailyDigests'])))
            or (request.get('target') == 'friend' and (fields not in (required, required | {'contextOnly', 'localModel'})
                or request.get('split') is not False or request.get('stickers') is not False))
            or (request.get('target') != 'friend' and 'friendId' in request)
            or ("contextOnly" in request and (request["contextOnly"] is not True
                or not isinstance(request["localModel"], str) or not 1 <= len(request["localModel"]) <= 160))
            or ("ownerCommand" in request and request["ownerCommand"] is not True)
            or ("readTool" in request and request["readTool"] is not True)
            or ("article" in request and (request["target"] != "private" or request["history"] != []
                or not valid_article(request["article"]) or request["text"] != request["article"]["url"]))
            or ("rich" in request and (request["history"] != [] or request["split"] is not False
                or request["stickers"] is not False or speaker or not valid_rich(request["rich"])
                or (request["target"] == "group" and request["rich"]["kind"] in {"transfer", "redpacket"})
                or (request["target"] != "private" and any(key in request["rich"] for key in ("forwardKey", "record")))))
            or ("stickerSelection" in request and (request["stickerSelection"] is not True
                or request["stickers"] is not True or request["sticker"] is not True or request["history"] != []
                or not valid_reply(request["reply"])))):
        raise ValueError("Invalid cloud reply fields.")
    target, group = request["target"], request["groupId"]
    friend_id = request.get('friendId')
    if not (target == "private" and group is None
            or target == 'friend' and group is None and isinstance(friend_id, str) and FRIEND_ID.fullmatch(friend_id)
            or target == "group" and isinstance(group, str) and CLOUD_GROUP_ID.fullmatch(group)):
        raise ValueError("Invalid cloud reply scope.")
    if (not all(isinstance(request[name], str) and SHA256.fullmatch(request[name]) for name in ("binding", "eventId"))
            or any(type(request[name]) is not bool for name in ("split", "stickers"))):
        raise ValueError("Invalid cloud reply authority.")

    def valid_text(value):
        return (isinstance(value, str) and 0 < len(value) <= 500 and bool(value.strip())
                and not any(0xD800 <= ord(character) <= 0xDFFF for character in value))

    history = request["history"]
    if (not valid_text(request["text"]) or not isinstance(history, list) or len(history) > HISTORY_TURNS * 2
            or len(history) % 2 or any(not isinstance(entry, dict) or set(entry) != {"role", "text"}
            or entry["role"] != ("assistant" if index % 2 else "user") or not valid_text(entry["text"])
            for index, entry in enumerate(history))):
        raise ValueError("Invalid cloud reply context.")
    return request


def _host_reply(runtime, request, *, timeout, response_limit, wait_hook=None):
    wire = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if "validateKnowledgeReply" in request:
        if set(request) != {"binding", "validateKnowledgeReply"} or any(
            not isinstance(value, str) or not SHA256.fullmatch(value) for value in request.values()
        ):
            raise ValueError("Invalid knowledge reply check.")
    else:
        cloud_request_from_bytes(wire)
    endpoint = prepare_runtime(runtime) / CLOUD_SOCKET
    info = endpoint.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise OSError("Cloud reply socket is not owner-only.")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(os.fspath(endpoint))
        connection.sendall(wire)
        connection.shutdown(socket.SHUT_WR)
        if wait_hook is None:
            with connection.makefile("rb") as response:
                raw = response.readline(response_limit + 1)
        else:
            deadline = time.monotonic() + timeout
            raw = bytearray()
            while len(raw) <= response_limit and not raw.endswith(b'\n'):
                if not wait_for_read(connection, deadline, wait_hook):
                    raise TimeoutError('Timed out waiting for a WeChat reply.')
                chunk = connection.recv(response_limit + 1 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
    if len(raw) > response_limit or not raw.endswith(b"\n"):
        raise ValueError("Invalid cloud reply response framing.")
    return json.loads(raw.decode("utf-8"))


def knowledge_reply_current(runtime, binding, token):
    try:
        result = _host_reply(runtime, {"binding": binding, "validateKnowledgeReply": token},
                             timeout=2, response_limit=128)
        return isinstance(result, dict) and set(result) == {"valid"} and result["valid"] is True
    except (OSError, ValueError):
        return False


def local_reply_context(runtime, request, model):
    try:
        value = _host_reply(runtime, {**request, "contextOnly": True, "localModel": model},
                            timeout=4, response_limit=65_536)
    except (OSError, ValueError):
        return None
    if (not isinstance(value, dict) or set(value) not in ({"persona", "memories"}, {"name", "persona", "memories"})
            or ("name" in value and (not isinstance(value["name"], str) or not 1 <= len(value["name"]) <= 40
                                     or value["name"] != value["name"].strip() or not value["name"].isprintable()))
            or (value["persona"] is not None and (not isinstance(value["persona"], str) or len(value["persona"]) > 11_000))
            or not isinstance(value["memories"], list) or len(value["memories"]) > 4
            or any(not isinstance(item, str) or len(item) > 500 for item in value["memories"])):
        return None
    if request.get('target') == 'friend' and (value['memories'] or value['persona'] is not None):
        return None
    return value if value.get("name") or value["persona"] or value["memories"] else None


def doctor_checkup_command(text):
    return normalize('NFKC', text).strip().casefold() in ('体检', '/checkup')


def ephemeral_owner_reply(text):
    stripped = text.strip()
    if doctor_checkup_command(stripped):
        return True
    if FOLLOWUP_COMMAND.fullmatch(stripped):
        return True
    return forward_owner_command(stripped) or any(pattern.fullmatch(stripped) for pattern in (DIGEST_GROUP_COMMAND, OFFICIAL_BRIEF_COMMAND, OFFICIAL_BRIEF_QUESTION))


def owner_command_candidate(text):
    stripped = text.strip()
    if stripped in INBOX_ACTIONS or INBOX_ARGUMENT_COMMAND.fullmatch(stripped) or ephemeral_owner_reply(stripped):
        return True
    if stripped in ARTICLE_ACTIONS or ARTICLE_COLLECTION_COMMAND.fullmatch(stripped) or article_question(stripped):
        return True
    if stripped.startswith("／"):
        return bool(re.match(r"^/(?:cron|task|confirm)(?:\s|$)", normalize("NFKC", stripped), re.IGNORECASE))
    return stripped.startswith("/") or any(word in text.lower() for word in (
        "提醒", "计时器", "倒计时", "周期任务", "周期性任务", "定时任务", "循环任务", "recurring tasks",
    ))


def article_question(text):
    return ARTICLE_QUESTION.match(text.strip()) is not None or OFFICIAL_BRIEF_QUESTION.fullmatch(text.strip()) is not None


def sticker_mode(text, account, target):
    command = key(text).casefold()
    if target == "group":
        name = key(account).casefold()
        prefix = next((value for value in (f"@{name} ", f"@ {name} ") if name and command.startswith(value)), None)
        if prefix is None:
            return None
        command = command[len(prefix):]
    return {"/sticker": "auto", "/sticker favorites": "favorites", "/sticker library": "library"}.get(command)


def sticker_command(text, account, target):
    return sticker_mode(text, account, target) is not None


def select_reply_sticker(runtime, request, reply):
    value = _host_reply(runtime, {**request, "history": [], "stickerSelection": True, "reply": reply, "sticker": True},
                        timeout=5, response_limit=1024)
    if (not isinstance(value, dict) or set(value) != {"stickerAsset"}
            or (value["stickerAsset"] is not None
                and (not isinstance(value["stickerAsset"], str) or not SHA256.fullmatch(value["stickerAsset"])))):
        raise ValueError("Sticker selector returned an invalid asset identity.")
    return value["stickerAsset"]


def owner_command_plan(runtime, request):
    timeout = (180 if doctor_checkup_command(request['text']) else
               120 if article_question(request["text"]) or request["text"].strip().startswith("问转发 ") else 8)
    value = _host_reply(runtime, {**request, "ownerCommand": True}, timeout=timeout, response_limit=4096)
    if isinstance(value, dict) and value == {"reply": None}:
        return None
    if not isinstance(value, dict) or set(value) != {"reply"} or not isinstance(value["reply"], str):
        raise ValueError("Owner command service unavailable.")
    reply = "".join(c if c.isprintable() else " " for c in value["reply"]).strip()
    if not 0 < len(reply) <= 500:
        raise ValueError("Owner command reply is empty or too long.")
    return {"reply": reply, "sticker": False}


def read_tool_candidate(text, account, target):
    match = re.fullmatch(r"(?:@([^\s]+)[\s\u2005]+)?/(search|read|calc|time)(?:\s+.*)?", text.strip(), re.IGNORECASE)
    return bool(match and (match.group(1) is None or (target == "group" and match.group(1) == account)))


def read_tool_plan(runtime, request):
    value = _host_reply(runtime, {**request, "history": [], "readTool": True}, timeout=35, response_limit=4096)
    if (not isinstance(value, dict) or set(value) != {"reply"} or not isinstance(value["reply"], str)):
        raise ValueError("WeChat read-only tools unavailable.")
    reply = "".join(character if character.isprintable() else " " for character in value["reply"]).strip()
    if not 0 < len(reply) <= 500:
        raise ValueError("WeChat tool result is empty or too long.")
    return {"reply": reply, "sticker": False}


def article_reply_plan(runtime, request):
    value = _host_reply(runtime, request, timeout=PRIVATE_REPLY_TIMEOUT, response_limit=CLOUD_RESPONSE_LIMIT)
    if not isinstance(value, dict) or set(value) != {"reply"} or not valid_assistant_reply(value["reply"]):
        raise ValueError("WeChat article service returned an unavailable or invalid result.")
    return {"reply": value["reply"], "sticker": False}


def rich_reply_plan(runtime, request):
    value = _host_reply(runtime, request, timeout=GROUP_REPLY_TIMEOUT, response_limit=CLOUD_RESPONSE_LIMIT)
    if not isinstance(value, dict) or set(value) != {"reply"} or not valid_assistant_reply(value["reply"]):
        raise ValueError("WeChat rich message service returned an invalid result.")
    return value["reply"]


def cloud_reply_plan(runtime, request, fingerprint, *, wait_hook=None):
    # The owner's private chat may run DeskPet's full chat loop with tools.
    private = request["target"] == "private"
    value = _host_reply(runtime, request, timeout=PRIVATE_REPLY_TIMEOUT if private else GROUP_REPLY_TIMEOUT,
                        response_limit=CLOUD_RESPONSE_LIMIT, **({'wait_hook': wait_hook} if wait_hook is not None else {}))
    if isinstance(value, dict) and value == {"error": "reply.invalid"}:
        raise ReplyRejected("DeskPet 没有生成可发送的回复。")
    required = {"reply", "sticker", "routeFingerprint"}
    assistant = isinstance(value, dict) and value.get("format") == "assistant"
    if assistant:
        value = {name: item for name, item in value.items() if name != "format"}
    if (not isinstance(value, dict) or not required <= set(value) <= required | {"stickerAsset", "knowledgeReplyToken"}
            or value["routeFingerprint"] != fingerprint or (request['target'] == 'friend' and assistant)
            or not (valid_assistant_reply(value["reply"]) if assistant else valid_reply(value["reply"]))
            or type(value["sticker"]) is not bool or (value["sticker"] and not request["stickers"])
            or ("stickerAsset" in value and (not value["sticker"] or not isinstance(value["stickerAsset"], str)
                or not SHA256.fullmatch(value["stickerAsset"])))
            or ("knowledgeReplyToken" in value and (not private or not assistant
                or not isinstance(value["knowledgeReplyToken"], str) or not SHA256.fullmatch(value["knowledgeReplyToken"])))):
        raise ValueError("Cloud reply bridge returned an unavailable or invalid result.")
    plan = {field: value[field] for field in ("reply", "sticker", "stickerAsset", "knowledgeReplyToken") if field in value}
    return {**plan, "assistant": True} if assistant else plan


def wait_for_read(source, deadline, hook):
    while (remaining := deadline - time.monotonic()) > 0:
        if select.select([source], [], [], min(0.3, remaining))[0]:
            return True
        hook()
    return False


class DeskPet:
    def __init__(self, *, wait_hook=None):
        self.process = subprocess.Popen(
            ["/opt/homebrew/bin/node", str(Path(__file__).with_name("deskpet_reply.cjs"))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
        )
        try:
            ready = self.read(105) if wait_hook is None else self.read(105, wait_hook=wait_hook)
            if ready.get("ready") is not True:
                raise ui.TestError("独立 DeskPet 测试实例未就绪。")
        except ReplyYielded:
            self.cancel()
            raise
        except BaseException:
            self.close()
            raise

    def read(self, timeout, *, wait_hook=None):
        ready = (select.select([self.process.stdout], [], [], timeout)[0] if wait_hook is None
                 else wait_for_read(self.process.stdout, time.monotonic() + timeout, wait_hook))
        if not ready:
            raise ui.TestError("等待 DeskPet 生成回复超时。")
        line = self.process.stdout.readline()
        if not line:
            raise ui.TestError("独立 DeskPet 测试实例已退出。")
        return json.loads(line)

    def reply(self, event_id, target, text, history=None):
        return self.reply_plan(event_id, target, text, history)["reply"]

    def reply_plan(self, event_id, target, text, history=None, settings=None, *, wait_hook=None):
        request = {"id": event_id, "target": target, "text": text}
        if history is not None:
            request["history"] = history
        if settings is not None:
            request.update(settings)
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        response = self.read(125) if wait_hook is None else self.read(125, wait_hook=wait_hook)
        if response.get("id") == event_id and response.get("error") in {
            "reply.invalid", "request.invalid", "request.empty",
        }:
            raise ReplyRejected("DeskPet 没有生成可发送的回复。")
        reply = response.get("reply")
        if response.get("id") != event_id or response.get("ok") is not True or not valid_reply(reply):
            raise ui.TestError("DeskPet 未生成可发送的单行回复。")
        return {"reply": reply, "sticker": response.get("sticker") is True}

    def cancel(self):
        self.process.terminate()
        self.close()

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def valid_reply(reply):
    return (
        isinstance(reply, str) and bool(reply.strip()) and len(reply) <= 80
        and all(character.isprintable() for character in reply)
        and "http://" not in reply.lower() and "https://" not in reply.lower()
    )


def valid_assistant_reply(reply):
    """One assistant bubble: kept in history, whose entries are capped at 500 characters."""
    return (isinstance(reply, str) and bool(reply.strip()) and len(reply) <= ASSISTANT_REPLY_LIMIT
            and all(character.isprintable() for character in reply))


def reply_bubbles(text, enabled):
    if not enabled or len(text) < 14:
        return [text]
    candidates = [match.end() for match in re.finditer(r"[。！？!?；;]+", text)
                  if match.end() >= 5 and len(text) - match.end() >= 5]
    if not candidates:
        return [text]
    cut = min(candidates, key=lambda index: abs(index - len(text) / 2))
    return [text[:cut].strip(), text[cut:].strip()]


def record_attempt(db, event_id, target):
    with db:
        return bool(db.execute(
            "INSERT OR IGNORE INTO attempts (id, target, outcome) VALUES (?, ?, 'attempted')",
            (event_id, target),
        ).rowcount)


def reply_to(model, db, settings, path, target, selected, reply_text=None, *, quote=True):
    event_id = hashlib.sha256(
        json.dumps([target, *selected.identity], ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    if db.execute("SELECT 1 FROM attempts WHERE id = ?", (event_id,)).fetchone():
        log("duplicate_ignored", target=target)
        return False
    log("incoming_verified", target=target, sender=selected.sender, mention=selected.mentions_account)
    reply = reply_text if reply_text is not None else model.reply(event_id, target, selected.text)
    if not valid_reply(reply):
        raise ui.TestError("请输入不超过 80 字的单行回复。")
    current = thread_snapshot(settings, path, target)
    if select_quote(current.messages, selected.sender, selected.text) is None:
        raise ui.TestError("收到的消息已变化或出现重复，未发送。")
    if not record_attempt(db, event_id, target):
        return False
    reference = {"sender": selected.sender, "text": selected.text} if quote else None
    ui.run_test("send", target, reply, settings, path, quote=reference)
    with db:
        db.execute("UPDATE attempts SET outcome = 'sent' WHERE id = ?", (event_id,))
    log("sent", target=target, reply=reply, quoted=quote)
    return True


def single(args, model, db, settings, path):
    if args.target == "group" and args.mention_frame and not was_mentioned(settings, args.mention_frame):
        raise ui.TestError("截图里没有指定群的微信原生 @ 提醒。")
    current = thread_snapshot(settings, path, args.target)
    selected = select_quote(current.messages, args.sender, args.message)
    if selected is None:
        raise ui.TestError("找不到唯一匹配的来信。")
    if args.mention_frame and not selected.mentions_account:
        raise ui.TestError("这条群消息没有显示 @ 小号。")
    reply_to(model, db, settings, path, args.target, selected, args.reply,
             quote=args.target == "group" or args.quote)


def reply_to_mention(model, db, settings, path, previous):
    current = thread_snapshot(settings, path, "group")
    candidates = [
        message for message in new_messages(previous, current) or ()
        if message.mentions_account and message.sender
    ]
    if len(candidates) != 1:
        log("mention_unresolved", candidates=len(candidates))
        return previous, False
    sent = reply_to(model, db, settings, path, "group", candidates[0])
    return current, sent


def watch(args, model, db, settings, path):
    if args.group_baseline:
        if not args.mention_frame or not was_mentioned(settings, args.mention_frame):
            raise ui.TestError("恢复群 @ 测试需要已观察到的微信原生提醒。")
        group = MessageSnapshot("group", ui.conversation_messages(settings, args.group_baseline, "group"))
        _, sent = reply_to_mention(model, db, settings, path, group)
        if not sent:
            raise ui.TestError("未能发送恢复的群 @ 回复。")
        return
    group = thread_snapshot(settings, path, "group")
    private = thread_snapshot(settings, path, "private")
    log("watch_ready", duration_seconds=args.seconds)
    deadline = time.monotonic() + args.seconds
    private_sent = group_sent = False
    while time.monotonic() < deadline:
        incoming = thread_snapshot(settings, path, "private")
        native_mention = was_mentioned(settings, path)
        pending_private = new_messages(private, incoming)
        if pending_private is None:
            raise ui.TestError("私聊画面与已读取的消息失去连续性，已暂停自动回复。")
        for message in pending_private:
            if not args.once_each or not private_sent:
                private_sent = bool(reply_to(model, db, settings, path, "private", message, quote=False)) or private_sent
        private = incoming
        if native_mention and (not args.once_each or not group_sent):
            group, sent = reply_to_mention(model, db, settings, path, group)
            group_sent = sent or group_sent
        if args.once_each and private_sent and group_sent:
            log("watch_completed")
            return
        time.sleep(2)
    log("watch_expired", private_replied=private_sent, group_replied=group_sent)


@contextmanager
def session(state_path):
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with state_path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = sqlite3.connect(state_path)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, target TEXT, outcome TEXT)")
            yield db
        finally:
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True, type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    send = actions.add_parser("reply")
    send.add_argument("target", choices=("private", "group"))
    send.add_argument("--sender", required=True)
    send.add_argument("--message", required=True)
    send.add_argument("--reply")
    send.add_argument("--quote", action="store_true")
    send.add_argument("--mention-frame", type=Path)
    watcher = actions.add_parser("watch")
    watcher.add_argument("--seconds", type=int, default=180, choices=range(1, 3601), metavar="1–3600")
    watcher.add_argument("--once-each", action="store_true", help="Send at most one private and one group test reply")
    watcher.add_argument("--group-baseline", type=Path)
    watcher.add_argument("--mention-frame", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    os.environ["DESKPET_WECHAT_VM_CONFIG"] = args.config
    model = None
    try:
        with ui.vm_operation(), session(args.state) as db, tempfile.TemporaryDirectory(
            prefix="deskpet-wechat-watch-"
        ) as tmp:
            settings = ui.config()
            path = Path(tmp) / "screen.png"
            model = DeskPet() if args.action == "watch" or args.reply is None else None
            if args.action == "watch":
                watch(args, model, db, settings, path)
            else:
                single(args, model, db, settings, path)
    except (ui.TestError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        log("stopped", reason=str(error) if isinstance(error, ui.TestError) else type(error).__name__)
        return 1
    except KeyboardInterrupt:
        log("stopped", reason="interrupted")
        return 130
    finally:
        if model:
            model.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
