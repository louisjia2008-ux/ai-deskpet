"""Record a local WAV in the official guest WeChat and verify its private receipt."""

import base64
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time
import uuid
from io import BytesIO

from PIL import Image, ImageChops, ImageStat

import vm_console as ui
from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_intake import DbIntake
from wechat_service import is_paused
from wechat_voice_controls import ICONS, POSITIONS
from wechat_voice_guest import MAX_SECONDS, VoiceInputError, read_wav
from wechat_voice_synthesis import VoiceSynthesisError, synthesize_wav


SAFE_ERROR = re.compile(r"[a-z_]{1,60}\Z")
RECORD_LIMIT = 42
RECEIPT_WAIT = 45


def controls(settings, path, *names):
    """Match the calibrated 4.1.13 toolbar, at its verified X11 geometry."""
    left, top, width, height = settings["window"]
    with Image.open(path) as shot:
        result = []
        for name in names:
            offset_x, offset_y = POSITIONS[name]
            x, y = left + width + offset_x, top + height + offset_y
            with Image.open(BytesIO(base64.b64decode(ICONS[name]))) as icon:
                w, h = icon.size
                box = x - w // 2, y - h // 2, w, h
                if not ui.sticker_region_in_frame(shot, box):
                    raise ui.DiagnosticTestError("微信录音控件超出窗口。")
                bx, by, _, _ = box
                observed = shot.crop((bx, by, bx + w, by + h)).convert("RGB")
                error = ImageStat.Stat(ImageChops.difference(icon.convert("RGB"), observed)).mean
                if max(error) > 4:
                    raise ui.DiagnosticTestError(f"无法确认微信录音控件（{name}）。")
            result.append((x, y))
    return tuple(result)


def window_command(settings, window, command):
    x, y, w, h = map(int, settings["window"])
    return ui.WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        window={int(window)}
        [ "$(xdotool getactivewindow)" = "$window" ] || exit 61
        props=$(wechat_window_props "$window") && wechat_normal_window "$props" || exit 62
        [ "$(wechat_window_geometry "$window")" = '{x} {y} {w} {h} IsViewable' ] || exit 63
        pid=$(printf '%s\\n' "$props" | sed -n 's/^_NET_WM_PID(CARDINAL) = //p')
        {command}
    '''


def audio(settings, window, action, wav=None):
    source = Path(__file__).with_name("wechat_voice_guest.py").read_bytes()
    encoded = base64.b64encode(source).decode("ascii")
    program = f'import base64;exec(compile(base64.b64decode("{encoded}"),"wechat_voice_guest.py","exec"))'
    raw = ui.guest(window_command(settings, window,
        f'/usr/bin/python3 -I -B -c {shlex.quote(program)} {action} --wechat-pid "$pid" || [ "$?" = 1 ]'),
        wav, timeout=MAX_SECONDS + 11 if action == "play" else 6)
    try:
        result = json.loads(raw)
    except ValueError:
        raise ui.DiagnosticTestError("无法核对虚拟麦克风返回值。") from None
    if not isinstance(result, dict) or result.get("ok") is not True:
        code = result.get("error", "") if isinstance(result, dict) else ""
        raise ui.DiagnosticTestError(f"虚拟麦克风未通过核对（{code if SAFE_ERROR.fullmatch(str(code)) else 'invalid'}）。")


def start_recording(settings, window, point, guard):
    x, y = point
    left, top, _, _ = settings["window"]
    # If the host exits unexpectedly, cancel before WeChat's 60-second limit.
    cancel = window_command(settings, window, 'xdotool key --clearmodifiers Escape')
    watchdog = f'sleep {RECORD_LIMIT + 5}; if [ -f {guard} ]; then ({cancel}); rm -f -- {guard}; fi'
    ui.guest(window_command(settings, window, f'''
        (umask 077; set -C; : > {guard}) || exit 64
        nohup /bin/bash -c {shlex.quote(watchdog)} </dev/null >/dev/null 2>&1 &
        xdotool mousemove {x} {y} click 1 mousemove {left + 305} {top + 45}
    '''))


def stop_recording(settings, window, path, guard):
    try:
        ui.capture_wechat(settings, path)
        (cancel,) = controls(settings, path, "cancel")
        ui.guest(window_command(settings, window,
                                f'xdotool mousemove {cancel[0]} {cancel[1]} click 1'))
    except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
        ui.guest(window_command(settings, window, 'xdotool key --clearmodifiers Escape'))
    time.sleep(0.2)
    audio(settings, window, "check")
    ui.guest(f'rm -f -- {guard}')


def record_voice(settings, path, runtime, pin, wav, *, before_send=None):
    """The caller owns the desktop lock. Omit before_send for a cancel-only probe."""
    try:
        read_wav(BytesIO(wav))
    except VoiceInputError as error:
        raise ui.DiagnosticTestError("微信语音需为 1 至 30 秒的有效音频。") from error
    from wechat_listener import verify_owner_window

    verify_owner_window(settings, path, runtime)
    if not ui.verify_title(settings, path, "private"):
        raise ui.DiagnosticTestError("微信私聊布局已变化。")
    start, _ = controls(settings, path, "start", "text_disabled")
    if not ui.sticker_editor_ready(settings, path) and ui.read_draft(settings):
        raise ui.DiagnosticTestError("微信私聊输入框已有内容。")
    window = ui.active_window_id()
    reader = DatabaseReader()
    baseline = reader.voice_baseline(pin.account_id, pin.conversation_id) if before_send else None
    audio(settings, window, "check")
    guard = f'/run/deskpet-wechat/voice-{uuid.uuid4().hex}'
    committed = False
    started = time.monotonic()
    try:
        start_recording(settings, window, start, guard)
        audio(settings, window, "play", wav)
        if not ui.verify_title(settings, path, "private") or ui.active_window_id() != window:
            raise ui.DiagnosticTestError("录音期间已绑定私聊发生变化。")
        _, send = controls(settings, path, "cancel", "send")
        if before_send is None:
            return {"status": "recorded_cancelled"}
        if time.monotonic() - started >= RECORD_LIMIT or not before_send():
            raise ui.DiagnosticTestError("微信语音发送前检查已过期或绑定已变化。")
        duration_ms = round((time.monotonic() - started) * 1000)
        # Keep the watchdog armed if the click's outcome is unknown.
        committed = True
        ui.guest(window_command(settings, window, f'xdotool mousemove {send[0]} {send[1]} click 1'))
        time.sleep(0.2)
        try:
            audio(settings, window, "check")
            ui.guest(f'rm -f -- {guard}')
        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
            # The send crossed its one-click boundary. Look for a receipt even if cleanup failed.
            pass
    finally:
        if not committed:
            stop_recording(settings, window, path, guard)

    deadline = time.monotonic() + RECEIPT_WAIT
    while time.monotonic() < deadline:
        try:
            receipt = reader.voice_receipt(pin.account_id, pin.conversation_id, baseline, duration_ms)
        except DatabaseUnavailable:
            receipt = {"status": "pending"}
        if receipt["status"] != "pending":
            return receipt
        time.sleep(1)
    return {"status": "pending"}


def deliver_private_voice(state, binding, event, settings, path, runtime):
    from wechat_listener import database_event_allowed, log_failure, reply_route_matches, reset_reply_route

    if is_paused(runtime):
        return "paused"
    presentation = event.observation["presentation"]
    try:
        if not reply_route_matches(runtime, "private", settings, presentation, binding=binding):
            return reset_reply_route(state, event)
        wav = synthesize_wav(event.reply)
    except VoiceSynthesisError as error:
        log_failure("send_check_waiting", error, "private_voice_synthesis")
        return "voice_unavailable"
    except (OSError, ValueError):
        return "cloud_settings_invalid"

    attempted = False
    try:
        # A voice reply is explicitly requested by the owner. Keep the wait
        # short because this runs on the listener's delivery loop.
        with ui.vm_operation(wait=5):
            pin = DbIntake.pins(state).get(binding)
            if pin is None or pin.target != "private" or not database_event_allowed(state, settings, runtime, event):
                return "database_unbound"
            if not reply_route_matches(runtime, "private", settings, presentation, binding=binding):
                return reset_reply_route(state, event)

            def before_send():
                nonlocal attempted
                if is_paused(runtime) or not reply_route_matches(runtime, "private", settings, presentation, binding=binding):
                    return False
                if not database_event_allowed(state, settings, runtime, event):
                    return False
                attempted = state.mark_attempted(event.id)
                return attempted

            result = record_voice(settings, path, runtime, pin, wav, before_send=before_send)
            if result["status"] == "confirmed" and state.mark_sent(event.id):
                return "ready"
    except ui.OperationBusy as error:
        # Nothing was clicked. Preserve the prepared voice for the next poll.
        raise ui.OwnerOperationPending("等待微信窗口发送语音。") from error
    except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        log_failure("send_check_waiting", error, "private_voice_send")
    if attempted:
        state.mark_uncertain(event.id)
        return "send_uncertain"
    # Nothing was clicked, so the caller can still send the reply as text.
    return "voice_unavailable"
