"""Send a saved WeChat sticker through the official Linux client's Favorites tab."""

from dataclasses import dataclass
import hashlib
import subprocess
from io import BytesIO
import time

from PIL import Image, ImageChops, ImageOps, ImageStat

import vm_console as ui
from wechat_messages import continuous_ranges


PANEL_SIZE = 466
FAVORITES_TAB = (134, 442)
FIRST_TILE = (20, 20, 72, 72)
EMPTY_LABELS = {"nostickersadded", "暂无表情", "暂无收藏表情", "还没有添加表情"}
STICKER_LABELS = {"allstickers", "全部表情"}


@dataclass(frozen=True)
class Panel:
    window: int
    chat_window: int
    box: tuple[int, int, int, int]

    def point(self, x, y):
        return self.box[0] + x, self.box[1] + y


def panel_command(panel, settings):
    left, top, width, height = panel.box
    x, y, w, h = settings['window']
    return ui.WECHAT_X11_IDENTITY + f'''
        export LC_ALL=C
        active={panel.window}
        main={panel.chat_window}
        [ "$(xdotool getactivewindow)" = "$active" ] || exit 1
        main_props=$(wechat_window_props "$main") && wechat_normal_window "$main_props" || exit 1
        [ "$(wechat_window_geometry "$main")" = '{x} {y} {w} {h} IsViewable' ] || exit 1
        panel_props=$(wechat_window_props "$active") || exit 1
        printf '%s\\n' "$panel_props" | grep -q '^_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_UTILITY' || exit 1
        main_pid=$(printf '%s\\n' "$main_props" | sed -n 's/^_NET_WM_PID(CARDINAL) = //p')
        panel_pid=$(printf '%s\\n' "$panel_props" | sed -n 's/^_NET_WM_PID(CARDINAL) = //p')
        [ -n "$main_pid" ] && [ "$main_pid" = "$panel_pid" ] || exit 1
        [ "$(wechat_window_geometry "$active")" = '{left} {top} {width} {height} IsViewable' ] || exit 1
    '''


def capture_panel(panel, settings, path):
    frame = ui.guest(panel_command(panel, settings) + '''
        import -window root png:- && [ "$(xdotool getactivewindow)" = "$active" ]
    ''')
    if ui.write_snapshot(path, frame) != settings['size']:
        raise ui.TestError('微信表情面板布局已变化。')


def panel_click(panel, settings, x, y):
    ui.guest(panel_command(panel, settings) + f'xdotool mousemove {int(x)} {int(y)} click 1')


def labels(settings, path, panel):
    return {ui.normalize(row['text']) for row in ui.recognize(settings['ocr'], path, panel.box)}


def open_panel(settings, path, chat_window):
    x, y, width, height = settings['window']
    # Emoji toolbar button in the dedicated, calibrated Linux desktop.
    ui.click(x + 331, y + height - 31)
    time.sleep(.30)
    desktop = ui.wechat_desktop(settings['window'])
    box = (x + 98, y + height - 515, PANEL_SIZE, PANEL_SIZE)
    panels = [item for item in desktop.windows if item.xid == desktop.active and item.mapped
              and not item.normal and item.geometry == box]
    if len(panels) != 1:
        raise ui.TestError('无法确认微信原生表情面板。')
    panel = Panel(panels[0].xid, chat_window, box)
    capture_panel(panel, settings, path)
    return panel


def close_panel(panel, settings):
    if panel is not None and ui.active_window_id() == panel.window:
        x, y, _, _ = settings['window']
        # The empty chat header sits outside the popup and doesn't navigate.
        panel_click(panel, settings, x + 602, y + 59)
        time.sleep(.15)


def tight_art(image):
    """Find content apart from the white/near-white native panel background."""
    rgb = image.convert('RGB')
    mask = ImageChops.difference(rgb, Image.new('RGB', rgb.size, (248, 248, 248)))
    channels = mask.split()
    mask = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    bounds = mask.point(lambda value: 255 if value > 27 else 0).getbbox()
    if bounds is None or min(bounds[2] - bounds[0], bounds[3] - bounds[1]) < 15:
        return None
    return rgb.crop(bounds)


def art_signature(image):
    thumbnail = ImageOps.contain(image, (28, 28), Image.Resampling.BILINEAR)
    result = Image.new('RGB', (28, 28), (248, 248, 248))
    result.paste(thumbnail, ((28 - thumbnail.width) // 2, (28 - thumbnail.height) // 2))
    return result


def favorite_art(path, panel):
    left, top, width, height = FIRST_TILE
    x, y = panel.point(left, top)
    with Image.open(path) as frame:
        cell = frame.crop((x, y, x + width, y + height))
        art = tight_art(cell)
        return art_signature(art) if art is not None else None


def favorites_selected(path, panel):
    with Image.open(path) as frame:
        return all(frame.getpixel(panel.point(x, y))[:3] == (237, 237, 237)
                   for x, y in ((122, 434), (145, 445), (123, 453), (147, 433)))


def sticker_visual_anchors(settings, path, messages):
    """Find fully visible square sticker rows beside native chat avatars."""
    left, top, width, height = settings['chat']
    right = left + width
    box_size = 132
    known = [message.box for message in messages]
    anchors = []
    with Image.open(path) as source:
        frame = source.convert('RGB')
    pixels = frame.load()
    for avatar_left, art_left in ((left + 13, left + 63), (right - 47, right - 61 - box_size)):
        def avatar_pixel(x, y):
            return max(abs(color - 247) for color in pixels[x, y]) > 24
        rows = [y for y in range(top, top + height)
                if sum(avatar_pixel(x, y) for x in range(avatar_left + 4, avatar_left + 32)) >= 11]
        for start, end in continuous_ranges(rows):
            if not 26 <= end - start <= 38 or start <= top + 2 or start + box_size > top + height:
                continue
            if any(y < start + box_size and start < y + h for _, y, _, h in known):
                continue
            art = frame.crop((art_left, start, art_left + box_size, start + box_size))
            if any(ui.editor_pixels_blank(art, quadrant) for quadrant in (
                (3, 3, 40, 40), (3, 85, 40, 40), (85, 3, 40, 40), (85, 85, 40, 40)
            )):
                continue
            digest = hashlib.sha256(art.tobytes()).hexdigest()
            anchors.append([digest, art_left, start, box_size])
    return sorted(anchors, key=lambda value: value[2])


def sticker_receipt_art(settings, path, signatures, anchor, *, fingerprints=None):
    left, top, width, height = settings['chat']
    right = left + width - 61
    start = max(top, anchor.box[1] + anchor.box[3] + 3)
    with Image.open(path) as source:
        frame = source.convert('RGB')
    for y in range(start, min(start + 82, top + height - 42), 2):
        if ui.editor_pixels_blank(frame, (right + 19, y + 4, 22, 23)):
            continue
        for extent in (132, 120, 144, 108, 160, 180, 200, 96, 84, 72, 60, 48):
            if y + extent > top + height:
                continue
            art = tight_art(frame.crop((right - extent - 5, y, right + 3, y + extent)))
            if art is None:
                continue
            observed = art_signature(art)
            if fingerprints is not None:
                matched = ui.matches_receipt_fingerprint(observed, fingerprints)
            else:
                matched = any(max(ImageStat.Stat(ImageChops.difference(observed, expected)).mean) <= 19
                              for expected in signatures)
            if matched:
                return True
    return False


def native_receipt_anchor(frame, expected_pixels, row, anchor):
    if row.direction != anchor.direction or (row.box[0], *row.box[2:]) != (anchor.box[0], *anchor.box[2:]):
        return False
    return ui.private_bubble_pixels(frame, row) == expected_pixels


def run_native_sticker(target, settings, path, anchor, *, before_send, receipt, database_receipt=None,
                       remember_visual=None):
    """Return False for an empty Favorites tab. Click-send only the first saved tile."""
    if (not ui.verify_title(settings, path, target) or not ui.sticker_editor_ready(settings, path)
            or not callable(before_send) or not callable(receipt)):
        raise ui.TestError('发送收藏表情前，无法核对会话或空白输入框。')
    chat_window = ui.active_window_id()
    previous = ui.conversation_messages(settings, path, target)
    if not previous or previous[-1] != anchor:
        raise ui.TestError('收藏表情对应的消息已不在会话末尾。', code="send_anchor_mismatch")
    with Image.open(path) as frame:
        anchor_pixels = ui.private_bubble_pixels(frame, anchor)
    pre_send_frame = path.read_bytes()
    confirm = database_receipt(kind="sticker") if database_receipt is not None else None
    panel = open_panel(settings, path, chat_window)
    try:
        panel_click(panel, settings, *panel.point(*FAVORITES_TAB))
        time.sleep(.24)
        capture_panel(panel, settings, path)
        available_labels = labels(settings, path, panel)
        if not favorites_selected(path, panel) or available_labels & STICKER_LABELS:
            raise ui.TestError('微信未进入收藏表情页。')
        if available_labels & EMPTY_LABELS:
            return False
        signatures = []
        for index in range(3):
            if index:
                time.sleep(.12)
                capture_panel(panel, settings, path)
            art = favorite_art(path, panel)
            if art is not None:
                signatures.append(art)
        if not signatures:
            raise ui.TestError('无法核对第一张微信收藏表情的图案。')
        with BytesIO(pre_send_frame) as frame:
            if sticker_receipt_art(settings, frame, signatures, anchor):
                raise ui.TestError('当前消息后面已有相同的收藏表情。')
            if remember_visual is not None:
                proof = ui.media_attempt_proof("sticker", anchor, anchor_pixels, signatures)
                frame.seek(0)
                if sticker_receipt_art(settings, frame, (), anchor, fingerprints=proof["fingerprints"]):
                    proof = {"kind": "sticker"}
                remember_visual(proof)
        if not favorites_selected(path, panel) or before_send() is False:
            raise ui.TestError('未能记录这次微信表情发送。')
        try:
            left, top, width, height = FIRST_TILE
            panel_click(panel, settings, *panel.point(left + width // 2, top + height // 2))
            time.sleep(.45)
        except Exception as error:
            raise ui.AttemptUncertain('微信收藏表情可能已经发出。') from error
    finally:
        close_panel(panel, settings)

    matched = False
    try:
        for delay in (.40, .75, 1.20, 1.80):
            time.sleep(delay)
            if ui.active_window_id() != chat_window or not ui.verify_title(settings, path, target):
                break
            rows = ui.conversation_messages(settings, path, target)
            if not rows:
                continue
            tail = rows[-1]
            with Image.open(path) as frame:
                if not native_receipt_anchor(frame, anchor_pixels, tail, anchor):
                    continue
            if sticker_receipt_art(settings, path, signatures, tail):
                matched = True
                break
    except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
        pass
    if not matched and not (confirm is not None and confirm()):
        raise ui.AttemptUncertain('未能核对微信收藏表情的发送回执。')
    if receipt() is False:
        raise ui.AttemptUncertain('无法保存微信表情的发送回执。', code="send_receipt_unstored")
    return True
