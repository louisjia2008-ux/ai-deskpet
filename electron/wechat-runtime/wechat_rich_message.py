"""Parse bounded evidence from authenticated database rows without opening attachments."""

from hashlib import sha256
import json
import re
import unicodedata
from urllib.parse import urlsplit, urlunsplit
from xml.etree import ElementTree


MAX_XML_BYTES = 65_536
MAX_EVIDENCE = 1_800
MAX_TITLE = 160
MAX_QUOTE = 200
QUOTE_PREFIX = "引用："
QUOTE_SAVE = re.compile(r"(?:存|存一下|收一下|收藏)[。.！!]?\Z")
MAX_LINK = 500
MAX_FORWARD_ITEMS = 12
MAX_RECORD_ITEMS = 80
MAX_RECORD_TEXT = 320
MAX_RECORD_BYTES = 20_000
FORWARD_TYPE = (19 << 32) | 49
FORWARD_KEY = re.compile(r"[0-9a-f]{64}\Z")
FORWARD_SERVER_ID = re.compile(r"[1-9][0-9]{0,19}\Z")
FORWARD_COMMAND = re.compile(r"(?:(?:读|存)转发(?:\s+[^\r\n]{1,90})?|问转发\s+[^\r\n]{1,440}|转发原文\s+\S[\s\S]{0,490})\Z")
FORWARD_KINDS = {"1": "text", "2": "image", "3": "voice", "4": "video", "5": "link", "6": "location",
                 "8": "file", "17": "forward"}
MAX_FILE_BYTES = 2**53 - 1
FORBIDDEN_XML = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)\b", re.IGNORECASE)
EXTENSION = re.compile(r"[a-z0-9]{1,16}\Z")
APP_KINDS = {
    5: "link", 6: "file", 19: "forward", 33: "miniprogram", 36: "miniprogram",
    57: "quote", 2000: "transfer", 2001: "redpacket",
}
NATIVE_KINDS = {3: "image", 42: "card", 43: "video", 48: "location"}
RICH_LABELS = {
    "quote": "[引用回复]", "forward": "[合并转发]", "link": "[链接]", "image": "[图片]",
    "file": "[文件]", "location": "[位置]", "card": "[名片]", "miniprogram": "[小程序]",
    "video": "[视频]", "transfer": "[转账]", "redpacket": "[红包]",
}
RICH_NOTICES = {
    "image": "这张图我现在看不了。",
    "transfer": "收到一笔转账，我不会去点。",
    "redpacket": "收到一个红包，我不会去点。",
}
FIELDS = {
    "quote": (set(), {"title", "forwardKey"}),
    "forward": (set(), {"title", "record", "forwardKey"}),
    "link": ({"url", "title"}, set()),
    "file": ({"title"}, {"fileExt", "fileBytes"}),
    "location": ({"title"}, set()),
    "card": ({"title"}, set()),
    "miniprogram": ({"title"}, set()),
}


def _limited(value, limit):
    return value.encode("utf-16-le")[:limit * 2].decode("utf-16-le", errors="ignore").rstrip()


def _label(value, limit=MAX_TITLE):
    if not isinstance(value, str):
        return ""
    printable = "".join(char if char.isprintable() and unicodedata.category(char)[0] != "C" else " "
                        for char in value)
    return _limited(" ".join(printable.split()), limit)


def _single(node, path):
    matches = node.findall(path)
    return matches[0] if len(matches) == 1 else None


def _leaf(node, path):
    element = _single(node, path)
    return (element.text or "") if element is not None and not len(element) else ""


def _xml(value):
    try:
        if (not isinstance(value, str) or not value or len(value) > MAX_XML_BYTES
                or len(value.encode("utf-8")) > MAX_XML_BYTES or FORBIDDEN_XML.search(value)):
            return None
        return ElementTree.fromstring(value.lstrip())
    except (ElementTree.ParseError, UnicodeError, ValueError):
        return None


def _canonical_link(value):
    if (not isinstance(value, str) or not value or len(value) > MAX_LINK
            or any(not character.isprintable() or character.isspace() or character == "\\"
                   for character in value)):
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme not in {"http", "https"} or not host or "%" in host
                or parsed.username is not None or parsed.password is not None
                or parsed.port is not None and parsed.port <= 0):
            return None
        # The dedicated article validator owns this host and must not be bypassed.
        if host.rstrip(".") == "mp.weixin.qq.com" or host.startswith("mp.weixin.qq.com."):
            return None
        result = urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))
        return result if len(result.encode("utf-16-le")) <= MAX_LINK * 2 else None
    except (ValueError, UnicodeError):
        return None


def _number(raw, maximum):
    if not isinstance(raw, str) or len(raw) > 16 or not raw.isascii() or not raw.isdecimal():
        return None
    value = int(raw)
    return value if value <= maximum else None


def _file_evidence(title, extension=None, size=None):
    details = [f"文件：{title}", f"类型：{extension or '未知'}"]
    details.append("大小未知" if size is None else f"大小：{size} 字节")
    return "；".join(details)


def _parse_file(card):
    # Only a basename for display. This value is never used to locate a file.
    source_title = _leaf(card, "title").replace("\\", "/").rsplit("/", 1)[-1]
    title = _label(source_title)
    if not title or title in (".", ".."):
        return None
    attachment = _single(card, "appattach")
    ext = _label(_leaf(attachment, "fileext"), 16).lower() if attachment is not None else ""
    if not EXTENSION.fullmatch(ext) and "." in title:
        ext = title.rsplit(".", 1)[-1].lower()
    extension = ext if EXTENSION.fullmatch(ext) else None
    size = _number(_leaf(attachment, "totallen"), MAX_FILE_BYTES) if attachment is not None else None
    value = {"kind": "file", "title": title, "evidence": _file_evidence(title, extension, size)}
    if extension is not None:
        value["fileExt"] = extension
    if size is not None:
        value["fileBytes"] = size
    return value


def quote_save_command(text):
    return isinstance(text, str) and QUOTE_SAVE.fullmatch(text.strip()) is not None


def valid_quote_excerpt(value):
    if not isinstance(value, str) or not value.startswith(QUOTE_PREFIX):
        return False
    excerpt = value[len(QUOTE_PREFIX):]
    return bool(excerpt) and _label(excerpt, MAX_QUOTE) == excerpt


def chat_quote_excerpt(observation):
    """Pre-release pending quote observations can still use the ordinary reply path."""
    if "quote" in observation:
        return observation["quote"]
    rich = observation.get("rich")
    source = observation.get("database")
    if not isinstance(rich, dict) or rich.get("kind") != "quote" or not isinstance(source, dict):
        return None
    if source.get("target") == "private" and (quote_save_command(observation.get("text")) or "forwardKey" in rich):
        return None
    return rich.get("evidence")


def _parse_quote(card):
    title = _leaf(card, "title")
    if not title.strip() or len(title.encode("utf-16-le")) > 1_000 or any(
            unicodedata.category(char) == "Cs" or char == "\x00" for char in title):
        return None
    reference = _single(card, "refermsg")
    body = _leaf(reference, "content") if reference is not None else ""
    if body.lstrip().startswith("<") or FORBIDDEN_XML.search(body):
        excerpt = "一条带格式或附件的消息"
    else:
        excerpt = _label(body, MAX_QUOTE)
    return {"kind": "quote", "title": title, "evidence": QUOTE_PREFIX + (excerpt or "内容不可读")}


def forward_owner_command(text):
    return isinstance(text, str) and FORWARD_COMMAND.fullmatch(text.strip()) is not None


def forward_card_key(binding, server_id):
    if not isinstance(server_id, str) or not FORWARD_SERVER_ID.fullmatch(server_id) or int(server_id) >= 2**64:
        return None
    return sha256(f'wechat-forward:v1\0{binding}\0{server_id}'.encode('ascii')).hexdigest()


def quote_forward_reference(body, binding):
    """Identify a native reference by ID. A plain excerpt never supplies identity."""
    root = _xml(body)
    card = _single(root, 'appmsg') if root is not None and root.tag == 'msg' else None
    reference = _single(card, 'refermsg') if card is not None and _leaf(card, 'type') == '57' else None
    if reference is None:
        return None
    key = forward_card_key(binding, _leaf(reference, 'svrid'))
    if key is None:
        return None
    content = _xml(_leaf(reference, 'content'))
    named = _single(content, 'appmsg') if content is not None and content.tag == 'msg' else None
    return {'key': key, 'nativeForward': _leaf(reference, 'type') == str(FORWARD_TYPE)
            or named is not None and _leaf(named, 'type') == '19'}


def unreadable_forward():
    return {'kind': 'forward', 'evidence': '聊天记录正文不可读', 'record': {'entries': [], 'truncated': True}}


def _record(entries):
    rows = []
    remaining = MAX_RECORD_BYTES - 64
    truncated = False
    for entry in entries:
        if entry.tag != 'dataitem':
            truncated = True
            continue
        if len(rows) >= MAX_RECORD_ITEMS:
            truncated = True
            break
        marker = entry.get('datatype') or _leaf(entry, 'datatype')
        body = _leaf(entry, 'datadesc') or _leaf(entry, 'datatitle')
        kind = FORWARD_KINDS.get(marker, 'attachment') if marker else 'text'
        text = _label(body, MAX_RECORD_TEXT)
        if kind == 'text' and (not text or body.lstrip().startswith('<') or FORBIDDEN_XML.search(body)):
            kind = 'attachment'
        row = {'kind': kind}
        if speaker := _label(_leaf(entry, 'sourcename'), 48):
            row['speaker'] = speaker
        if at := _label(_leaf(entry, 'sourcetime'), 48):
            row['at'] = at
        if kind == 'text':
            row['text'] = text
            if row['text'] != _label(body, MAX_XML_BYTES):
                row['shortened'] = True
                truncated = True
        size = len(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 1
        if size > remaining:
            truncated = True
            break
        remaining -= size
        rows.append(row)
    return {'entries': rows, 'truncated': truncated or not rows}


def _parse_forward(card, owner_forward=False):
    item = _single(card, "recorditem")
    if item is None:
        return unreadable_forward() if owner_forward else None
    record = _single(item, "recordinfo") if len(item) else _xml(item.text)
    if record is None or record.tag != "recordinfo":
        return unreadable_forward() if owner_forward else None
    entries = _single(record, "datalist")
    if entries is None:
        return unreadable_forward() if owner_forward else None
    excerpts = []
    for entry in entries:
        if entry.tag != "dataitem":
            continue
        speaker = _label(_leaf(entry, "sourcename"), 48) or "成员"
        body = _leaf(entry, "datadesc") or _leaf(entry, "datatitle")
        line = _label(body, 90) if not body.lstrip().startswith("<") else ""
        excerpts.append(f"{speaker}：{line or '附件或无可读文字'}")
        if len(excerpts) == MAX_FORWARD_ITEMS:
            break
    if not excerpts and not owner_forward:
        return None
    # The owner route carries typed rows only. Legacy/group receives the prior preview.
    value = {"kind": "forward", "evidence": "聊天记录" if owner_forward else _limited("\n".join(excerpts), MAX_EVIDENCE)}
    if owner_forward:
        value['record'] = _record(entries)
    title = _label(_leaf(record, "title") or _leaf(card, "title"))
    if title:
        value["title"] = title
    return value


def _parse_app_card(root, declared_subtype, owner_forward=False):
    card = _single(root, "appmsg")
    if card is None or root.tag != "msg":
        return None
    subtype = _number(_leaf(card, "type"), 2**32 - 1)
    kind = APP_KINDS.get(subtype)
    if kind is None or declared_subtype not in (0, subtype):
        return None
    if kind in RICH_NOTICES:
        return {"kind": kind, "evidence": RICH_NOTICES[kind]}
    if kind == "quote":
        return _parse_quote(card)
    if kind == "forward":
        return _parse_forward(card, owner_forward)
    if kind == "file":
        return _parse_file(card)
    if kind == "link":
        url = _canonical_link(_leaf(card, "url"))
        title = _label(_leaf(card, "title")) or "链接"
        return {"kind": kind, "url": url, "title": title, "evidence": f"链接：{title}"} if url else None
    title = _label(_leaf(card, "title"))
    return {"kind": kind, "title": title, "evidence": f"小程序：{title}"} if title else None


def _parse_native(root, kind):
    if kind == "video":
        video = _single(root, "videomsg") if root.tag == "msg" else root if root.tag == "videomsg" else None
        if video is None:
            return None
        seconds = _number(video.get("playlength"), MAX_FILE_BYTES)
        return {"kind": kind, "evidence": "视频（时长未知）" if seconds is None else f"视频：{seconds} 秒"}
    if kind == "location":
        location = _single(root, "location") if root.tag == "msg" else root if root.tag == "location" else None
        if location is None:
            return None
        title = _label(location.get("poiname") or location.get("label")) or "未命名地点"
        return {"kind": kind, "title": title, "evidence": f"位置：{title}"}
    if root.tag == "msg":
        card = _single(root, "card")
        if card is None and not len(root):
            card = root
    else:
        card = root if root.tag == "card" else None
    if card is None:
        return None
    title = _label(card.get("nickname") or card.get("nickName")) or "未命名联系人"
    return {"kind": kind, "title": title, "evidence": f"名片：{title}"}


def parse_rich_message(local_type, body, *, owner_forward=False):
    """Return reference data only. The title of a quote is the author's typed text."""
    if type(local_type) is not int or not 0 <= local_type < 2**64:
        return None
    primary, subtype = local_type & 0xffffffff, local_type >> 32
    kind = NATIVE_KINDS.get(primary) if subtype == 0 else None
    if kind == "image":
        return {"kind": kind, "evidence": RICH_NOTICES[kind]}
    if primary != 49 and kind is None:
        return None
    root = _xml(body)
    if root is None:
        return unreadable_forward() if owner_forward and local_type == FORWARD_TYPE else None
    value = _parse_app_card(root, subtype, owner_forward) if primary == 49 else _parse_native(root, kind)
    return value if valid_rich(value, local_type) else None


def valid_rich(value, local_type=None):
    if not isinstance(value, dict) or not isinstance(kind := value.get("kind"), str) or kind not in RICH_LABELS:
        return False
    if local_type is not None:
        if type(local_type) is not int or not 0 <= local_type < 2**64:
            return False
        primary, subtype = local_type & 0xffffffff, local_type >> 32
        if primary == 49:
            if not (kind in APP_KINDS.values() if subtype == 0 else kind == APP_KINDS.get(subtype)):
                return False
        elif subtype != 0 or NATIVE_KINDS.get(primary) != kind:
            return False
    required, optional = FIELDS.get(kind, (set(), set()))
    keys = {"kind", "evidence"} | required
    if not keys <= value.keys() <= keys | optional:
        return False
    evidence = value["evidence"]
    if (not isinstance(evidence, str) or not evidence or len(evidence) > MAX_EVIDENCE
            or any(not line or _label(line, MAX_EVIDENCE) != line for line in evidence.split("\n"))
            or len(evidence.encode("utf-16-le")) > MAX_EVIDENCE * 2):
        return False
    if kind == "quote" and not valid_quote_excerpt(evidence):
        return False
    if kind in RICH_NOTICES and evidence != RICH_NOTICES[kind]:
        return False
    if "url" in value and (not isinstance(value["url"], str) or _canonical_link(value["url"]) != value["url"]):
        return False
    if "title" in value:
        title = value["title"]
        if not isinstance(title, str) or not title.strip():
            return False
        if kind == "quote":
            if any(unicodedata.category(char) == "Cs" or char == "\x00" for char in title):
                return False
            if len(title.encode("utf-16-le")) > 1_000:
                return False
        elif _label(title) != title:
            return False
    if "fileExt" in value and (not isinstance(value["fileExt"], str) or not EXTENSION.fullmatch(value["fileExt"])):
        return False
    if 'record' in value and not _valid_record(value['record']):
        return False
    if 'forwardKey' in value and (not isinstance(value['forwardKey'], str) or not FORWARD_KEY.fullmatch(value['forwardKey'])
                                  or kind == 'forward' and 'record' not in value):
        return False
    return "fileBytes" not in value or type(value["fileBytes"]) is int and 0 <= value["fileBytes"] <= MAX_FILE_BYTES


def _valid_record(record):
    if (not isinstance(record, dict) or set(record) != {'entries', 'truncated'} or type(record['truncated']) is not bool
            or not isinstance(record['entries'], list) or len(record['entries']) > MAX_RECORD_ITEMS
            or not record['entries'] and not record['truncated']):
        return False
    for row in record['entries']:
        if (not isinstance(row, dict) or set(row) - {'kind', 'text', 'speaker', 'at', 'shortened'}
                or not isinstance(row.get('kind'), str) or row['kind'] not in set(FORWARD_KINDS.values()) | {'attachment'}
                or ('text' in row) != (row['kind'] == 'text')
                or 'shortened' in row and (row['shortened'] is not True or row['kind'] != 'text' or not record['truncated'])):
            return False
        for key, size in (('text', MAX_RECORD_TEXT), ('speaker', 48), ('at', 48)):
            if key in row and (not row[key] or _label(row[key], size) != row[key]):
                return False
    return len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= MAX_RECORD_BYTES


def rich_display_text(value):
    """A stable label for commands and transcript boundaries, excluding card-supplied text."""
    return RICH_LABELS[value["kind"]]
