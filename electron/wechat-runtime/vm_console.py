"""Drive only the dedicated Lima guest's WeChat test window using X11 input."""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
import fcntl
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata

from PIL import Image, ImageChops, ImageOps, ImageStat, UnidentifiedImageError


SSH_CONFIG = Path.home() / "Virtual Machines/DeskPet WeChat/lima/wechat-test/ssh.config"
SSH_HOST = "lima-wechat-test"
VM_LOCK_PATH = SSH_CONFIG.parents[2] / "desktop.lock"
DISPLAY_ENV = 'export DISPLAY=:38 XAUTHORITY="$HOME/.local/state/deskpet-wechat/Xauthority"; '
GROUP_HEADER = re.compile(r"(.+?)\s*[（(]([1-9][0-9]{0,3})[）)]\Z")
ROW_TRUNCATION = re.compile(r"(.+?)(?:\.{2,4}|[…⋯][.…⋯]{0,2})\Z")
ROW_TIMESTAMP = re.compile(r"\s+(?:[0-9]{1,2}:[0-9]{2}|昨天|星期[一二三四五六日天]|"
                           r"yesterday|mon|tue|wed|thu|fri|sat|sun|[0-9]{1,2}/[0-9]{1,2})\Z", re.IGNORECASE)
ROW_DATED_TIME = re.compile(r"(?:\s+|(?<=[.…⋯])\s*[•·]\s*)(?:yesterday|昨天|星期[一二三四五六日天]|"
                            r"mon|tue|wed|thu|fri|sat|sun|[0-9]{1,2}/[0-9]{1,2})\s+[0-9]{1,2}:[0-9]{2}\Z",
                            re.IGNORECASE)
SELECTED_CHAT = (21, 172, 112)
MISREAD_CRON_ONCE = re.compile(r"^[IJ]cron\s+once\s+", re.IGNORECASE)

# Inspect only windows owned by the provisioned, unprivileged official client.
WECHAT_X11_IDENTITY = r'''
official_wechat() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ "$(stat -c %u "/proc/$1" 2>/dev/null)" = "$(id -u)" ] &&
        [ "$(readlink "/proc/$1/exe" 2>/dev/null)" = /opt/wechat/wechat ]
}
wechat_window_props() {
    props=$(xprop -id "$1" WM_CLASS _NET_WM_PID _NET_WM_WINDOW_TYPE 2>/dev/null) || return 1
    printf '%s\n' "$props" | grep -qx 'WM_CLASS(STRING) = "wechat", "wechat"' || return 1
    pid=$(printf '%s\n' "$props" | sed -n 's/^_NET_WM_PID(CARDINAL) = \([0-9][0-9]*\)$/\1/p')
    official_wechat "$pid" || return 1
    printf '%s\n' "$props"
}
wechat_normal_window() {
    printf '%s\n' "$1" | grep -Eq '^_NET_WM_WINDOW_TYPE\(ATOM\) = (_KDE_NET_WM_WINDOW_TYPE_OVERRIDE, )?_NET_WM_WINDOW_TYPE_NORMAL$'
}
wechat_window_geometry() {
    xwininfo -id "$1" 2>/dev/null | awk '
        /Absolute upper-left X:/ { x = $NF }
        /Absolute upper-left Y:/ { y = $NF }
        /Width:/ { w = $NF }
        /Height:/ { h = $NF }
        /Map State:/ { mapped = $NF }
        END { if (w && h && mapped) print x, y, w, h, mapped; else exit 1 }
    '
}
'''

WECHAT_DESKTOP_SERVICE = r'''
[ "$(hostname -s)" = lima-wechat-test ] && [ "$(id -u)" != 0 ] &&
    [ "$(uname -s)" = Linux ] && [ "$(dpkg --print-architecture)" = arm64 ] &&
    [ -x /opt/wechat/wechat ] || exit 1
unit="deskpet-wechat-desktop@$(id -un).service"
[ "$(systemctl show -p LoadState --value "$unit")" = loaded ] &&
    [ "$(systemctl show -p FragmentPath --value "$unit")" = /etc/systemd/system/deskpet-wechat-desktop@.service ] &&
    [ "$(systemctl show -p User --value "$unit")" = "$(id -un)" ] &&
    [ -z "$(systemctl show -p DropInPaths --value "$unit")" ] || exit 1
'''


class TestError(Exception):
    def __init__(self, message, *, code=None):
        super().__init__(message)
        if code is not None:
            self.code = code


class DiagnosticTestError(TestError):
    """A fixed diagnostic that is safe to include in background logs."""


class WindowCaptureError(DiagnosticTestError):
    def __init__(self, returncode):
        self.returncode = returncode
        super().__init__(CAPTURE_FAILURES[returncode], code=CAPTURE_CODES[returncode])


class GuestCommandFailed(DiagnosticTestError):
    def __init__(self, returncode):
        self.returncode = returncode
        super().__init__("无法通过 SSH 连接微信虚拟机。" if returncode == 255 else "虚拟机里的桌面操作失败。",
                         code="send_capture_failed")


class OperationBusy(TestError):
    pass


class OwnerOperationPending(OperationBusy):
    """An owner operation is waiting for or using the desktop."""


class AttemptUncertain(TestError):
    code = "send_receipt_unconfirmed"


class SendWindowChanged(TestError):
    code = "send_window_changed"


SEND_REASONS = frozenset({
    "send_window_missing", "send_window_identity", "send_window_geometry", "send_capture_failed", "send_window_changed",
    "send_window_busy", "send_listener_paused",
    "send_ocr_failed", "send_target_unbound", "send_target_ambiguous", "title_mismatch", "drawer_state_unknown",
    "drawer_not_open", "drawer_not_closed", "send_owner_profile_unverified", "send_owner_binding_mismatch",
    "send_group_binding_mismatch", "send_friend_binding_mismatch", "send_draft_occupied", "send_draft_mismatch", "send_quote_menu_missing",
    "send_quote_mismatch", "send_anchor_mismatch", "send_input_bounds", "send_policy_changed", "send_attempt_unrecorded",
    "send_receipt_baseline", "send_receipt_unconfirmed", "send_receipt_unstored", "send_duplicate", "send_check_failed",
})


def send_reason(error):
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code in SEND_REASONS else "send_check_failed"


@dataclass(frozen=True)
class WeChatWindow:
    xid: int
    geometry: tuple[int, int, int, int]
    mapped: bool
    normal: bool


@dataclass(frozen=True)
class WeChatDesktop:
    active: int
    windows: tuple[WeChatWindow, ...]


@contextmanager
def _private_desktop_lock(directory, name, uid):
    try:
        lock = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
    except OSError as error:
        raise DiagnosticTestError("无法打开虚拟机专用锁。") from error
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o600:
            raise DiagnosticTestError("虚拟机专用锁应为当前用户私有文件。")
        yield lock
    finally:
        os.close(lock)


def _acquire_desktop(lock, operation, deadline, *, busy=OperationBusy):
    while True:
        try:
            fcntl.flock(lock, operation | fcntl.LOCK_NB)
            return
        except BlockingIOError as error:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise busy("另一个操作正在使用虚拟机桌面。") from error
            time.sleep(min(0.2, remaining))


@contextmanager
def vm_operation(*, wait=0.0):
    """Reserve the guest desktop across worker processes.

    Owner actions hold a shared gate while waiting with a deadline and while
    using the desktop. A poller only passes the gate when no owner holds it.
    Closing a descriptor, including on process exit, releases its gate claim.
    """
    uid = os.geteuid()
    try:
        directory = os.open(VM_LOCK_PATH.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise DiagnosticTestError("无法打开虚拟机专用锁目录。") from error
    try:
        root = os.fstat(directory)
        if root.st_uid != uid or stat.S_IMODE(root.st_mode) != 0o700:
            raise DiagnosticTestError("虚拟机专用锁目录应仅允许当前用户访问。")
        deadline = time.monotonic() + wait
        with _private_desktop_lock(directory, VM_LOCK_PATH.name, uid) as lock:
            with _private_desktop_lock(directory, VM_LOCK_PATH.name + ".owners", uid) as gate:
                if wait > 0:
                    _acquire_desktop(gate, fcntl.LOCK_SH, deadline)
                    _acquire_desktop(lock, fcntl.LOCK_EX, deadline)
                    yield
                    return
                # Keep gate acquisition and the desktop try-lock atomic with
                # respect to a newly queued owner. Never hold it during a poll.
                _acquire_desktop(gate, fcntl.LOCK_EX, deadline, busy=OwnerOperationPending)
                _acquire_desktop(lock, fcntl.LOCK_EX, deadline)
            yield
    finally:
        os.close(directory)


def guest(command, payload=None, timeout=8):
    completed = subprocess.run(
        ["/usr/bin/ssh", "-F", str(SSH_CONFIG), SSH_HOST, DISPLAY_ENV + command],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if completed.returncode:
        raise GuestCommandFailed(completed.returncode)
    return completed.stdout


def write_snapshot(path, image):
    if not image.startswith(b"\x89PNG\r\n\x1a\n") or len(image) < 40:
        raise DiagnosticTestError("虚拟桌面没有返回有效截图。", code="send_capture_failed")
    path.write_bytes(image)
    return [int.from_bytes(image[i:i+4], "big") for i in (16, 20)]


def snapshot(path):
    return write_snapshot(path, guest("import -window root png:-"))


def redacted_send_frame(settings, path):
    """Keep the UI evidence used by pixel checks, without any readable text or media."""
    if "window" not in settings or "send_click" not in settings or "size" not in settings:
        return None
    with Image.open(path, formats=("PNG",)) as source:
        if tuple(source.size) != tuple(settings["size"]):
            return None
        image = source.convert("RGB")
    x, y, width, height = settings["window"]
    edge = x + width - 252
    top, bottom = y + 115, y + height - 170
    result = Image.new("RGB", image.size, "black")
    if 1 <= edge < image.width - 1 and 0 <= top < bottom <= image.height:
        result.paste(image.crop((edge - 1, top, edge + 2, bottom)), (edge - 1, top))
    x, y = settings["send_click"]
    button = (x - 16, y - 7)
    if 0 <= button[0] < image.width and 0 <= button[1] < image.height:
        result.putpixel(button, image.getpixel(button))
    return result


def normalize(value):
    return "".join(unicodedata.normalize("NFKC", value).split()).casefold()


# With a microphone present, WeChat 4.1 shows this hint in an empty editor. It is not a draft.
VOICE_INPUT_HINT = re.compile(r"hold(?:ctrl|ctr1)\+?super(?:key)?tousevoiceinput|按住ctrl\+?super(?:键)?(?:使用|以使用)?语音输入")


def typed_lines(lines):
    """OCR lines from the editor that are real text, not WeChat's voice-input hint."""
    return [line for line in lines if not VOICE_INPUT_HINT.fullmatch(normalize(line["text"]))]


def editor_shows_only_hint(settings, path):
    lines = points(settings["ocr"], path, settings["draft"])
    return bool(lines) and not typed_lines(lines)


def ocr_body_matches(observed, expected):
    actual = normalize(observed)
    wanted = normalize(expected)
    return actual == wanted or (
        len(wanted) >= 12 and actual.startswith(wanted) and len(actual) - len(wanted) <= 3
    )


def points(ocr_binary, path, crop):
    x, y, width, height = crop
    return [
        line for line in recognize(ocr_binary, path)
        if x <= line["x"] + line["width"] / 2 < x + width
        and y <= line["y"] + line["height"] / 2 < y + height
    ]


def recognize(ocr_binary, path, crop=None):
    completed = subprocess.run(
        [str(ocr_binary), str(path), *map(str, crop or ())],
        capture_output=True,
        timeout=8,
        check=False,
    )
    if completed.returncode:
        raise DiagnosticTestError("本机 OCR 无法读取虚拟机截图。", code="send_ocr_failed")
    return json.loads(completed.stdout)


def matching(lines, expected):
    return [line for line in lines if normalize(line["text"]) == normalize(expected)]


def conversation_title_matches(text, title, target):
    observed = normalize(text)
    if target == "group":
        observed = re.sub(r"\([0-9]+\)$", "", observed)
    return observed == normalize(title)


def native_group_title(text):
    match = GROUP_HEADER.fullmatch(unicodedata.normalize("NFC", text).strip())
    return match[1] if match else None


def group_row_title_matches(text, title):
    text, title = (unicodedata.normalize("NFC", value) for value in (text, title))
    if text == title:
        return True
    truncated = ROW_TRUNCATION.fullmatch(text)
    if truncated is None:
        return False
    prefix = truncated[1].rstrip()
    return len(prefix) >= 3 and len(prefix) < len(title) and title.startswith(prefix)


def group_chat_rows(settings, path, title, *, active=False, fingerprints=(), lines=None):
    sidebar = settings["search_results"]
    if lines is None:
        lines = points(settings["ocr"], path, sidebar)
    left, top, width, height = sidebar
    avatar_x = left + 11
    expected = set(fingerprints)
    matches = []
    with Image.open(path) as source:
        image = source.convert("RGB")
        for line in lines:
            row_y = line["y"]
            if not left + 40 <= line["x"] <= left + 65 or not top <= row_y <= top + height - 35:
                continue
            text = line["text"]
            if line["x"] + line["width"] >= left + width - 50:
                text_without_time = ROW_TIMESTAMP.sub("", ROW_DATED_TIME.sub("", text))
            else:
                text_without_time = text
            if not (group_row_title_matches(text, title) or group_row_title_matches(text_without_time, title)):
                continue
            if active and image.getpixel((left + 2, row_y + 4)) != SELECTED_CHAT:
                continue
            seen = tuple(hashlib.sha256(image.crop((avatar_x, row_y + shift, avatar_x + 25, row_y + shift + 25))
                                         .tobytes()).hexdigest() for shift in range(-1, 14))
            if not expected or expected.intersection(seen):
                matches.append((line, seen))
    return matches


def click(x, y, button=1):
    guest(f"xdotool mousemove {int(x)} {int(y)} mousedown {int(button)} sleep 0.12 mouseup {int(button)}")


def center(line):
    return line["x"] + line["width"] // 2, line["y"] + line["height"] // 2


def paste(text, replace=False):
    keys = "xdotool key --clearmodifiers ctrl+a; " if replace else ""
    guest(
        keys + "xclip -selection clipboard -in >/dev/null 2>&1 && xdotool key --clearmodifiers ctrl+v",
        text.encode("utf-8"),
    )


def clear_clipboard():
    guest("xclip -selection clipboard -in >/dev/null 2>&1", b"")


def read_draft(settings):
    click(*checked_input(settings["draft_click"], settings["draft"]))
    clear_clipboard()
    try:
        return guest(
            "xdotool key --clearmodifiers ctrl+a ctrl+c && sleep .15 && "
            "xclip -selection clipboard -out -target UTF8_STRING"
        ).decode("utf-8")
    finally:
        guest("xdotool key --clearmodifiers Right")
        clear_clipboard()


def config():
    path = Path(os.environ["DESKPET_WECHAT_VM_CONFIG"])
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value.get("targets"), dict):
        raise TestError("测试收件人尚未绑定。")
    return value


def active_window_classes():
    raw = guest('window=$(xdotool getactivewindow) && xprop -id "$window" WM_CLASS').decode("utf-8")
    return [entry.casefold() for entry in re.findall(r'"([^"]+)"', raw)]


def window_geometry():
    raw = guest('window=$(xdotool getactivewindow) && xwininfo -id "$window"').decode("utf-8")
    fields = ("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")
    return [int(re.search(rf"^\s*{field}:\s+(-?\d+)", raw, re.MULTILINE).group(1)) for field in fields]


def active_window_id():
    window = int(guest("xdotool getactivewindow").strip())
    if window <= 0:
        raise TestError("无法确认虚拟机里的活动窗口。", code="send_window_missing")
    return window


def wechat_desktop(calibrated_geometry=None):
    fallback = ""
    if calibrated_geometry is not None:
        left, top, width, height = map(int, calibrated_geometry)
        fallback = f"{left} {top} {width} {height}"
    raw = guest(WECHAT_X11_IDENTITY + f"calibrated='{fallback}'\n" + r'''
        export LC_ALL=C
        root=$(xprop -root _NET_CLIENT_LIST) || exit 1
        case "$root" in
            '_NET_CLIENT_LIST(WINDOW): window id #'*) windows=${root#*window id #} ;;
            '_NET_CLIENT_LIST(WINDOW):'|'_NET_CLIENT_LIST:  not found.') windows= ;;
            *) exit 1 ;;
        esac
        active=$(xdotool getactivewindow 2>/dev/null) || active=0
        printf '%s\n' "$active"
        managed=
        set -f
        set -- $(printf '%s' "$windows" | tr ',' ' ')
        [ "$#" -le 64 ] || exit 1
        for window do
            case "$window" in 0x*) ;; *) exit 1 ;; esac
            hex=${window#0x}
            case "$hex" in ''|*[!0-9a-fA-F]*) exit 1 ;; esac
            [ "${#hex}" -le 8 ] || exit 1
            managed="$managed $(printf '%d' "$window")"
        done
        searched=
        if [ -n "$calibrated" ]; then
            # Unmapping a Qt window can remove it from Openbox's managed list.
            # Search includes hidden windows; identities and geometry are still checked below.
            searched=$(xdotool search --maxdepth 3 --limit 65 --class '^wechat$' 2>/dev/null) || searched=
        fi
        set -- $searched
        [ "$#" -le 64 ] || exit 1
        seen=' '
        for window in $managed "$@"; do
            case "$window" in ''|0*|*[!0-9]*) exit 1 ;; esac
            [ "${#window}" -le 10 ] && [ "$window" -le 4294967295 ] || exit 1
            case "$seen" in *" $window "*) continue ;; esac
            seen="$seen$window "
            props=$(wechat_window_props "$window") || continue
            geometry=$(wechat_window_geometry "$window") || continue
            role=other
            if wechat_normal_window "$props"; then role=normal; fi
            case "$managed " in
                *" $window "*) ;;
                *) [ "$role" = normal ] && [ "${geometry% *}" = "$calibrated" ] || continue ;;
            esac
            printf '0x%x %s %s\n' "$window" "$role" "$geometry"
        done
    ''').decode("ascii").splitlines()
    active, *rows = raw
    windows = []
    for row in rows:
        xid, role, x, y, width, height, mapped = row.split()
        if role not in {"normal", "other"} or mapped not in {"IsViewable", "IsUnMapped", "IsUnviewable"}:
            raise TestError("无法识别虚拟桌面的微信窗口状态。")
        windows.append(WeChatWindow(int(xid, 16), (int(x), int(y), int(width), int(height)),
                                    mapped == "IsViewable", role == "normal"))
    return WeChatDesktop(int(active), tuple(windows))


def restore_wechat_window(window):
    x, y, width, height = window.geometry
    # Revalidate the immutable target inside the same guest command as the X11 action.
    guest(WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        window={int(window.xid)}
        props=$(wechat_window_props "$window") && wechat_normal_window "$props" || exit 1
        geometry=$(wechat_window_geometry "$window") || exit 1
        [ "${{geometry% *}}" = '{x:d} {y:d} {width:d} {height:d}' ] || exit 1
        xdotool windowmap "$window" windowactivate --sync "$window"
    ''')


def start_stopped_wechat_desktop():
    result = guest(WECHAT_DESKTOP_SERVICE + WECHAT_X11_IDENTITY + r'''
        state=$(systemctl show -p ActiveState --value "$unit") || exit 1
        if [ "$state" = activating ]; then printf starting; exit 0; fi
        for pid in $(ps -u "$(id -u)" -o pid=); do
            if official_wechat "$pid"; then printf tray_hidden; exit 0; fi
        done
        case "$state" in
            inactive|failed)
                sudo -n systemctl start --no-block "$unit" >/dev/null || exit 1
                printf starting ;;
            *) printf unavailable ;;
        esac
    ''')
    outcome = result.decode("ascii")
    return outcome if outcome in {"starting", "unavailable", "tray_hidden"} else "unavailable"


WECHAT_LOGIN_LABELS = frozenset(normalize(label) for label in (
    "Log In", "Scan QR Code to Log In", "Scan the QR code to log in", "Switch Account",
    "登录", "扫码登录", "请使用微信扫码登录", "使用微信扫描二维码登录", "切换账号", "切换帐号",
))


def visible_wechat_state(settings, path, window):
    if not window.mapped or snapshot(path) != settings["size"] or active_window_id() != window.xid:
        return "layout_changed"
    if window.normal and window.geometry == tuple(settings["window"]) and any(
        normalize(line["text"]) in {"search", "搜索"} for line in points(settings["ocr"], path, settings["search"])
    ):
        return "already_open"
    _, _, width, height = window.geometry
    if width <= 560 and height <= 640 and any(
        normalize(line["text"]) in WECHAT_LOGIN_LABELS for line in points(settings["ocr"], path, window.geometry)
    ):
        return "login_required"
    return "layout_changed"


def recover_window(settings, path):
    """Inspect or restore the official guest window. The caller holds vm_operation()."""
    if settings.get("window_class", "").casefold() != "wechat":
        return "layout_changed"
    geometry = tuple(settings["window"])

    def read_desktop():
        try:
            return wechat_desktop(geometry)
        except (TestError, OSError, ValueError, subprocess.TimeoutExpired):
            return None

    try:
        desktop = read_desktop()
        started = False
        if desktop is None or not desktop.windows:
            outcome = start_stopped_wechat_desktop()
            if outcome != "starting":
                return outcome
            started = True
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                time.sleep(0.5)
                desktop = read_desktop()
                if desktop is not None and desktop.windows:
                    break
        if desktop is None or not desktop.windows:
            return "unavailable"
        if realign_wechat(settings, desktop) is not None:
            desktop = read_desktop()
            if desktop is None or not desktop.windows:
                return "unavailable"
        normal = tuple(window for window in desktop.windows if window.normal)
        calibrated = tuple(window for window in normal if window.geometry == geometry)
        if len(normal) > 1:
            return "ambiguous_window"
        active = next((window for window in desktop.windows if window.xid == desktop.active), None)
        if active is not None and active.mapped:
            outcome = visible_wechat_state(settings, path, active)
            return "restored" if started and outcome == "already_open" else outcome
        if len(calibrated) != 1:
            return "layout_changed"
        restore_wechat_window(calibrated[0])
        desktop = wechat_desktop(geometry)
        active = next((window for window in desktop.windows if window.xid == calibrated[0].xid), None)
        if active is None or desktop.active != active.xid:
            return "unavailable"
        outcome = visible_wechat_state(settings, path, active)
        return "restored" if outcome == "already_open" else outcome
    except (TestError, OSError, ValueError, subprocess.TimeoutExpired):
        return "unavailable"


def click_send(x, y, window, geometry=None):
    expected = "" if geometry is None else " ".join(str(int(item)) for item in geometry) + " IsViewable"
    result = guest(WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        window={int(window)}
        expected='{expected}'
        props=$(wechat_window_props "$window")
        if [ "$(xdotool getactivewindow)" != "$window" ] || ! wechat_normal_window "$props" ||
            {{ [ -n "$expected" ] && [ "$(wechat_window_geometry "$window")" != "$expected" ]; }}; then
            printf changed
        else
            xdotool mousemove {int(x)} {int(y)} mousedown 1 sleep 0.12 mouseup 1
        fi
    ''')
    if result == b"changed":
        raise SendWindowChanged("发送前微信窗口已改变，未发送。")


def checked_input(configured_point, area):
    x, y = map(int, configured_point)
    left, top, width, height = area
    if not left <= x < left + width or not top <= y < top + height:
        raise TestError("已配置的键鼠坐标超出预期区域。", code="send_input_bounds")
    return x, y


CAPTURE_FAILURES = {
    41: "虚拟桌面没有可用的活动窗口。",
    42: "虚拟桌面的活动窗口不是已验证的微信主窗口。",
    43: "无法读取微信主窗口的位置和大小。",
    44: "微信主窗口不可见，或位置大小与设置不符。",
    45: "虚拟桌面截图命令执行失败。",
    46: "截图期间，微信主窗口的位置或焦点已改变。",
}
CAPTURE_CODES = {41: "send_window_missing", 42: "send_window_identity", 43: "send_window_geometry",
                 44: "send_window_geometry", 45: "send_capture_failed", 46: "send_window_changed"}


def capture_wechat(settings, path):
    if settings["window_class"].casefold() != "wechat":
        raise DiagnosticTestError("配置的窗口类型不是微信。", code="send_window_identity")
    x, y, width, height = map(int, settings["window"])
    try:
        image = guest(WECHAT_X11_IDENTITY + f'''
            export LC_ALL=C
            window=$(xdotool getactivewindow 2>/dev/null) || exit 41
            props=$(wechat_window_props "$window") && wechat_normal_window "$props" || exit 42
            geometry=$(wechat_window_geometry "$window") || exit 43
            [ "$geometry" = '{x} {y} {width} {height} IsViewable' ] || exit 44
            import -window root png:- || exit 45
            [ "$(xdotool getactivewindow)" = "$window" ] &&
                [ "$(wechat_window_geometry "$window")" = "$geometry" ] || exit 46
        ''')
    except GuestCommandFailed as error:
        if error.returncode not in CAPTURE_FAILURES:
            raise
        raise WindowCaptureError(error.returncode) from error
    if write_snapshot(path, image) != settings["size"]:
        raise DiagnosticTestError("虚拟桌面尺寸已变化，请重新核对测试会话。", code="send_window_geometry")


def refocus_wechat(settings):
    """Restore focus only to the single verified, calibrated WeChat window."""
    geometry = tuple(settings["window"])
    desktop = wechat_desktop(geometry)
    normal = [window for window in desktop.windows if window.normal]
    if len(normal) != 1 or normal[0].geometry != geometry:
        return False
    if any(window.mapped and not window.normal for window in desktop.windows):
        return False
    window = normal[0]
    if desktop.active == window.xid and window.mapped:
        return False
    restore_wechat_window(window)
    return True


def realign_wechat(settings, desktop=None):
    """Move the single verified WeChat window back to its calibrated place.

    The window manager can re-place a re-shown window with a cascade offset. Only the
    position is restored; a changed size means a changed layout and stays for the owner.
    """
    geometry = tuple(settings["window"])
    desktop = wechat_desktop(geometry) if desktop is None else desktop
    normal = [window for window in desktop.windows if window.normal]
    if len(normal) != 1 or any(window.mapped and not window.normal for window in desktop.windows):
        return None
    window = normal[0]
    x, y, width, height = map(int, geometry)
    if not window.mapped or window.geometry == geometry or window.geometry[2:] != (width, height):
        return None
    left, top = window.geometry[:2]
    guest(WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        window={int(window.xid)}
        props=$(wechat_window_props "$window") && wechat_normal_window "$props" || exit 1
        [ "$(wechat_window_geometry "$window")" = '{left} {top} {width} {height} IsViewable' ] || exit 1
        xdotool windowmove --sync "$window" {x} {y} windowactivate --sync "$window"
        [ "$(wechat_window_geometry "$window")" = '{x} {y} {width} {height} IsViewable' ] || exit 1
    ''')
    return left, top


def focus_wechat_editor(settings, window, *, clear=False, image_png=None):
    x, y = checked_input(settings["draft_click"], settings["draft"])
    left, top, width, height = map(int, settings["window"])
    operation = ("xdotool key --clearmodifiers ctrl+a BackSpace" if clear else
                 "xclip -selection clipboard -t image/png -in >/dev/null 2>&1 && "
                 "xdotool key --clearmodifiers ctrl+v")
    guest(WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        window={int(window)}
        [ "$(xdotool getactivewindow)" = "$window" ] || exit 1
        props=$(wechat_window_props "$window") && wechat_normal_window "$props" || exit 1
        [ "$(wechat_window_geometry "$window")" = '{left} {top} {width} {height} IsViewable' ] || exit 1
        xdotool mousemove {x} {y} click 1 && {operation} && xdotool mousemove {left + 305} {top + 45}
    ''', image_png)


def verify_title(settings, path, target):
    capture_wechat(settings, path)
    title = settings["targets"][target]["title"]
    header = points(settings["ocr"], path, settings["header"])
    friend = settings.get("_bound_friend") if target == "private" else None
    if friend is not None:
        return bool(active_friend_avatars(settings, path, header, fingerprints=friend.fingerprints))
    group = settings.get("_bound_group")
    if target == "group" and group is not None:
        if sum(native_group_title(line["text"]) == title for line in header) != 1:
            return False
        rows = group_chat_rows(settings, path, title, active=True, fingerprints=group.fingerprints)
        if len(rows) == 1:
            return True
        sidebar = recognize(settings["ocr"], path, settings["search_results"])
        return len(group_chat_rows(settings, path, title, active=True, fingerprints=group.fingerprints, lines=sidebar)) == 1
    return sum(conversation_title_matches(line["text"], title, target) for line in header) == 1


def active_friend_avatars(settings, path, header, *, fingerprints=()):
    title = settings["targets"]["private"]["title"]
    if sum(unicodedata.normalize("NFC", line["text"]).strip() == title for line in header) != 1:
        return ()
    rows = group_chat_rows(settings, path, title, active=True, fingerprints=fingerprints)
    if not rows:
        lines = recognize(settings["ocr"], path, settings["search_results"])
        rows = group_chat_rows(settings, path, title, active=True, fingerprints=fingerprints, lines=lines)
    return rows[0][1] if len(rows) == 1 else ()


def search_matches(lines, target, title, *, allow_truncated=False):
    """Use only contact or group search results, never matching message snippets."""
    wanted = {"private": {"contacts", "联系人"}, "group": {"groups", "groupchats", "群聊"}}[target]
    headings = wanted | {"contacts", "联系人", "groups", "groupchats", "群聊", "messages", "聊天记录",
                         "chathistory", "searchhistory", "搜索历史", "features", "功能", "websearch", "搜一搜",
                         "internetsearchresults", "网络搜索结果"}
    section = None
    results = []
    for line in sorted(lines, key=lambda item: item["y"]):
        name = normalize(line["text"])
        if name in headings:
            section = name
        if section in wanted and (name == normalize(title) or (
            target == "group" and allow_truncated and group_row_title_matches(line["text"], title)
        )):
            results.append(line)
    return results


def open_target(settings, path, target, *, search_only=False):
    target_info = settings["targets"].get(target)
    if not isinstance(target_info, dict) or not target_info.get("title"):
        raise DiagnosticTestError("这个测试会话还没绑定。", code="send_target_unbound")
    title = target_info["title"]
    if not search_only and verify_title(settings, path, target):
        return
    window = None
    if search_only:
        window = active_window_id()
        capture_wechat(settings, path)
    ocr = settings["ocr"]
    # A visible conversation row is faster and avoids mixing search hits with chat text.
    search_box = [] if search_only else points(ocr, path, settings["search"])
    sidebar = settings["search_results"]
    group = settings.get("_bound_group") if target == "group" else None
    if search_only:
        rows = []
    elif group is None:
        rows = matching(points(ocr, path, sidebar), title)
    else:
        rows = [line for line, _ in group_chat_rows(settings, path, title, fingerprints=group.fingerprints)]
    if len(rows) == 1 and any(normalize(line["text"]) in {"search", "搜索"} for line in search_box):
        click(*center(rows[0]))
        time.sleep(0.35)
    else:
        if window is not None and active_window_id() != window:
            raise SendWindowChanged("搜索前微信主窗口已改变。")
        click(*checked_input(settings["search_click"], settings["search"]))
        try:
            paste(target_info.get("query", title), replace=True)
            time.sleep(0.65)
        finally:
            clear_clipboard()
        capture_wechat(settings, path)
        results = search_matches(points(ocr, path, sidebar), target, target_info.get("result_title", title),
                                 allow_truncated=group is not None and not search_only)
        if window is not None and active_window_id() != window:
            raise SendWindowChanged("选择搜索结果前微信主窗口已改变。")
        if len(results) != 1:
            guest("xdotool key --clearmodifiers Escape")
            raise DiagnosticTestError("搜索结果中没有唯一匹配的已绑定会话。", code="send_target_ambiguous")
        click(*center(results[0]))
        time.sleep(0.45)
    if not verify_title(settings, path, target):
        raise DiagnosticTestError("当前微信会话标题与已绑定目标不匹配。", code="title_mismatch")
    if window is not None and active_window_id() != window:
        raise SendWindowChanged("选择搜索结果后微信主窗口已改变。")


def conversation_messages(settings, path, target):
    from wechat_messages import extract_messages

    messages = extract_messages(
        path, recognize(settings["ocr"], path), settings["chat"], target=target,
        account_name=settings.get("account_name", "DeskPet"),
        peer_name=settings["targets"][target]["title"],
    )
    if target != "private":
        return messages
    return tuple(recover_cron_slash(settings, path, message) for message in messages)


def recover_cron_slash(settings, path, message):
    """Trust a corrected slash only when cropped OCR agrees on the entire command."""
    if (message.direction != "incoming" or message.sender != settings["targets"]["private"]["title"]
            or not MISREAD_CRON_ONCE.match(message.text)):
        return message
    x, y, width, height = message.box
    if width <= 4 or height <= 4:
        return message
    try:
        lines = recognize(settings["ocr"], path, (x + 2, y + 2, width - 4, height - 4))
    except (TestError, OSError, ValueError, subprocess.SubprocessError):
        return message
    from wechat_messages import key

    cropped = "\n".join(line["text"].strip() for line in sorted(lines, key=lambda line: (line["y"], line["x"])))
    corrected = "/" + message.text[1:]
    if not cropped.startswith("/") or key(cropped) != key(corrected):
        return message
    return replace(message, text=corrected)


def quote_preview_matches(lines, original):
    expected = normalize(f"{original.sender}:{original.text}")
    for line in lines:
        preview = normalize(line["text"]).lstrip("|丨一")
        if preview == expected:
            return True
        prefix = preview.rstrip(".…")
        if prefix != preview and len(prefix) >= len(normalize(original.sender)) + 9 and expected.startswith(prefix):
            return True
    return False


def quote_close_point(settings, path):
    """The close glyph of a native quote preview: a light-gray disc right of its text."""
    lines = points(settings["ocr"], path, settings["quote_preview"])
    if not lines:
        return None
    left, top, width, height = settings["quote_preview"]
    start = max(line["x"] + line["width"] for line in lines) + 4
    row = round(sum(line["y"] + line["height"] / 2 for line in lines) / len(lines))
    columns = []
    with Image.open(path) as frame:
        image = frame.convert("RGB")
        for x in range(start, min(left + width, start + 60, image.width)):
            pixels = [image.getpixel((x, y)) for y in range(max(top, row - 7), min(top + height, row + 8, image.height))]
            columns.append((x, sum(1 for pixel in pixels
                                   if 195 <= sum(pixel) / 3 <= 238 and max(pixel) - min(pixel) <= 12) >= 3))
    run = []
    for x, hit in columns:
        if hit:
            run.append(x)
        elif len(run) >= 8:
            break
        else:
            run = []
    return (run[len(run) // 2], row) if 8 <= len(run) <= 24 else None


def clear_quote_preview(settings, path):
    """Close a native quote preview; True when none is left."""
    capture_wechat(settings, path)
    point = quote_close_point(settings, path)
    if point is not None:
        click(*point)
        time.sleep(0.4)
        capture_wechat(settings, path)
    return not points(settings["ocr"], path, settings["quote_preview"])


def discard_staged_draft(settings, path):
    """Remove the text and quote this attempt staged but never sent."""
    try:
        click(*checked_input(settings["draft_click"], settings["draft"]))
        guest("xdotool key --clearmodifiers ctrl+a BackSpace")
        if "quote_preview" in settings:
            clear_quote_preview(settings, path)
    except Exception:  # noqa: BLE001 - best effort; the caller re-raises the original failure.
        pass


def verified_quote_preview(settings, path, original):
    area = settings["quote_preview"]
    if quote_preview_matches(points(settings["ocr"], path, area), original):
        return True
    # Full-frame OCR can merge the quote-close glyph with its text. Re-read
    # only the calibrated preview rectangle before comparing exact text again.
    cropped = subprocess.run([settings["ocr"], str(path), *map(str, area)],
                             capture_output=True, timeout=8, check=False)
    return cropped.returncode == 0 and quote_preview_matches(json.loads(cropped.stdout), original)


COPY_LIMIT = 16384


def copy_private_message(settings, path, original, *, outgoing=False):
    """Copy one verified private bubble without touching the composer."""
    direction = "outgoing" if outgoing else "incoming"
    sender = settings["account_name"] if outgoing else settings["targets"]["private"]["title"]
    if (original.direction != direction or original.sender != sender
            or original.quoted_sender or original.quoted_text):
        raise TestError("只能复制已验证私聊中的单条原始消息。")
    return _copy_message(settings, path, original, "private")


def copy_group_sticker_message(settings, path, original):
    """Read original text from a verified incoming group sticker command candidate."""
    if (settings.get("_bound_group") is None or original.direction != "incoming" or not original.sender
            or original.quoted_sender or original.quoted_text):
        raise TestError("只能复制已验证群聊中的单条原始消息。")
    return _copy_message(settings, path, original, "group")


def _copy_message(settings, path, original, target):
    from wechat_messages import bubble_boxes

    left, top, width, height = original.box
    rectangle = (left, top, left + width, top + height)
    with Image.open(path) as frame:
        pixels = frame.crop(rectangle).convert("RGB").tobytes()
    window = active_window_id()
    if not verify_title(settings, path, target) or active_window_id() != window:
        raise TestError("复制前微信会话已改变。")
    with Image.open(path) as frame:
        if ((original.direction, tuple(original.box)) not in bubble_boxes(frame, settings["chat"])
                or frame.crop(rectangle).convert("RGB").tobytes() != pixels):
            raise TestError("复制前微信气泡已改变。")

    x, y = original.center
    nonce = secrets.token_hex(24).encode("ascii")
    menu_open = False
    try:
        guest("xclip -selection clipboard -in >/dev/null 2>&1", nonce)
        menu_open = True
        click(x, y, button=3)
        time.sleep(0.28)
        capture_wechat(settings, path)
        if active_window_id() != window:
            raise TestError("微信复制菜单不在原窗口。")
        screen_width, screen_height = settings["size"]
        menu_left, menu_top = max(0, x - 170), max(0, y - 345)
        region = (menu_left, menu_top, min(screen_width, x + 195) - menu_left,
                  min(screen_height, y + 345) - menu_top)
        labels = recognize(settings["ocr"], path, region)
        menu = [label for label in labels if re.sub(r"^[^a-z\u3400-\u9fff]+", "", normalize(label["text"]))
                in {"copy", "复制"}]
        if len(menu) != 1 or active_window_id() != window:
            raise TestError("无法在目标气泡的菜单里确认唯一的原生复制按钮。")
        menu_x, menu_y = center(menu[0])
        click(menu_x, menu_y)
        menu_open = False
        time.sleep(0.15)
        copied = guest(f"timeout 2 xclip -selection clipboard -out -target UTF8_STRING | head -c {COPY_LIMIT + 1}")
        if not copied or copied == nonce or len(copied) > COPY_LIMIT:
            raise TestError("微信没有把目标气泡原文写入剪贴板。")
        value = copied.decode("utf-8")
        if "\x00" in value or not verify_title(settings, path, target) or active_window_id() != window:
            raise TestError("复制后的原文或微信会话未能验证。")
        with Image.open(path) as frame:
            if frame.crop(rectangle).convert("RGB").tobytes() != pixels:
                raise TestError("复制时微信气泡发生了变化。")
        return value
    finally:
        try:
            if menu_open and active_window_id() == window:
                guest("xdotool key --clearmodifiers Escape")
        finally:
            clear_clipboard()


def open_quote(settings, path, target, original, *, resolve_group_quote=None):
    window = None
    if resolve_group_quote is not None:
        window = active_window_id()
        if (target != "group" or settings.get("_bound_group") is None
                or not verify_title(settings, path, target) or active_window_id() != window
                or resolve_group_quote(conversation_messages(settings, path, target)) != original
                or active_window_id() != window):
            raise TestError("无法确认最新的重复群消息，未引用。", code="send_anchor_mismatch")
    x, y = original.center
    click(x, y, button=3)
    time.sleep(0.35)
    snapshot(path)
    width, height = settings["size"]
    left, top = max(0, x - 170), max(0, y - 345)
    menu_region = [left, top, min(width, x + 195) - left, min(height, y + 345) - top]
    cropped = subprocess.run(
        [settings["ocr"], str(path), *map(str, menu_region)],
        capture_output=True, timeout=8, check=False,
    )
    lines = json.loads(cropped.stdout) if cropped.returncode == 0 else []
    def quote_items(items):
        return [
            item for item in items
            if re.sub(r"^[^a-z\u3400-\u9fff]+", "", normalize(item["text"])) in {"quote", "引用"}
            and abs(item["x"] - x) < 180 and abs(item["y"] - y) < 340
        ]

    menu = quote_items(lines)
    if not menu:
        menu = quote_items(recognize(settings["ocr"], path))
    if len(menu) != 1 or (window is not None and active_window_id() != window):
        guest("xdotool key --clearmodifiers Escape")
        raise TestError("无法在目标气泡的菜单里确认原生引用按钮。", code="send_quote_menu_missing")
    click(*center(menu[0]))
    time.sleep(0.35)
    if not verify_title(settings, path, target) or not verified_quote_preview(settings, path, original):
        raise TestError("原生引用草稿与指定发言不符，未发送。", code="send_quote_mismatch")


def outgoing_receipt(messages, message, original):
    from wechat_messages import key

    matches = []
    for item in messages:
        if item.direction != "outgoing":
            continue
        if original is None:
            if not item.quoted_sender and not item.quoted_text and normalize(item.text) == normalize(message):
                matches.append(item)
        elif (quoted_receipt_text_matches(item.text, message) and key(item.quoted_sender) == key(original.sender)
              and key(item.quoted_text) == key(original.text)):
            matches.append(item)
    return matches


RECEIPT_URL = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+", re.IGNORECASE)


def quoted_receipt_text_matches(observed, expected):
    urls = RECEIPT_URL.findall(expected)
    if not urls:
        return ocr_body_matches(observed, expected)
    # A wrapped URL is the same literal token only when every character
    # survives. Confusable glyphs and URL case are deliberately significant.
    joined = "".join(observed.split())
    for url in urls:
        if joined.count(url) != expected.count(url):
            return False
        joined = joined.replace(url, "\x00")
        expected = expected.replace(url, "\x00")
    if RECEIPT_URL.search(joined):
        return False
    return normalize(joined) == normalize(expected)


def fresh_outgoing_receipt(previous, current, message, original, *, target=None, previously_confirmed_part=None):
    if not previous:
        return len(outgoing_receipt(current, message, original)) == 1
    before = tuple(item.identity for item in previous)
    after = tuple(item.identity for item in current)
    if before == after:
        return False
    overlaps = [count for count in range(1, min(len(before), len(after)) + 1) if before[-count:] == after[:count]]
    if not overlaps:
        for count in range(3, min(len(before), len(after)) + 1):
            aligned = tuple(zip(previous[-count:], current[:count]))
            changed = [(old, new) for old, new in aligned if old.identity != new.identity]
            if len(changed) == 1 and outgoing_ocr_drift(*changed[0]):
                overlaps.append(count)
        if not overlaps and original is not None and original.identity in before:
            # A native quote provides a second, independent anchor when a
            # repaint briefly changes the older context read by OCR.
            matching_positions = [index for index, item in enumerate(current) if item.identity == original.identity]
            if len(matching_positions) == 1:
                matches = outgoing_receipt(current[matching_positions[0] + 1:], message, original)
                if len(matches) == 1 and not outgoing_receipt(previous, message, original):
                    return True
        if not overlaps:
            return target == "private" and original is None and private_tail_receipt(
                previous, current, message, previously_confirmed_part=previously_confirmed_part,
            )
    # Repeated text must belong to the new suffix regardless of how repeated
    # messages align across the two views. Existing matching bubbles prove nothing.
    matches = [tuple(outgoing_receipt(current[count:], message, original)) for count in overlaps]
    return len(matches[0]) == 1 and all(candidate == matches[0] for candidate in matches)


def private_tail_receipt(previous, current, message, *, previously_confirmed_part=None):
    """Confirm the adjacent reply when OCR loses older private conversation text."""
    if len(current) < 2 or outgoing_receipt(previous, message, None):
        return False
    anchor = previous[-1]
    visible_anchor, reply = current[-2:]
    if (not anchor.sender or anchor.identity != visible_anchor.identity
            or (anchor.box[0], *anchor.box[2:]) != (visible_anchor.box[0], *visible_anchor.box[2:])):
        return False
    if previously_confirmed_part is None:
        if anchor.direction != "incoming":
            return False
    elif (outgoing_receipt(previous, previously_confirmed_part, None) != [anchor]
          or outgoing_receipt(current, previously_confirmed_part, None) != [visible_anchor]):
        return False
    gap = reply.box[1] - (visible_anchor.box[1] + visible_anchor.box[3])
    return (0 <= gap <= 100 and outgoing_receipt(current, message, None) == [reply]
            and all(sum(item.identity == anchor.identity for item in frame) == 1 for frame in (previous, current)))


def outgoing_ocr_drift(before, after):
    from wechat_messages import key

    if (before.direction != "outgoing" or after.direction != "outgoing"
            or key(before.sender) != key(after.sender) or key(before.quoted_sender) != key(after.quoted_sender)
            or (before.box[0], *before.box[2:]) != (after.box[0], *after.box[2:])):
        return False
    left, right = normalize(before.text), normalize(after.text)
    before_quote, after_quote = key(before.quoted_text), key(after.quoted_text)
    quote_matches = before_quote == after_quote or (
        min(len(before_quote), len(after_quote)) >= 12
        and SequenceMatcher(None, before_quote, after_quote, autojunk=False).ratio() >= 0.93
    )
    return (quote_matches and min(len(left), len(right)) >= 20
            and SequenceMatcher(None, left, right, autojunk=False).ratio() >= 0.95)


def prepare_sticker(image_png):
    """Normalize a caller-approved PNG into one bounded, metadata-free image."""
    if type(image_png) is not bytes or not image_png.startswith(b"\x89PNG\r\n\x1a\n") or len(image_png) > 2_000_000:
        raise TestError("微信表情必须是已选中的 PNG 图片。")
    try:
        with Image.open(BytesIO(image_png), formats=("PNG",)) as original:
            if original.is_animated or not all(32 <= side <= 2048 for side in original.size):
                raise TestError("微信表情图片尺寸不受支持。")
            thumbnail = ImageOps.contain(original.convert("RGBA"), (240, 240), Image.Resampling.LANCZOS)
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise TestError("无法读取已选中的微信表情图片。") from error
    asset = Image.new("RGB", (240, 240), "white")
    asset.paste(thumbnail, ((240 - thumbnail.width) // 2, (240 - thumbnail.height) // 2), thumbnail.getchannel("A"))
    if max(ImageStat.Stat(asset.resize((32, 32))).stddev) < 15:
        raise TestError("微信表情图片缺少可核对的图案。")
    encoded = BytesIO()
    asset.save(encoded, format="PNG")
    return encoded.getvalue(), asset


def sticker_image_signature(image):
    inset = round(image.width * 0.04)
    inner = image.crop((inset, inset, image.width - inset, image.height - inset))
    return inner.resize((32, 32), Image.Resampling.BILINEAR)


def matches_sticker_image(image, box, signature):
    x, y, size = box
    if x < 0 or y < 0 or x + size > image.width or y + size > image.height:
        return False
    observed = sticker_image_signature(image.crop((x, y, x + size, y + size)))
    difference = ImageChops.difference(observed, signature)
    return max(ImageStat.Stat(difference).mean) <= 8


def editor_pixels_blank(image, box):
    left, top, width, height = box
    # Ignore the caret and antialiased edge. Any appreciable dark or colored
    # content in the editing area, including another image, blocks operation.
    crop = image.crop((left, top, left + width, top + height))
    pixels = crop.load()
    occupied = [(x, y) for y in range(crop.height) for x in range(crop.width)
                if min(pixels[x, y]) < 212 or max(pixels[x, y]) - min(pixels[x, y]) > 10]
    if len(occupied) <= 12:
        return True
    if len(occupied) > 32:
        return False
    columns = [x for x, _ in occupied]
    rows = [y for _, y in occupied]
    return (max(columns) - min(columns) <= 1 and max(rows) - min(rows) <= 22
            and all(pixels[x, y][1] >= 130 and pixels[x, y][1] > pixels[x, y][0] + 40 for x, y in occupied))


def sticker_region_in_frame(image, box):
    x, y, width, height = box
    return 0 <= x < x + width <= image.width and 0 <= y < y + height <= image.height


def sticker_editor_ready(settings, path):
    x, y, width, height = settings["draft"]
    send_x, send_y = settings["send_click"]
    draft = x + 8, y + 5, width - 14, height - 10
    button = send_x - 16, send_y - 7, 1, 1
    with Image.open(path) as capture:
        image = capture.convert("RGB")
        if not (sticker_region_in_frame(image, draft) and sticker_region_in_frame(image, button)
                and image.getpixel(button[:2]) == (237, 237, 237)):
            return False
        blank = editor_pixels_blank(image, draft)
    return blank or editor_shows_only_hint(settings, path)


def sticker_draft_verified(settings, path, signature):
    left, top, width, height = settings["window"]
    x, y = left + 325, top + height - 257
    send_x, send_y = settings["send_click"]
    editor_suffix = x + 205, y + 2, left + width - x - 222, 197
    button = send_x - 16, send_y - 7, 1, 1
    with Image.open(path) as capture:
        image = capture.convert("RGB")
        if (not sticker_region_in_frame(image, editor_suffix) or not sticker_region_in_frame(image, button)
                or image.getpixel(button[:2]) != (0, 185, 111)
                or not matches_sticker_image(image, (x, y, 200), signature)
                or not editor_pixels_blank(image, editor_suffix)):
            return False
    labels = points(settings["ocr"], path, settings["send"])
    return sum(normalize(line["text"]) in {"send", "发送"} for line in labels) == 1


def receipt_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")).hexdigest()


def text_attempt_proof(previous, message, original):
    from wechat_messages import key

    return {"kind": "text", "before": [receipt_digest(item.identity) for item in previous[-16:]],
            "text": message, "quote": receipt_digest([key(original.sender), key(original.text)]) if original else None}


def text_attempt_matches(proof, messages, account_name):
    from wechat_messages import key

    before, text = proof.get("before"), proof.get("text")
    if not isinstance(before, list) or not 1 <= len(before) <= 16 or not isinstance(text, str):
        return False
    current = [receipt_digest(item.identity) for item in messages]
    overlaps = [count for count in range(1, min(len(before), len(current)) + 1)
                if before[-count:] == current[:count]]
    if not overlaps:
        return False
    expected_quote = proof.get("quote")

    def matches(item):
        if item.direction != "outgoing" or key(item.sender) != key(account_name):
            return False
        if expected_quote is None:
            return not item.quoted_sender and not item.quoted_text and normalize(item.text) == normalize(text)
        return receipt_digest([key(item.quoted_sender), key(item.quoted_text)]) == expected_quote \
            and quoted_receipt_text_matches(item.text, text)

    # Every viable alignment must identify the same new outgoing bubble.
    found = [tuple(index for index in range(count, len(messages)) if matches(messages[index])) for count in overlaps]
    return len(found[0]) == 1 and all(candidate == found[0] for candidate in found)


def receipt_image_fingerprint(image):
    # Save comparison features only. The screenshot and the asset stay out of SQLite proofs.
    small = image.convert("RGB").resize((9, 9), Image.Resampling.BILINEAR)
    gray = small.convert("L")
    pixels = gray.load()
    horizontal = vertical = 0
    for y in range(8):
        for x in range(8):
            horizontal = (horizontal << 1) | (pixels[x, y] > pixels[x + 1, y] + 2)
            vertical = (vertical << 1) | (pixels[x, y] > pixels[x, y + 1] + 2)
    colors = [round(mean / 16) for mean in ImageStat.Stat(small).mean]
    return [horizontal, vertical, *colors]


def matches_receipt_fingerprint(image, expected):
    found = receipt_image_fingerprint(image)
    for value in expected:
        if not isinstance(value, list) or len(value) != 5 or any(type(item) is not int for item in value):
            continue
        # Reject featureless thumbnails and require independent edge and color matches.
        if value[0].bit_count() + value[1].bit_count() >= 8 and sum(
            (a ^ b).bit_count() for a, b in zip(found[:2], value[:2])
        ) <= 10 and all(abs(a - b) <= 1 for a, b in zip(found[2:], value[2:])):
            return True
    return False


def media_attempt_proof(kind, anchor, anchor_pixels, signatures):
    return {"kind": kind, "anchor": receipt_digest(anchor.identity),
            "box": list(anchor.box), "anchor_pixels": hashlib.sha256(anchor_pixels).hexdigest(),
            "fingerprints": [receipt_image_fingerprint(item) for item in signatures]}


def media_attempt_anchor(proof, messages, path):
    # The same last text bubble must still be present with unchanged pixels.
    expected = proof.get("box")
    if not messages or not isinstance(expected, list) or len(expected) != 4:
        return None
    anchor = messages[-1]
    if (receipt_digest(anchor.identity) != proof.get("anchor")
            or sum(item.identity == anchor.identity for item in messages) != 1
            or (anchor.box[0], *anchor.box[2:]) != (expected[0], *expected[2:])):
        return None
    with Image.open(path) as frame:
        digest = hashlib.sha256(private_bubble_pixels(frame, anchor)).hexdigest()
    return anchor if digest == proof.get("anchor_pixels") else None


def sticker_receipt_box(settings, path, signature, anchor, *, fingerprints=None):
    left, top, width, height = settings["chat"]
    right = left + width - 61
    minimum_y = max(top, anchor.box[1] + anchor.box[3] + 6)
    maximum_y = min(top + height, minimum_y + 100)
    with Image.open(path) as capture:
        image = capture.convert("RGB")
        if not sticker_region_in_frame(image, (left, top, width, height)):
            return None
        for size in (200, 180, 160, 220, 240, 140, 120):
            for y in range(minimum_y, min(maximum_y, top + height - size) + 1, 3):
                # A native outgoing row has a separate account avatar to the right.
                avatar = right + 19, y + 5, 22, 23
                if not sticker_region_in_frame(image, avatar) or editor_pixels_blank(image, avatar):
                    continue
                for edge in (right, right - 2, right + 2, right - 4, right + 4):
                    if edge - size < left or edge > left + width:
                        continue
                    box = edge - size, y, size
                    if fingerprints is not None:
                        candidate = sticker_image_signature(image.crop((edge - size, y, edge, y + size)))
                        matched = matches_receipt_fingerprint(candidate, fingerprints)
                    else:
                        matched = matches_sticker_image(image, box, signature)
                    if matched:
                        return box
    return None


def run_sticker(target, settings, path, image_png, *, before_send, receipt, expected_anchor=None, database_receipt=None, remember_visual=None):
    """Send one approved PNG via the official composer under the shared desktop lock."""
    if target not in {"private", "group"} or not callable(before_send) or not callable(receipt):
        raise TestError("微信图片发送需要已绑定会话和发送记录。", code="send_target_unbound")
    image_png, asset = prepare_sticker(image_png)
    signature = sticker_image_signature(asset)
    open_target(settings, path, target)
    window = active_window_id()
    if not verify_title(settings, path, target):
        raise TestError("无法确认图片发送目标。", code="title_mismatch")
    if active_window_id() != window:
        raise TestError("微信窗口已经改变。", code="send_window_changed")
    if not sticker_editor_ready(settings, path):
        raise TestError("微信编辑器不是空白。", code="send_draft_occupied")
    previous = conversation_messages(settings, path, target)
    if not previous or (expected_anchor is not None and previous[-1] != expected_anchor) or (
        expected_anchor is None and sum(item.identity == previous[-1].identity for item in previous) != 1
    ):
        raise TestError("无法确认微信图片发送前的最后一条消息。", code="send_anchor_mismatch")
    anchor = previous[-1]
    with Image.open(path) as frame:
        anchor_pixels = private_bubble_pixels(frame, anchor)
    if sticker_receipt_box(settings, path, signature, anchor):
        raise TestError("当前会话末尾已有相同的图片，请核对以免重复发送。", code="send_duplicate")

    def staged_image_matches():
        return (active_window_id() == window and verify_title(settings, path, target)
                and active_window_id() == window and sticker_draft_verified(settings, path, signature))

    confirm = database_receipt(kind="image") if database_receipt is not None else None
    if remember_visual is not None:
        proof = media_attempt_proof("image", anchor, anchor_pixels, [signature])
        if sticker_receipt_box(settings, path, None, anchor, fingerprints=proof["fingerprints"]):
            proof = {"kind": "image"}
        remember_visual(proof)
    x, y = checked_input(settings["send_click"], settings["send"])
    staged = False
    try:
        try:
            focus_wechat_editor(settings, window, image_png=image_png)
            staged = True
            time.sleep(0.45)
        finally:
            clear_clipboard()
        if not staged_image_matches():
            raise TestError("发送前无法核对微信草稿中的图片。", code="send_draft_mismatch")
        if before_send() is False:
            raise TestError("未能记录本次图片发送，未发送。", code="send_attempt_unrecorded")
    except Exception:
        try:
            if staged and staged_image_matches():
                focus_wechat_editor(settings, window, clear=True)
        except (TestError, OSError, ValueError, subprocess.TimeoutExpired):
            pass
        raise

    try:
        click_send(x, y, window, settings.get("window"))
        matched = False
        try:
            for delay in (0.8, 0.65):
                time.sleep(delay)
                if not verify_title(settings, path, target) or active_window_id() != window:
                    break
                current = conversation_messages(settings, path, target)
                if not current or current[-1].direction != anchor.direction or current[-1].sender != anchor.sender:
                    continue
                with Image.open(path) as frame:
                    same_anchor = private_bubble_pixels(frame, current[-1]) == anchor_pixels
                if same_anchor and sticker_editor_ready(settings, path) and sticker_receipt_box(settings, path, signature, current[-1]):
                    matched = True
                    break
        except (TestError, OSError, ValueError, subprocess.SubprocessError):
            pass
        if not matched and not (confirm is not None and confirm()):
            raise AttemptUncertain("发送后尚未确认一张新发出的图片，请从手机核对。")
        if receipt() is False:
            raise AttemptUncertain("无法保存图片发送回执，请从手机核对。", code="send_receipt_unstored")
        return {"ok": True, "target": target, "status": "已确认微信图片发送"}
    except (AttemptUncertain, SendWindowChanged):
        raise
    except Exception as error:
        raise AttemptUncertain("图片发送操作可能已执行，请从手机核对。") from error


def run_test(action, target, message, settings, path, quote=None, *, before_send=None, receipt=None,
             previously_confirmed_part=None, before_send_snapshot=None, native_private_receipt=False,
             resolve_group_quote=None, database_receipt=None, remember_visual=None,
             require_database_receipt=False, send_progress=None):
    """Operate under vm_operation and bracket the irreversible click with caller hooks."""
    open_target(settings, path, target)
    if action == "inspect":
        return {"ok": True, "target": target, "status": "已确认打开测试会话"}

    ocr = settings["ocr"]
    if before_send is None and matching(points(ocr, path, settings["chat"]), message):
        raise TestError("当前会话已出现同样的测试文字，请核对以免重复发送。", code="send_duplicate")
    draft = typed_lines(points(ocr, path, settings["draft"]))
    preview = points(ocr, path, settings["quote_preview"]) if "quote_preview" in settings else []
    original = None
    if resolve_group_quote is not None and (target != "group" or not quote or before_send is None):
        raise TestError("重复群消息引用需要已绑定群和发送记录。", code="send_quote_mismatch")
    if quote:
        from wechat_messages import key, select_quote

        messages = conversation_messages(settings, path, target)
        if resolve_group_quote is not None:
            original = resolve_group_quote(messages)
            if (original is not None and (original.direction != "incoming"
                    or key(original.sender) != key(quote["sender"]) or key(original.text) != key(quote["text"]))):
                original = None
        else:
            original = select_quote(messages, quote["sender"], quote["text"])
        if original is None:
            raise TestError("找不到唯一匹配的指定发言，未发送。", code="send_anchor_mismatch")
    if preview and before_send is not None and read_draft(settings) == "":
        # A quote left by an earlier attempt, with nothing typed: close it and start over.
        if not clear_quote_preview(settings, path):
            raise TestError("输入框上方有无法关闭的引用，请先在虚拟机里核对。", code="send_quote_mismatch")
        draft = typed_lines(points(ocr, path, settings["draft"]))
        preview = points(ocr, path, settings["quote_preview"])
    staged = False
    if draft or preview:
        if (resolve_group_quote is not None or before_send is None or (not original and preview)
                or (original and not verified_quote_preview(settings, path, original))
                or read_draft(settings) != message):
            raise TestError("输入框已有内容，请先在虚拟机里核对。", code="send_draft_occupied")
    window = active_window_id()
    try:
        confirm = database_receipt(message, kind="quote" if original else "text") if database_receipt is not None else None
        if require_database_receipt and confirm is None:
            raise TestError("发送自检无法取得数据库基线。", code="self_test_db_unavailable")
        if not (draft or preview):
            staged = True
            if original:
                if resolve_group_quote is None:
                    open_quote(settings, path, target, original)
                else:
                    open_quote(settings, path, target, original, resolve_group_quote=resolve_group_quote)
            click(*checked_input(settings["draft_click"], settings["draft"]))
            try:
                paste(message)
                time.sleep(0.4)
            finally:
                clear_clipboard()
        if active_window_id() != window:
            raise TestError("微信窗口已经改变。", code="send_window_changed")
        if not verify_title(settings, path, target):
            raise TestError("发送前无法确认微信会话。", code="title_mismatch")
        if read_draft(settings) != message:
            raise TestError("微信草稿与待发送内容不符。", code="send_draft_mismatch")
        if send_progress is not None:
            send_progress("paste", True)
        if not verify_title(settings, path, target):
            raise TestError("发送前无法确认微信会话。", code="title_mismatch")
        if active_window_id() != window:
            raise TestError("微信窗口已经改变。", code="send_window_changed")
        if original and not verified_quote_preview(settings, path, original):
            raise TestError("发送前无法确认引用内容，未发送。", code="send_quote_mismatch")
        previous = conversation_messages(settings, path, target)
        if resolve_group_quote is not None and resolve_group_quote(previous) != original:
            raise TestError("发送前重复群消息的位置已改变。", code="send_anchor_mismatch")
        if native_private_receipt and target == "private" and original is None and previous and previous[-1].direction == "incoming":
            with Image.open(path) as frame:
                anchor_pixels = private_bubble_pixels(frame, previous[-1])
        else:
            anchor_pixels = None
        if before_send is None and outgoing_receipt(previous, message, original):
            raise TestError("发送前发现同样的发出消息，请核对以免重复发送。", code="send_duplicate")
        x, y = checked_input(settings["send_click"], settings["send"])
        if before_send_snapshot is not None and before_send_snapshot(previous) is False:
            raise TestError("未能记录发送前的会话，未发送。", code="send_anchor_mismatch")
        if remember_visual is not None:
            remember_visual(text_attempt_proof(previous, message, original))
        if before_send is not None and before_send() is False:
            raise TestError("未能记录本次发送，未发送。", code="send_attempt_unrecorded")
    except (AttemptUncertain, SendWindowChanged):
        raise
    except TestError as error:
        # Nothing was clicked: leave no quote or text behind for the next attempt.
        if staged:
            try:
                error.send_frame = redacted_send_frame(settings, path)
            except (OSError, ValueError, TypeError):
                pass
            try:
                if active_window_id() == window and verify_title(settings, path, target) and active_window_id() == window:
                    discard_staged_draft(settings, path)
            except (TestError, OSError, ValueError, subprocess.SubprocessError):
                pass
        raise
    try:
        if send_progress is not None:
            # Once this boundary is entered a failure must never cause a repeat click.
            send_progress("click", True)
        click_send(x, y, window, settings.get("window"))
        confirmed = False
        window_changed = False
        try:
            if anchor_pixels is not None:
                left, top, _, _ = settings["window"]
                guest(f"xdotool mousemove {left + 305} {top + 45}")
            for delay in (1, 0.65):
                time.sleep(delay)
                if not verify_title(settings, path, target) or active_window_id() != window:
                    window_changed = True
                    break
                current = conversation_messages(settings, path, target)
                confirmed = fresh_outgoing_receipt(previous, current, message, original, target=target,
                                                   previously_confirmed_part=previously_confirmed_part)
                if not confirmed and delay == 0.65 and anchor_pixels is not None:
                    confirmed = copied_private_receipt(settings, path, previous, current, message, anchor_pixels)
                if confirmed:
                    break
        except (TestError, OSError, ValueError, subprocess.SubprocessError):
            pass
        if send_progress is not None:
            send_progress("ocrReceipt", confirmed)
        db_confirmed = bool(confirm is not None and (require_database_receipt or not confirmed) and confirm())
        if send_progress is not None:
            send_progress("dbReceipt", db_confirmed)
        if require_database_receipt and not db_confirmed:
            raise AttemptUncertain("发送自检尚未取得数据库回执。", code="self_test_db_unconfirmed")
        if not confirmed and not db_confirmed:
            if window_changed:
                raise AttemptUncertain("发送期间微信窗口或会话已改变，请在手机核对。", code="send_window_changed")
            raise AttemptUncertain("发送后尚未确认一条新发出的消息，请从手机核对。")
        if receipt is not None and receipt() is False:
            raise AttemptUncertain("已看到发出的消息，但无法保存回执，请从手机核对。", code="send_receipt_unstored")
    except (AttemptUncertain, SendWindowChanged):
        raise
    except Exception as error:
        raise AttemptUncertain("发送操作可能已执行，请从手机核对。") from error
    return {"ok": True, "target": target, "quoted": original is not None,
            "status": "微信客户端已显示发出的测试消息"}


def private_bubble_pixels(image, message):
    x, y, width, height = message.box
    return image.crop((x, y, x + width, y + height)).convert("RGB").tobytes()


def copied_private_receipt(settings, path, previous, current, message, anchor_pixels):
    from wechat_messages import bubble_boxes

    if len(current) < 2 or outgoing_receipt(previous, message, None):
        return False
    before = previous[-1]
    anchor, reply = current[-2:]
    gap = reply.box[1] - anchor.box[1] - anchor.box[3]
    if (anchor.direction != "incoming" or anchor.sender != before.sender or anchor.quoted_sender or anchor.quoted_text
            or (anchor.box[0], *anchor.box[2:]) != (before.box[0], *before.box[2:])
            or reply.direction != "outgoing" or not 0 <= gap <= 100):
        return False
    with Image.open(path) as frame:
        if (private_bubble_pixels(frame, anchor) != anchor_pixels
                or bubble_boxes(frame, settings["chat"])[-2:] != [(row.direction, tuple(row.box)) for row in (anchor, reply)]):
            return False
    try:
        return copy_private_message(settings, path, reply, outgoing=True) == message
    except (TestError, OSError, ValueError, subprocess.SubprocessError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("snapshot", "window", "inspect", "send", "reply", "recover-window"))
    parser.add_argument("target", nargs="?")
    args = parser.parse_args()
    if args.action == "snapshot":
        if not args.target:
            parser.error("snapshot needs an output path")
        return {"ok": True, "size": snapshot(Path(args.target))}
    if args.action == "window":
        return {"ok": True, "classes": active_window_classes(), "window": window_geometry()}
    if args.action == "recover-window":
        if args.target is not None:
            parser.error("recover-window does not take a target")
        with vm_operation(wait=20), tempfile.TemporaryDirectory(prefix="deskpet-wechat-guest-") as temp:
            outcome = recover_window(config(), Path(temp) / "guest.png")
            return {"ok": outcome in {"already_open", "restored"}, "outcome": outcome}
    if args.target not in ("private", "group"):
        parser.error("choose private or group")
    quote = None
    message = sys.stdin.read(1601) if args.action == "send" else ""
    if args.action == "reply":
        request = json.loads(sys.stdin.read(4001))
        if not isinstance(request, dict) or set(request) != {"sender", "text", "reply"}:
            raise TestError("请指定发送人、原消息和回复内容。")
        if any(not isinstance(request[field], str) or not request[field].strip()
               for field in ("sender", "text", "reply")):
            raise TestError("请指定发送人、原消息和回复内容。")
        quote = {"sender": request["sender"], "text": request["text"]}
        message = request["reply"]
    if args.action in ("send", "reply") and (
        not message.strip() or len(message) > 80 or re.search(r"[\x00-\x1f\x7f]", message)
    ):
        raise TestError("首轮验证请用一行、80 个字符以内的测试文字。")
    with vm_operation(wait=20), tempfile.TemporaryDirectory(prefix="deskpet-wechat-guest-") as temp:
        return run_test(args.action, args.target, message, config(), Path(temp) / "guest.png", quote=quote)


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except (TestError, OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, TestError) else "测试配置或虚拟桌面不可用。"
        result = {"ok": False, "error": message}
        if isinstance(error, AttemptUncertain):
            result["outcome"] = "uncertain"
        elif isinstance(error, OperationBusy):
            result["outcome"] = "busy"
        elif isinstance(error, SendWindowChanged):
            result["outcome"] = "not_sent"
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(1)
