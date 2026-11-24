"""Publish one owner-approved WeChat Moment through the official desktop composer.

Every step is located by OCR label inside a verified official WeChat window. The
composer text is read back before posting, the post is recorded before the click,
and an ID that was ever attempted is never posted again.
"""

import base64
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

from PIL import Image, ImageOps, UnidentifiedImageError

import vm_console as ui
from wechat_messages import key
from wechat_replies import clean_reply_text
from wechat_service import is_paused, prepare_runtime
from wechat_state import WeChatState


POST_ID = re.compile(r"[0-9a-f]{64}\Z")
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_TEXT = 1000
MAX_IMAGES = 9
MOMENTS_LOCK_WAIT = 60
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
STAGES = (
    "open_window", "camera", "select_file", "attach_images", "placeholder", "paste",
    "text_verify", "visibility", "post_button", "window_changed", "ledger", "confirm",
)
MOMENT_ERRORS = (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError)
FAILURE_DIRECTORY = "moments-failures"
FAILURE_FILE = re.compile(r"[0-9]{8}T[0-9]{12}Z-(?:" + "|".join(STAGES) + r")\.png\Z")
FAILURE_LIMIT = 5
FAILURE_AGE = 7 * 24 * 60 * 60
RESTRICTION_TERMS = {
    "account": ("安全风险", "功能限制", "解除限制", "账号受限", "security risk", "account restricted",
                "account restriction", "feature restricted", "lift restrictions"),
    "publish": ("无法发表", "无法发布朋友圈", "禁止发表朋友圈", "暂时不能发朋友圈", "暂时无法发朋友圈",
                "cannot post", "unable to post", "can't post", "posting is restricted"),
    "temporary": ("暂时无法", "暂时不能", "temporarily unavailable", "temporarily unable"),
    "context": ("账号", "安全", "朋友圈", "account", "security", "moments"),
    "network": ("网络", "超时", "network", "timed out"),
    "dismiss": ("OK", "确定", "我知道了", "知道了", "关闭", "取消", "Got it", "Close", "Cancel"),
}


def prune_failure_screenshots(runtime, *, limit=FAILURE_LIMIT, now=None):
    folder = Path(runtime) / FAILURE_DIRECTORY
    if not folder.exists() and not folder.is_symlink():
        return
    folder = prepare_runtime(folder)
    cutoff = (time.time() if now is None else now) - FAILURE_AGE
    samples = []
    for sample in folder.iterdir():
        if not FAILURE_FILE.fullmatch(sample.name):
            continue
        try:
            info = sample.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode) and info.st_mtime > cutoff:
            samples.append((info.st_mtime_ns, sample))
        elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            sample.unlink(missing_ok=True)
    for _, sample in sorted(samples, reverse=True)[limit:]:
        sample.unlink(missing_ok=True)


def save_failure_screenshot(runtime, path, stage):
    try:
        data = path.read_bytes()
        folder = prepare_runtime(prepare_runtime(runtime) / FAILURE_DIRECTORY)
        prune_failure_screenshots(runtime, limit=FAILURE_LIMIT - 1)
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        destination = folder / f"{timestamp}-{stage}.png"
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
        except OSError:
            destination.unlink(missing_ok=True)
            raise
        return str(destination)
    except OSError:
        return None


@dataclass(frozen=True)
class RestrictionNotice:
    xid: int
    dismiss: dict | None
    publish_denied: bool


def restriction_lines(lines, draft_text, *, inline):
    """Read warning text from a WeChat dialog, excluding the entered caption."""
    normalize = ui.normalize
    caption = normalize(draft_text)
    dismiss_words = {normalize(word) for word in RESTRICTION_TERMS["dismiss"]}
    buttons = [line for line in lines if normalize(line["text"]) in dismiss_words]
    dismiss = buttons[0] if len(buttons) == 1 else None
    if inline and dismiss is None:
        return None
    if dismiss is not None and inline:
        # An inline dialog's message is directly above its dismiss control.
        lines = [line for line in lines if 0 < dismiss["y"] - line["y"] <= 150]
    body = "".join(text for line in sorted(lines, key=lambda line: (line["y"], line["x"]))
                   if (text := normalize(line["text"])) and text not in dismiss_words and text not in caption)

    def has(kind):
        return any(normalize(word) in body for word in RESTRICTION_TERMS[kind])

    account = has("account")
    if not account and has("network"):
        return None
    publish_denied = has("publish")
    if account or publish_denied or (has("temporary") and has("context")):
        return dismiss, publish_denied
    return None


def recognize_notice(ocr, path, region):
    # Physically crop the capture so the OCR process cannot recognize the chat underneath it.
    left, top, width, height = region
    crop = path.with_name("notice.png")
    with Image.open(path, formats=("PNG",)) as frame:
        frame.crop((left, top, left + width, top + height)).save(crop)
    return [{**line, "x": left + line["x"], "y": top + line["y"]}
            for line in ui.recognize(ocr, crop)]


class MomentDiagnostics:
    def __init__(self, settings, runtime, path, caption):
        self.settings = settings
        self.runtime = runtime
        self.path = path
        self.caption = caption
        self.stage = "ledger"
        self.window = None
        self.notice = None
        self.receipt_missing = False

    def capture(self):
        # Capture before any Escape, navigation, or cleanup changes the screen.
        self.notice = None
        self.path.unlink(missing_ok=True)
        try:
            ui.snapshot(self.path)
        except MOMENT_ERRORS:
            self.path.unlink(missing_ok=True)
            return
        try:
            desktop = ui.wechat_desktop()
            active = next((window for window in desktop.windows if window.xid == desktop.active and window.mapped), None)
            if active is None:
                return
            inline = self.window is not None and active.xid == self.window[0]
            if not inline and (active.normal or window_named("Select File") == (active.xid, *active.geometry)):
                return
            left, top, width, height = active.geometry
            region = (left, top, width, height)
            if inline:
                region = (left + width // 8, top + height // 5, width * 3 // 4, height * 3 // 5)
            lines = recognize_notice(self.settings["ocr"], self.path, region)
            match = restriction_lines(lines, self.caption, inline=inline)
            if match is not None:
                dismiss, publish_denied = match
                self.notice = RestrictionNotice(active.xid, dismiss, publish_denied)
        except (*MOMENT_ERRORS, KeyError, TypeError):
            pass  # The local frame can still be retained if OCR or window inspection fails.

    def failure(self, *, attempted, paused=False, allow_restriction=True):
        if self.notice is None:
            self.capture()
        status = "uncertain" if attempted else "window_error" if self.stage == "open_window" else "retry"
        if allow_restriction and self.notice and not attempted:
            status = "restricted"
        elif paused and not attempted:
            status = "paused"
        result = {"status": status, "stage": self.stage}
        if screenshot := save_failure_screenshot(self.runtime, self.path, self.stage):
            result["screenshotPath"] = screenshot
        return result


def dismiss_restriction(notice):
    if notice is None:
        return
    action = "key --clearmodifiers Escape"
    if notice.dismiss is not None:
        line = notice.dismiss
        x, y = line["x"] + line["width"] // 2, line["y"] + line["height"] // 2
        action = f"mousemove {int(x)} {int(y)} click 1"
    ui.guest(ui.WECHAT_X11_IDENTITY + f'''
        [ "$(xdotool getactivewindow)" = "{notice.xid}" ] &&
        wechat_window_props "{notice.xid}" >/dev/null &&
        xdotool {action}
    ''')
    time.sleep(0.6)


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

    def rejected(self, post_id, digest):
        """Only a verified refusal at the composer releases the reservation for the same draft."""
        with self.db:
            return self.db.execute(
                "DELETE FROM wechat_moment_posts WHERE id = ? AND digest = ? AND status = 'attempted'",
                (post_id, digest),
            ).rowcount == 1


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
    text = clean_reply_text(text)
    if not text:
        raise ValueError("Invalid Moments request.")
    return {**value, "text": text, "images": [normalized_image(base64.b64decode(item, validate=True)) for item in images]}


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


def wait_file_picker_closed():
    deadline = time.monotonic() + 6
    while window_named("Select File") is not None:
        if time.monotonic() >= deadline:
            raise ui.TestError("微信的「Select File」窗口未关闭。")
        time.sleep(0.3)


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


def visibility_matches(settings, path, region, lines, choice):
    anchors = [line for line in lines if label_matches(line["text"], LABELS["visible"])]
    if len(anchors) != 1:
        return False
    visible = anchors[0]
    start = visible["x"] + visible["width"]
    scan_y = visible["y"] + visible["height"] + 3
    left, top, width, height = region
    with Image.open(path, formats=("PNG",)) as frame:
        end = min(left + width, frame.width)
        if not (max(0, left) <= start < end and max(0, top) <= scan_y < min(top + height, frame.height)):
            return False
        # The inline composer overlays a dimmed feed within the same X11 window.
        # Follow the blank strip just below the label to the edge of the composer.
        strip = frame.crop((start, scan_y, end, scan_y + 1)).convert("RGB")
    background = strip.getpixel((0, 0))
    boundary = next((start + x for x in range(1, strip.width) if strip.getpixel((x, 0)) != background), None)
    if boundary is None:
        return False
    shown = [line for line in lines if abs(line["y"] - visible["y"]) < 12
             and start < line["x"] and line["x"] + line["width"] <= boundary]
    if len(shown) != 1:
        return False
    candidate = shown[0]
    observed = key(candidate["text"])
    if observed in (*LABELS["all"], *LABELS["private"]):
        return observed in LABELS[choice]
    # Vision can read the small "All" as "A|I" at desktop scale. Read the
    # same control at a larger size and still require the exact approved label.
    x, y = candidate["x"], candidate["y"]
    box = (max(start, x - 5), max(top, y - 5), min(boundary, x + candidate["width"] + 5),
           min(top + height, y + candidate["height"] + 5))
    enlarged = path.with_name("visibility.png")
    with Image.open(path, formats=("PNG",)) as frame:
        crop = frame.crop(box)
        crop.resize((crop.width * 3, crop.height * 3), Image.Resampling.LANCZOS).save(enlarged)
    rescanned = ui.recognize(settings["ocr"], enlarged)
    return len(rescanned) == 1 and key(rescanned[0]["text"]) in LABELS[choice]


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


def publish(settings, path, request, guest_paths, *, before_post, diagnostics):
    diagnostics.stage = "open_window"
    left, top, _, _ = map(int, settings["window"])
    ui.guest(f"xdotool mousemove {left + SIDEBAR_MOMENTS[0]} {top + SIDEBAR_MOMENTS[1]} click 1")
    diagnostics.window = wait_window("Moments")
    diagnostics.capture()
    if diagnostics.notice is not None:
        raise ui.TestError("微信提示暂时无法使用朋友圈。")
    _, m_left, m_top, m_width, m_height = diagnostics.window
    region = (m_left, m_top, m_width, m_height)
    diagnostics.stage = "camera"
    ui.guest(f"xdotool mousemove {m_left + MOMENTS_CAMERA[0]} {m_top + MOMENTS_CAMERA[1]} click 1")
    diagnostics.stage = "select_file"
    wait_window("Select File")
    names = " ".join(f'"{name}"' for name in guest_paths) if len(guest_paths) > 1 else guest_paths[0]
    ui.guest(f"""[ "$(xdotool getactivewindow getwindowname)" = 'Select File' ] || exit 1
        xdotool type --delay 15 {json.dumps(names)} && sleep .3 && xdotool key --clearmodifiers Return""")
    diagnostics.stage = "attach_images"
    wait_file_picker_closed()
    diagnostics.stage = "placeholder"
    placeholder = require_label(settings, path, region, "placeholder", prefix=True, seconds=8)
    x, y = placeholder["x"] + placeholder["width"] // 2, placeholder["y"] + placeholder["height"] // 2
    diagnostics.stage = "paste"
    ui.guest(f"xdotool mousemove {x} {y} click 1")
    ui.paste(request["text"])
    time.sleep(0.4)
    ui.clear_clipboard()
    diagnostics.stage = "text_verify"
    if composer_text(x, y) != request["text"]:
        raise ui.TestError("朋友圈草稿文字与待发布内容不一致。")
    diagnostics.stage = "visibility"
    choice = "private" if request["visibility"] == "private" else "all"
    visible = require_label(settings, path, region, "visible")
    click_line(visible)
    click_line(require_label(settings, path, region, choice, seconds=3))
    click_line(require_label(settings, path, region, "ok", seconds=2))
    time.sleep(0.8)
    deadline = time.monotonic() + 3
    while not visibility_matches(settings, path, region, lines_in(settings, path, region), choice):
        if time.monotonic() >= deadline:
            raise ui.TestError("朋友圈可见范围与设置不一致。")
        time.sleep(0.4)
    diagnostics.stage = "text_verify"
    if composer_text(x, y) != request["text"]:
        raise ui.TestError("朋友圈草稿文字在发布前发生了变化。")
    diagnostics.stage = "post_button"
    post = require_label(settings, path, region, "post")
    diagnostics.stage = "window_changed"
    if window_named("Moments") != diagnostics.window:
        raise ui.TestError("朋友圈窗口在发布前发生了变化。")
    diagnostics.stage = "ledger"
    if before_post() is False:
        raise ui.TestError("未能记录本次朋友圈发布，未发布。")
    since = int(time.time()) - 120
    diagnostics.stage = "post_button"
    click_line(post)
    diagnostics.stage = "confirm"
    # A restriction toast can disappear while the database receipt is still being polled.
    time.sleep(0.4)
    diagnostics.capture()
    if not confirmed(request, since):
        diagnostics.receipt_missing = True
        raise ui.TestError("未核对到本次朋友圈的发布回执。")


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
        with ui.vm_operation(wait=MOMENTS_LOCK_WAIT), TemporaryDirectory(prefix="deskpet-wechat-moment-") as tmp:
            path = Path(tmp) / "screen.png"
            diagnostics = MomentDiagnostics(settings, runtime, path, request["text"])
            restore = False
            staged = False
            ledger = None

            def before_post():
                nonlocal attempted
                if is_paused(runtime):
                    return False
                attempted = ledger.begin(request["id"], digest)
                return attempted

            try:
                with WeChatState(state_path) as state:
                    ledger = MomentLedger(state.db)
                    previous = ledger.previous(request["id"], digest)
                    if previous is not None:
                        return {"status": previous}
                    if is_paused(runtime):
                        return {"status": "paused"}
                    diagnostics.stage = "open_window"
                    restore = True
                    close_moments(settings, path)
                    ui.open_target(settings, path, "private")
                    diagnostics.stage = "attach_images"
                    staged = True
                    ui.guest(f'mkdir -p "{GUEST_DIR}" && chmod 700 "{GUEST_DIR}" && rm -f "{GUEST_DIR}"/*.png')
                    stem = request["id"][:16]
                    for index, image in enumerate(request["images"]):
                        ui.guest(f'cat > "{GUEST_DIR}/{stem}-{index}.png"', image)
                    home = ui.guest('printf %s "$HOME"').decode("utf-8")
                    guest_paths = [f"{home}/.local/state/deskpet-wechat/moments/{stem}-{index}.png"
                                   for index in range(len(request["images"]))]
                    try:
                        publish(settings, path, request, guest_paths, before_post=before_post, diagnostics=diagnostics)
                        diagnostics.stage = "ledger"
                        ledger.finish(request["id"], "posted")
                        return {"status": "posted"}
                    except MOMENT_ERRORS:
                        result = diagnostics.failure(attempted=attempted, paused=is_paused(runtime))
                        if attempted:
                            # A timeout by itself leaves the ledger sealed. Only a verified, explicit
                            # publish refusal and missing receipt allow a fresh owner-approved attempt.
                            try:
                                if (diagnostics.receipt_missing and diagnostics.notice and diagnostics.notice.publish_denied
                                        and ledger.rejected(request["id"], digest)):
                                    result["status"] = "restricted"
                                else:
                                    ledger.finish(request["id"], "uncertain")
                            except sqlite3.Error:
                                pass  # A leftover attempted row is also treated as uncertain.
                        return result
            except MOMENT_ERRORS:
                return diagnostics.failure(attempted=attempted, allow_restriction=restore)
            finally:
                if restore:
                    try:
                        if diagnostics.notice is not None and attempted:
                            diagnostics.capture()  # Recheck a warning seen earlier before dismissing it.
                        dismiss_restriction(diagnostics.notice)
                    except MOMENT_ERRORS:
                        pass
                    try:
                        close_moments(settings, path)
                    except MOMENT_ERRORS:
                        pass
                if staged:
                    try:
                        ui.guest(f'rm -f "{GUEST_DIR}"/*.png')
                    except MOMENT_ERRORS:
                        pass
                if restore:
                    try:
                        ui.open_target(settings, path, "private")
                    except MOMENT_ERRORS:
                        pass
    except ui.OperationBusy:
        return {"status": "paused" if is_paused(runtime) else "busy"}
    except MOMENT_ERRORS:
        return {"status": "uncertain" if attempted else "retry", "stage": "ledger"}


def moments_control(settings, runtime, state_path):
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Moments request is too large.")
        request = parse_post(raw)
    except (ValueError, TypeError, base64.binascii.Error):
        result = {"status": "invalid_payload"}
    else:
        result = post_moment(settings, runtime, state_path, request)
    print(json.dumps(result))


def parse_preview(raw):
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or set(value) != {"id", "binding", "text", "image"}:
        raise ValueError("Invalid Moments preview.")
    if not all(isinstance(value[name], str) and POST_ID.fullmatch(value[name]) for name in ("id", "binding")):
        raise ValueError("Invalid Moments preview identity.")
    image = base64.b64decode(value["image"], validate=True)
    if not image.startswith(b"\x89PNG\r\n\x1a\n") or len(image) > 2_000_000:
        raise ValueError("Invalid Moments preview image.")
    text = clean_reply_text(value["text"])
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Invalid Moments preview.")
    return {**value, "text": text, "image": image}


def send_preview(settings, runtime, state_path, request):
    """The draft text through the owner notice path, then its picture as one image."""
    from wechat_listener import verify_owner
    from wechat_owner_delivery import OwnerDeliveryLedger, deliver_moment_preview_text, owner_delivery_pin, receipt_for_pin

    image_id = sha256(f"{request['id']}:image".encode()).hexdigest()
    digest = sha256(request["image"]).hexdigest()
    attempted = False
    try:
        with ui.vm_operation(wait=MOMENTS_LOCK_WAIT):
            status = deliver_moment_preview_text(settings, runtime, state_path,
                                                 {"id": request["id"], "binding": request["binding"], "text": request["text"]})
            if status != "sent":
                return status
            with WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-wechat-preview-") as tmp:
                ledger = OwnerDeliveryLedger(state.db)
                previous = ledger.previous(image_id, request["binding"], digest)
                if previous is not None:
                    return previous
                if is_paused(runtime):
                    return "paused"
                pin = owner_delivery_pin(state, settings, runtime, request["binding"])
                if pin is None:
                    return "binding_invalid"
                path = Path(tmp) / "screen.png"
                try:
                    ui.open_target(settings, path, "private")
                except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                    return "window_error"
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
                if attempted:
                    return ledger.previous(image_id, request["binding"], digest)
                return "paused" if is_paused(runtime) else "retry"
    except ui.OperationBusy:
        return "paused" if is_paused(runtime) else "busy"
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
