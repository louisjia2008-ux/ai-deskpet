"""Publish one owner-approved WeChat Moment through the official desktop composer.

Every step is located by OCR label inside a verified official WeChat window. The
composer text is read back before posting, the post is recorded before the click,
and an ID that was ever attempted is never posted again.
"""

import base64
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

from PIL import Image, ImageOps, UnidentifiedImageError

import vm_console as ui
from wechat_messages import key
from wechat_service import is_paused
from wechat_state import WeChatState


POST_ID = re.compile(r"[0-9a-f]{64}\Z")
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_TEXT = 1000
MAX_IMAGES = 9
GUEST_DIR = "$HOME/.local/state/deskpet-wechat/moments"
# Offsets measured on WeChat 4.1.13 (English UI) relative to the window origins.
SIDEBAR_MOMENTS = (31, 258)
MOMENTS_CAMERA = (67, 25)
MOMENTS_CLOSE = (407, 25)
LABELS = {
    "placeholder": ("Say something", "这一刻的想法"),
    "visible": ("Visible To", "谁可以看"),
    "all": ("All", "公开"),
    "private": ("Private", "私密"),
    "ok": ("OK", "确定", "完成"),
    "post": ("Post", "发表"),
    "discard": ("Discard", "不保留", "不保存"),
}


class MomentLedger:
    def __init__(self, db):
        self.db = db
        with db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS wechat_moment_posts (
                    id TEXT PRIMARY KEY,
                    digest TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('attempted', 'posted', 'uncertain'))
                )
            """)

    def previous(self, post_id, digest):
        row = self.db.execute("SELECT digest, status FROM wechat_moment_posts WHERE id = ?", (post_id,)).fetchone()
        if row is None:
            return None
        if row[0] != digest:
            return "conflict"
        return "uncertain" if row[1] == "attempted" else row[1]

    def begin(self, post_id, digest):
        with self.db:
            return self.db.execute("INSERT OR IGNORE INTO wechat_moment_posts (id, digest, status) VALUES (?, ?, 'attempted')",
                                   (post_id, digest)).rowcount == 1

    def finish(self, post_id, status):
        with self.db:
            self.db.execute("UPDATE wechat_moment_posts SET status = ? WHERE id = ? AND status = 'attempted'", (status, post_id))


def parse_post(raw):
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or set(value) != {"id", "text", "visibility", "images"}:
        raise ValueError("Invalid Moments request.")
    text, images = value["text"], value["images"]
    if (not isinstance(value["id"], str) or not POST_ID.fullmatch(value["id"])
            or value["visibility"] not in ("all", "private")
            or not isinstance(text, str) or not 1 <= len(text) <= MAX_TEXT or not text.strip()
            or any(not (character.isprintable() or character == "\n") for character in text)
            or not isinstance(images, list) or not 1 <= len(images) <= MAX_IMAGES
            or any(not isinstance(item, str) for item in images)):
        raise ValueError("Invalid Moments request.")
    return {**value, "images": [normalized_image(base64.b64decode(item, validate=True)) for item in images]}


def normalized_image(data):
    """Re-encode as a plain PNG: no metadata or animation reaches the guest."""
    try:
        with Image.open(BytesIO(data), formats=("PNG", "JPEG", "WEBP")) as original:
            if getattr(original, "is_animated", False) or not all(32 <= side <= 8192 for side in original.size):
                raise ValueError("Unsupported Moments image size.")
            image = original.convert("RGB")
            if max(image.size) > 2048:
                image = ImageOps.contain(image, (2048, 2048), Image.Resampling.LANCZOS)
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError("Unreadable Moments image.") from error
    encoded = BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def post_digest(request):
    return sha256(json.dumps([request["text"], request["visibility"], [sha256(item).hexdigest() for item in request["images"]]],
                             ensure_ascii=False).encode("utf-8")).hexdigest()


def window_named(name):
    """The single official WeChat window with this exact title, as (xid, x, y, width, height)."""
    rows = ui.guest(ui.WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        for window in $(xdotool search --name '^{name}$' 2>/dev/null); do
            props=$(wechat_window_props "$window") || continue
            geometry=$(wechat_window_geometry "$window") || continue
            case "$geometry" in *IsViewable) printf '%s %s\\n' "$window" "${{geometry% *}}" ;; esac
        done
    ''').decode("ascii").splitlines()
    if len(rows) != 1:
        return None
    return tuple(int(part) for part in rows[0].split())


def wait_window(name, seconds=6.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        found = window_named(name)
        if found is not None:
            return found
        time.sleep(0.3)
    raise ui.TestError(f"微信没有打开「{name}」窗口。")


def lines_in(settings, path, region):
    ui.snapshot(path)
    return ui.points(settings["ocr"], path, region)


def label_matches(text, names, *, prefix=False):
    value = key(text)
    for name in names:
        if value == name or value.endswith(" " + name) or (prefix and value.startswith(name)):
            return True
    return False


def find_label(settings, path, region, names, *, prefix=False, seconds=0.0):
    deadline = time.monotonic() + seconds
    while True:
        hits = [line for line in lines_in(settings, path, region) if label_matches(line["text"], names, prefix=prefix)]
        if len(hits) == 1 or time.monotonic() >= deadline:
            return hits[0] if len(hits) == 1 else None
        time.sleep(0.4)


def click_line(line):
    ui.guest(f"xdotool mousemove {line['x'] + line['width'] // 2} {line['y'] + line['height'] // 2} click 1")


def require_label(settings, path, region, kind, **options):
    line = find_label(settings, path, region, LABELS[kind], **options)
    if line is None:
        raise ui.TestError(f"朋友圈界面没有唯一的「{LABELS[kind][0]}」。")
    return line


def composer_text(x, y):
    ui.guest(f"xdotool mousemove {x} {y} click 1")
    ui.clear_clipboard()
    try:
        return ui.guest("xdotool key --clearmodifiers ctrl+a ctrl+c && sleep .2 && "
                        "xclip -selection clipboard -out -target UTF8_STRING").decode("utf-8")
    finally:
        ui.guest("xdotool key --clearmodifiers End")
        ui.clear_clipboard()


def close_moments(settings, path):
    """Leave no composer or Moments window behind; a draft is always discarded."""
    if window_named("Select File") is not None:
        ui.guest("xdotool key --clearmodifiers Escape")
        time.sleep(0.6)
    window = window_named("Moments")
    if window is None:
        return
    xid, left, top, width, height = window
    region = (left, top, width, height)
    if find_label(settings, path, region, LABELS["post"]) is None:
        # A profile card or other popup over the feed closes with Escape.
        ui.guest(f"xdotool windowactivate --sync {int(xid)} key --clearmodifiers Escape")
        time.sleep(0.6)
    else:
        ui.guest("xdotool key --clearmodifiers Escape")
        time.sleep(0.8)
        discard = find_label(settings, path, region, LABELS["discard"], seconds=2)
        if discard is not None:
            click_line(discard)
            time.sleep(0.8)
    if window_named("Moments") == window:
        ui.guest(f"xdotool mousemove {left + MOMENTS_CLOSE[0]} {top + MOMENTS_CLOSE[1]} click 1")
        time.sleep(0.8)


def publish(settings, path, request, guest_paths, *, before_post):
    left, top, _, _ = map(int, settings["window"])
    ui.guest(f"xdotool mousemove {left + SIDEBAR_MOMENTS[0]} {top + SIDEBAR_MOMENTS[1]} click 1")
    _, m_left, m_top, m_width, m_height = wait_window("Moments")
    region = (m_left, m_top, m_width, m_height)
    ui.guest(f"xdotool mousemove {m_left + MOMENTS_CAMERA[0]} {m_top + MOMENTS_CAMERA[1]} click 1")
    wait_window("Select File")
    names = " ".join(f'"{name}"' for name in guest_paths) if len(guest_paths) > 1 else guest_paths[0]
    ui.guest(f"""[ "$(xdotool getactivewindow getwindowname)" = 'Select File' ] || exit 1
        xdotool type --delay 15 {json.dumps(names)} && sleep .3 && xdotool key --clearmodifiers Return""")
    placeholder = require_label(settings, path, region, "placeholder", prefix=True, seconds=8)
    x, y = placeholder["x"] + placeholder["width"] // 2, placeholder["y"] + placeholder["height"] // 2
    ui.guest(f"xdotool mousemove {x} {y} click 1")
    ui.paste(request["text"])
    time.sleep(0.4)
    ui.clear_clipboard()
    if composer_text(x, y) != request["text"]:
        raise ui.TestError("朋友圈草稿文字与待发布内容不一致。")
    choice = "private" if request["visibility"] == "private" else "all"
    visible = require_label(settings, path, region, "visible")
    click_line(visible)
    click_line(require_label(settings, path, region, choice, seconds=3))
    click_line(require_label(settings, path, region, "ok", seconds=2))
    time.sleep(0.8)
    visible = require_label(settings, path, region, "visible", seconds=3)
    shown = [line for line in lines_in(settings, path, region)
             if abs(line["y"] - visible["y"]) < 12 and line["x"] > visible["x"] + visible["width"]]
    if len(shown) != 1 or not label_matches(shown[0]["text"], LABELS[choice]):
        raise ui.TestError("朋友圈可见范围与设置不一致。")
    if composer_text(x, y) != request["text"]:
        raise ui.TestError("朋友圈草稿文字在发布前发生了变化。")
    post = require_label(settings, path, region, "post")
    current = window_named("Moments")
    if current is None or current[1:] != region:
        raise ui.TestError("朋友圈窗口在发布前发生了变化。")
    if before_post() is False:
        raise ui.TestError("未能记录本次朋友圈发布，未发布。")
    since = int(time.time()) - 120
    click_line(post)
    return confirmed(request, since)


def confirmed(request, since, reader=None):
    """The account's own timeline in WeChat's database holds exactly this new post."""
    from wechat_db_channel import DatabaseReader, DatabaseUnavailable

    reader = reader or DatabaseReader()
    private = request["visibility"] == "private"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            found = reader.read({"op": "own_moments", "since": since})["moments"]
        except (DatabaseUnavailable, KeyError, TypeError):
            continue
        if any(item.get("text") == request["text"] and item.get("private") is private for item in found):
            return True
    return False


def post_moment(settings, runtime, state_path, request):
    digest = post_digest(request)
    attempted = False
    try:
        with ui.vm_operation(), WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-wechat-moment-") as tmp:
            ledger = MomentLedger(state.db)
            previous = ledger.previous(request["id"], digest)
            if previous is not None:
                return previous
            if is_paused(runtime):
                return "paused"
            path = Path(tmp) / "screen.png"
            # An interrupted earlier attempt may have left the Moments window open.
            close_moments(settings, path)
            ui.guest(f'mkdir -p "{GUEST_DIR}" && chmod 700 "{GUEST_DIR}" && rm -f "{GUEST_DIR}"/*.png')
            ui.open_target(settings, path, "private")
            stem = request["id"][:16]
            for index, image in enumerate(request["images"]):
                ui.guest(f'cat > "{GUEST_DIR}/{stem}-{index}.png"', image)
            home = ui.guest('printf %s "$HOME"').decode("utf-8")
            guest_paths = [f"{home}/.local/state/deskpet-wechat/moments/{stem}-{index}.png" for index in range(len(request["images"]))]

            def before_post():
                nonlocal attempted
                if is_paused(runtime):
                    return False
                attempted = ledger.begin(request["id"], digest)
                return attempted

            try:
                posted = publish(settings, path, request, guest_paths, before_post=before_post)
            except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                posted = False
            finally:
                try:
                    close_moments(settings, path)
                except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                    pass
                ui.guest(f'rm -f "{GUEST_DIR}"/*.png')
                try:
                    ui.open_target(settings, path, "private")
                except ui.TestError:
                    pass
            if attempted:
                ledger.finish(request["id"], "posted" if posted else "uncertain")
                return "posted" if posted else "uncertain"
            return "paused" if is_paused(runtime) else "retry"
    except ui.OperationBusy:
        return "busy"
    except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        return "uncertain" if attempted else "retry"


def moments_control(settings, runtime, state_path):
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Moments request is too large.")
        request = parse_post(raw)
    except (ValueError, TypeError, base64.binascii.Error):
        status = "invalid_payload"
    else:
        status = post_moment(settings, runtime, state_path, request)
    print(json.dumps({"status": status}))


def parse_preview(raw):
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or set(value) != {"id", "binding", "text", "image"}:
        raise ValueError("Invalid Moments preview.")
    if not all(isinstance(value[name], str) and POST_ID.fullmatch(value[name]) for name in ("id", "binding")):
        raise ValueError("Invalid Moments preview identity.")
    image = base64.b64decode(value["image"], validate=True)
    if not image.startswith(b"\x89PNG\r\n\x1a\n") or len(image) > 2_000_000:
        raise ValueError("Invalid Moments preview image.")
    return {**value, "image": image}


def send_preview(settings, runtime, state_path, request):
    """The draft text through the owner notice path, then its picture as one image."""
    from wechat_listener import verify_owner
    from wechat_owner_delivery import OwnerDeliveryLedger, owner_deliver, owner_delivery_pin, receipt_for_pin

    status = owner_deliver(settings, runtime, state_path, {"id": request["id"], "binding": request["binding"], "text": request["text"]})
    if status != "sent":
        return status
    image_id = sha256(f"{request['id']}:image".encode()).hexdigest()
    digest = sha256(request["image"]).hexdigest()
    attempted = False
    try:
        with ui.vm_operation(), WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-wechat-preview-") as tmp:
            ledger = OwnerDeliveryLedger(state.db)
            previous = ledger.previous(image_id, request["binding"], digest)
            if previous is not None:
                return previous
            pin = owner_delivery_pin(state, settings, runtime, request["binding"])
            if pin is None:
                return "binding_invalid"
            path = Path(tmp) / "screen.png"
            ui.open_target(settings, path, "private")
            verify_owner(settings, path, runtime)

            def before_send():
                nonlocal attempted
                if is_paused(runtime) or owner_delivery_pin(state, settings, runtime, request["binding"]) != pin:
                    return False
                attempted = ledger.begin(image_id, request["binding"], digest)
                return attempted

            def receipt():
                return ledger.finish(image_id, "sent", lambda: state.record_moment_preview(
                    request["id"], request["binding"], time.time()))

            ui.run_sticker("private", settings, path, request["image"], before_send=before_send,
                           receipt=receipt, database_receipt=receipt_for_pin(pin))
            return "sent"
    except ui.OperationBusy:
        return "busy"
    except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        return "uncertain" if attempted else "retry"


def preview_control(settings, runtime, state_path):
    raw = sys.stdin.buffer.read(4 * 1024 * 1024)
    try:
        request = parse_preview(raw)
    except (ValueError, TypeError, base64.binascii.Error):
        status = "invalid_payload"
    else:
        status = send_preview(settings, runtime, state_path, request)
    print(json.dumps({"status": status}))
