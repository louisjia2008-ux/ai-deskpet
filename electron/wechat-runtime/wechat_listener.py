"""Continuously reply in the enrolled Linux WeChat conversations."""

import argparse
from contextlib import contextmanager, nullcontext
from dataclasses import asdict
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid

from PIL import Image

import vm_console as ui
from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_guest import digest_group_id
from wechat_db_intake import DbIntake, DbScope
from wechat_friend_replies import FriendReplyLane, authorize_friend
from wechat_digest_groups import current_pins as digest_group_pins, digest_group_control
from wechat_official_digest import official_source_control
from wechat_friends import (
    FRIEND_ID, FRIEND_ROSTER_ID, bind_reply_friend, enrolled_friends, friend_binding_key, remove_reply_friend,
    reply_friend_roster, settings_for_friend, verify_friend,
)
from wechat_friends_moments import friends_moments_control
from wechat_group_policy import (
    DEFAULT_GROUP_POLICY, GROUP_ID, LEGACY_GROUP, MAX_POLICY_BYTES, BoundGroup, group_policy_lock,
    parse_fingerprints, parse_group_title, parse_policy, read_group_policy, read_group_registry,
    write_group_policy, write_group_registry,
)
from wechat_messages import MessageSnapshot, VisibleMessage, bubble_boxes, key, native_group_mention, new_messages, select_quote, share_vertical_shift
from wechat_replies import (
    CLOUD_REQUEST_LIMIT, DeskPet, ReplyRejected, ReplyYielded, article_reply_plan, cloud_reply_plan, cloud_request_from_bytes, local_reply_context, log,
    ephemeral_owner_reply, knowledge_reply_current, owner_command_candidate, owner_command_plan, read_tool_candidate, read_tool_plan, reply_bubbles, report_local_reply, rich_reply_plan, select_reply_sticker, sticker_mode,
    sticker_command, thread_snapshot,
)
from wechat_reply_settings import DEFAULT_REPLY, list_models, read_cloud_route, read_reply_settings, write_reply_settings
from wechat_rich_message import chat_quote_excerpt, valid_rich
from wechat_service import (
    GROUP_POLICY_VERSION, is_paused, launchd_plist, pause_for_target_binding, prepare_runtime, read_status,
    reply_target_binding_supported, restart_listener, service_lock, set_paused, write_status,
)
from wechat_state import QUEUE_COMMANDS, StateConflict, WeChatState, binding_key, database_queue_command
from wechat_sticker_spool import read_staged_sticker
from wechat_native_sticker import run_native_sticker, sticker_receipt_art, sticker_visual_anchors
from wechat_viewer import start_viewer


TARGETS = ("private", "group")
MAX_QUEUE = 6
MENTION_TTL = 90
ACTIVE_POLL = 3
# The listener holds the binding lock for each poll and group send, so an owner's settings action waits its turn.
CONTROL_LOCK_WAIT = 20
CONTROL_VM_WAIT = 60
# A digest or follow-up read holds the binding lock for about a second; the listener waits that out instead of reporting busy.
LISTENER_LOCK_WAIT = 5
ENROLLMENT_TTL = 45 * 60
MAX_GROUPS = 12
PRIVATE_SCHEDULED_COMMAND = re.compile(r"^\s*[/／](?:cron|task|confirm)(?:\s|$)", re.IGNORECASE)
# "/voice 晚安" or "/voice晚安".
PRIVATE_VOICE_COMMAND = re.compile(r"^\s*[/／]voice\s*(?=\S)", re.IGNORECASE)
# A reply that will be heard, not read: the model writes it to be spoken.
VOICE_REPLY_NOTE = "\n\n（这条会用微信语音条回复：请用口语短句，60 字以内，不要表情、符号、链接和格式。）"
VOICE_UNHEARD_REPLY = "刚才的语音我没听清，可以再说一遍，或者打字给我吗？"
OWNER_VOICE_TYPE = 34
MAX_HEARD_PER_POLL = 3
PRIVATE_REPLY_REJECTED = "看到你的消息了，这次没生成可发送的回复。"
# A group request the assistant would not answer gets a short decline instead of silence.
GROUP_REPLY_DECLINED = "这个我就先不接啦～"
# One member may address the assistant this often per minute; more is treated as flooding.
GROUP_SENDER_LIMIT = 3
DATABASE_RECEIPT_WAIT = 40
STICKER_NOT_AVAILABLE = "这次没有可发送的表情。请在小号微信里收藏表情，或在 DeskPet 图库授权一张图片给此会话。"
STICKER_LIBRARY_NOT_AVAILABLE = "这个会话没有可用的图库图片。请在 DeskPet 图库为此会话授权一张静态图片。"
STICKER_SELECTION_FAILED = "暂时无法选取这张表情，请稍后再试。"
STICKER_DISABLED = "微信表情回复现在是关闭的。"


def log_failure(event, error, stage):
    details = {"at": time.time(), "stage": stage, "reason": type(error).__name__}
    if getattr(error, "code", None) in ui.SEND_REASONS:
        details["reason"] = ui.send_reason(error)
    log(event, **details)


SEND_FAILURE_STATES = frozenset({"send_preflight_blocked", "send_uncertain", "delivery_failed"})
SEND_SAMPLE_FILE = re.compile(r"[0-9]{1,21}_[a-z_]+\.png\Z")
SEND_SAMPLE_LIMIT = 20
SEND_SAMPLE_AGE = 7 * 24 * 60 * 60


def prune_send_samples(folder, *, now=None, limit=SEND_SAMPLE_LIMIT):
    now = time.time() if now is None else now
    samples = []
    for path in folder.iterdir():
        if SEND_SAMPLE_FILE.fullmatch(path.name):
            stat = path.lstat()
            if stat.st_mtime <= now - SEND_SAMPLE_AGE:
                path.unlink()
            else:
                samples.append((stat.st_mtime_ns, path))
    for _, path in sorted(samples, reverse=True)[limit:]:
        path.unlink()


def save_send_sample(runtime, settings, path, error):
    """Keep only the drawer divider and the send-state pixel in a redacted frame."""
    try:
        folder = prepare_runtime(prepare_runtime(runtime) / "send-checks")
        prune_send_samples(folder, limit=SEND_SAMPLE_LIMIT - 1)
        frame = getattr(error, "send_frame", None) or ui.redacted_send_frame(settings, path)
        if frame is None:
            return
        sample = folder / f"{time.time_ns()}_{ui.send_reason(error)}.png"
        with tempfile.NamedTemporaryFile(prefix=".frame-", dir=folder, delete=False) as stream:
            try:
                frame.save(stream, format="PNG")
                stream.flush()
                os.replace(stream.name, sample)
            finally:
                Path(stream.name).unlink(missing_ok=True)
    except (OSError, ValueError, TypeError):
        # Capturing a diagnostic must never affect delivery or queue transitions.
        pass


def group_revision(observation):
    return observation.get("group_policy_revision", DEFAULT_GROUP_POLICY.revision)


def group_sender_matches(policy, sender):
    return bool(sender) and (policy.mode != "sender" or unicodedata.normalize("NFC", sender) == policy.sender)


def repeated_group_sticker(previous, current, arrivals, account, *, pixel_overlap=None):
    """Require one proven new sticker tail and an exact, independently anchored history."""
    if not account or len(arrivals) != 1 or len(current.messages) < 3:
        return None
    tail = current.messages[-1]
    if (tail is not arrivals[0] or tail.direction != "incoming" or not tail.sender or not tail.mentions_account
            or tail.quoted_sender or tail.quoted_text or not sticker_command(tail.text, account, "group")):
        return None
    old, rows = previous.messages, current.messages
    prefix = rows[:-1]
    if pixel_overlap is not None:
        start, count = pixel_overlap
        matching_positions = [index for index, row in enumerate(rows) if row.identity == tail.identity]
        if (len(matching_positions) >= 2 and matching_positions[-1] == len(rows) - 1
                and all(start <= index < start + count for index in matching_positions[:-1])
                and len({tuple(rows[index].box) for index in matching_positions}) == len(matching_positions)):
            return tail
        return None
    for count in range(2, min(len(old), len(prefix)) + 1):
        matched = tuple(zip(old[-count:], prefix[-count:]))
        if (not all(left.identity == right.identity for left, right in matched)
                or not share_vertical_shift(matched)):
            continue
        if (sum(row.identity == tail.identity for row in old) == sum(row.identity == tail.identity for row in rows) - 1
                and any(left.identity == tail.identity for left, _ in matched)
                and any(left.identity != tail.identity
                        and sum(record.identity == left.identity for record in old) == 1
                        and sum(record.identity == left.identity for record in rows) == 1 for left, _ in matched)
                and len({tuple(row.box) for row in rows if row.identity == tail.identity})
                == sum(row.identity == tail.identity for row in rows)):
            return tail
    return None


def save_observation(state, binding, snapshot, *, authorize=False, policy=DEFAULT_GROUP_POLICY, private_copy=None,
                     private_pixels=None, group_account=None, private_art=None, group_pixels=None, group_copy=None):
    checkpoint = state.checkpoint(binding)
    observation = {"messages": [asdict(message) for message in snapshot.messages]}
    if snapshot.context == "private" and private_pixels is not None:
        observation["private_pixels"] = private_pixels
    if snapshot.context == "private" and private_art is not None:
        observation["private_art"] = private_art
    if snapshot.context == "group":
        observation["group_policy_revision"] = policy.revision
        if group_pixels is not None:
            observation["group_pixels"] = group_pixels
        if policy.mode == "off":
            return "off"
        if checkpoint is not None and group_revision(checkpoint.observation) != policy.revision:
            # A policy switch cannot reinterpret earlier traffic or reuse a queued reply.
            state.rebaseline(binding, observation)
            return "ready"
    if checkpoint is None:
        state.intake(binding, None, observation)
        return "ready"

    previous = snapshot_from_checkpoint(snapshot.context, checkpoint)
    messages = observed_arrivals(checkpoint, previous, snapshot, private_pixels)
    mention = state.pending_mention(binding) if snapshot.context == "group" and policy.mode == "mentions" else None
    fresh_mention = bool(mention and mention["sequence"] == checkpoint.sequence
                         and 0 <= time.time() - mention["seen_at"] <= MENTION_TTL)
    group_overlap = (group_pixel_overlap(checkpoint, previous, snapshot, group_pixels)
                     if fresh_mention and (messages is None or messages) else None)
    if group_overlap is not None:
        start, count = group_overlap
        pixel_arrivals = tuple(row for row in snapshot.messages[start + count:] if row.direction == "incoming")
        if messages is not None and messages != pixel_arrivals:
            return "continuity_lost"
        messages = pixel_arrivals
    if messages is None and snapshot.context == "private" and not previous.messages:
        messages = arrivals_after_stickers(checkpoint.observation.get("private_art"), private_art, snapshot.messages)
    if messages is None and snapshot.context == "private" and private_pixels:
        messages = observed_private_sticker_tail(state, binding, checkpoint, snapshot, private_pixels)
    if messages is None:
        return "continuity_lost"

    group_duplicate = None
    if mention:
        candidates = [message for message in messages if message.mentions_account]
        if not fresh_mention or len(candidates) != 1 or messages[-1] is not candidates[0]:
            return "mention_ambiguous"
        if select_quote(snapshot.messages, candidates[0].sender, candidates[0].text) is None:
            overlap = group_overlap if group_overlap is not None and sum(group_overlap) == len(snapshot.messages) - 1 else None
            group_duplicate = repeated_group_sticker(previous, snapshot, messages, group_account, pixel_overlap=overlap)
            if group_duplicate is None:
                return "mention_ambiguous"
        pending = candidates
    elif snapshot.context == "private":
        if not authorize:
            return "needs_owner"
        pending = messages
    elif policy.mode in ("sender", "all"):
        pending = [message for message in messages if group_sender_matches(policy, message.sender)
                   and select_quote(snapshot.messages, message.sender, message.text) is not None]
    else:
        pending = ()

    private_tail = snapshot.messages[-1] if snapshot.context == "private" and snapshot.messages else None
    accepted_messages = []
    for message in pending:
        if not message.sender or not 0 < len(message.text) <= 500:
            continue
        item = asdict(message)
        if message is private_tail:
            item.update(private_tail_checkpoint=checkpoint.sequence + 1, private_tail_slot=len(snapshot.messages) - 1)
        if message is group_duplicate:
            item.update(group_tail_checkpoint=checkpoint.sequence + 1, group_tail_slot=len(snapshot.messages) - 1)
        if (snapshot.context == "group" and group_copy is not None and message.mentions_account
                and not (message.quoted_sender or message.quoted_text)
                and re.search(r"(?:^|\s)[/／IlJ|]?sticker(?:\s|$)", message.text, re.IGNORECASE)):
            try:
                original = group_copy(message)
            except (ui.TestError, ValueError, OSError, subprocess.SubprocessError):
                return "group_copy_unavailable"
            if not sticker_command(original, group_account, "group"):
                return "mention_ambiguous"
            item.update(text=original, visual_text=message.text)
        elif snapshot.context == "private" and private_copy is not None and not (message.quoted_sender or message.quoted_text):
            try:
                original = private_copy(message)
                if not isinstance(original, str) or not original.strip() or "\x00" in original:
                    raise ui.TestError("微信未返回可用的消息原文。")
            except (ui.TestError, ValueError, OSError, subprocess.SubprocessError):
                # Do not lose the new bubble by moving the checkpoint forward.
                # In particular, don't pass OCR of a command to the chat model.
                return "private_copy_unavailable"
            if len(original) > 500:
                continue
            item.update(text=original, visual_text=message.text)
        elif snapshot.context == "private" and private_copy is not None and PRIVATE_SCHEDULED_COMMAND.match(message.text):
            # Quoted text isn't a trusted source for a scheduling command.
            continue
        accepted_messages.append(item)
    pending = accepted_messages
    if snapshot.context == "group":
        for message in pending:
            message["group_policy_revision"] = policy.revision
    overflow = False
    if snapshot.context == "private" and any(queue_command(item["text"]) for item in pending):
        # Leave a control lane even when a paused queue is already full.
        existing = state.pending(binding)
        control_slots = len(QUEUE_COMMANDS) - sum(queue_command(event.observation.get("text")) for event in existing)
        ordinary_slots = MAX_QUEUE - sum(not queue_command(event.observation.get("text")) for event in existing)
        accepted = []
        for item in pending:
            if queue_command(item["text"]):
                if control_slots > 0:
                    accepted.append(item)
                    control_slots -= 1
                else:
                    return "queue_full"
            elif ordinary_slots > 0:
                accepted.append(item)
                ordinary_slots -= 1
            else:
                overflow = True
        pending = accepted
    elif len(pending) + state.pending_count(binding) > MAX_QUEUE:
        return "queue_full"
    if ((private_pixels is not None and "private_pixels" not in checkpoint.observation)
            or (group_pixels is not None and "group_pixels" not in checkpoint.observation)
            or (private_art is not None and private_art != checkpoint.observation.get("private_art"))
            or mention or tuple(message.identity for message in snapshot.messages) != tuple(
        message.identity for message in previous.messages
    )):
        state.intake(binding, checkpoint.sequence, observation, pending, consume_mention=bool(mention))
    return "queue_full" if overflow else "ready"


def snapshot_from_checkpoint(target, checkpoint):
    return MessageSnapshot(target, tuple(VisibleMessage(**message) for message in checkpoint.observation["messages"]))


def arrivals_after_stickers(before, after, messages):
    """Use two independent historical sticker rows when no text anchor existed."""
    if not before or not after:
        return None
    old = before[-2:]
    if len(old) != 2 or old[0][0] == old[1][0]:
        return None
    overlapping = []
    for first, second in zip(after, after[1:]):
        if ([first[0], first[1], first[3]] == [old[0][0], old[0][1], old[0][3]]
                and [second[0], second[1], second[3]] == [old[1][0], old[1][1], old[1][3]]
                and second[2] - first[2] == old[1][2] - old[0][2]):
            overlapping.append(second)
    if len(overlapping) != 1:
        return None
    last = overlapping[0]
    return tuple(row for row in messages if row.direction == "incoming" and row.box[1] >= last[2] + last[3])


def observed_arrivals(checkpoint, previous, current, pixels):
    arrivals = new_messages(previous, current)
    old_pixels = checkpoint.observation.get("private_pixels")
    if arrivals is not None or current.context != "private" or pixels is None or not isinstance(old_pixels, list):
        return arrivals
    old_rows, new_rows = previous.messages, current.messages
    if len(old_pixels) != len(old_rows) or len(pixels) != len(new_rows):
        return None
    candidates = []
    for start in range(min(3, len(new_rows))):
        for count in range(2, min(len(old_rows), len(new_rows) - start) + 1):
            segment = pixels[start:start + count]
            if old_pixels[-count:] != segment or len(set(segment)) < 2:
                continue
            if any(pixels[other:other + count] == segment for other in range(len(pixels) - count + 1) if other != start):
                continue
            aligned = tuple(zip(old_rows[-count:], new_rows[start:start + count]))
            dy = aligned[-1][1].box[1] - aligned[-1][0].box[1]
            if all((old.direction, old.sender, old.box[0], old.box[1] + dy, *old.box[2:]) ==
                   (new.direction, new.sender, *new.box) for old, new in aligned):
                candidates.append(tuple(row for row in new_rows[start + count:] if row.direction == "incoming"))
    if candidates and all(candidate == candidates[0] for candidate in candidates):
        return candidates[0]
    return None


def group_pixel_overlap(checkpoint, previous, current, pixels):
    """Prove the old group tail by ordered pixels only on a freshly native-mentioned frame."""
    old_pixels = checkpoint.observation.get("group_pixels")
    if (current.context != "group" or not isinstance(old_pixels, list) or not isinstance(pixels, list)
            or len(old_pixels) != len(previous.messages) or len(pixels) != len(current.messages)):
        return None
    candidates = []
    for start in range(min(3, len(pixels))):
        for count in range(2, min(len(old_pixels), len(pixels) - start) + 1):
            segment = pixels[start:start + count]
            if old_pixels[-count:] != segment or len(set(segment)) < 2:
                continue
            if any(pixels[other:other + count] == segment for other in range(len(pixels) - count + 1) if other != start):
                continue
            aligned = tuple(zip(previous.messages[-count:], current.messages[start:start + count]))
            if (share_vertical_shift(aligned)
                    and all(left.direction == right.direction and left.sender and left.sender == right.sender
                            and left.identity[3:] == right.identity[3:] for left, right in aligned)):
                candidates.append((start, count))
    if candidates and len({sum(pair) for pair in candidates}) == 1:
        return max(candidates, key=lambda pair: pair[1])
    return None


def observed_private_sticker_tail(state, binding, checkpoint, current, pixels):
    """A confirmed reply can scroll the frame early, leaving only its request."""
    old_pixels = checkpoint.observation.get("private_pixels") or []
    old = snapshot_from_checkpoint("private", checkpoint).messages
    if not old or not current.messages or not old_pixels:
        return None
    latest = state.history(binding)
    if (len(latest) < 2 or latest[-1] != {"role": "assistant", "text": "[表情包]"}
            or not re.fullmatch(r"\s*/sticker(?:\s+library)?\s*", latest[-2]["text"], re.IGNORECASE)
            or not re.fullmatch(r"\s*/sticker(?:\s+library)?\s*", old[-1].text, re.IGNORECASE)):
        return None
    digest = old_pixels[-1]
    if old_pixels.count(digest) != 1 or pixels.count(digest) != 1:
        return None
    index = pixels.index(digest)
    anchor = current.messages[index]
    if (old[-1].direction != "incoming" or anchor.direction != "incoming" or anchor.sender != old[-1].sender
            or (anchor.box[0], *anchor.box[2:]) != (old[-1].box[0], *old[-1].box[2:])):
        return None
    return tuple(row for row in current.messages[index+1:] if row.direction == "incoming")


def private_visual_digests(path, messages):
    with Image.open(path) as frame:
        return [hashlib.sha256(ui.private_bubble_pixels(frame, message)).hexdigest() for message in messages]


def owner_drawer_state(settings, path):
    """Read the native details drawer's vertical divider in the fixed WeChat window."""
    x, y, width, height = settings["window"]
    edge = x + width - 252
    rows = range(y + 115, y + height - 170)
    with Image.open(path) as source:
        image = source.convert("RGB")
        if not rows or not (1 <= edge < image.width - 1 and 0 <= rows.start < rows.stop <= image.height):
            return None
        pixels = image.load()
        divider = sum(pixels[edge, row] == (240, 240, 240) and pixels[edge + 1, row] == (250, 250, 250)
                      for row in rows)
        background = sum(pixels[edge + 1, row] == (250, 250, 250) for row in rows)
        continuous = sum(pixels[edge - 1, row] == pixels[edge, row] == pixels[edge + 1, row] for row in rows)
    # Wide green bubbles darken the divider but are clipped immediately
    # to its right. Require both the divider and the flat drawer interior.
    if divider * 2 >= len(rows) and background * 10 >= len(rows) * 9 and continuous * 4 <= len(rows):
        return True
    if divider * 50 <= len(rows) and continuous * 3 >= len(rows) * 2:
        return False
    return None


def owner_drawer_shadow(settings, path):
    """Confirm the drawer's one-column shadow over chat content."""
    x, y, width, height = settings["window"]
    edge = x + width - 252
    rows = range(y + 115, y + height - 170)
    with Image.open(path) as source:
        image = source.convert("RGB")
        if not rows or not (1 <= edge < image.width - 1 and 0 <= rows.start < rows.stop <= image.height):
            return False
        pixels = image.load()
        shadow = plain = flat = 0
        for row in rows:
            if pixels[edge + 1, row] != (250, 250, 250):
                continue
            flat += 1
            left, divider = pixels[edge - 1, row], pixels[edge, row]
            if left == divider:
                plain += 1
            elif all(abs(a * 0.96 - b) <= 1 for a, b in zip(left, divider)):
                shadow += 1
    # Glyph edges inside a clipped bubble differ column to column, so those
    # rows prove nothing either way; only unshaded or non-flat rows contradict.
    return flat * 50 >= len(rows) * 49 and plain * 50 <= len(rows) and shadow * 3 >= len(rows) * 2


def owner_profile(settings, path):
    """Pin rendered account ID glyphs, with the native details/card controls as anchors."""
    x, y, width, _ = settings["window"]
    details_click = (x + width - 42, y + 57)
    avatar_click = (x + width - 211, y + 105)
    dismiss_click = (x + 520, y + 53)
    if not ui.verify_title(settings, path, "private"):
        raise ui.DiagnosticTestError("已绑定私聊未处于前台。", code="title_mismatch")

    def has_details():
        return any(ui.normalize(line["text"]) in {"searchchathistory", "查找聊天记录"}
                   for line in ui.points(settings["ocr"], path, [x + 625, y + 163, 218, 40]))

    def drawer_state():
        native = owner_drawer_state(settings, path)
        if native is None and owner_drawer_shadow(settings, path) and has_details():
            return True
        return native

    drawer = drawer_state()
    if drawer is None:
        raise ui.DiagnosticTestError("无法确认私聊详情面板状态。", code="drawer_state_unknown")
    if not drawer:
        ui.click(*details_click)
        time.sleep(0.35)
        ui.capture_wechat(settings, path)
    opened_profile = False
    try:
        if drawer_state() is not True or not has_details():
            raise ui.DiagnosticTestError("未确认原生私聊详情。", code="drawer_not_open")
        ui.click(*avatar_click)
        opened_profile = True
        time.sleep(0.35)
        ui.snapshot(path)
        lines = ui.recognize(settings["ocr"], path)
        field = [line for line in lines if x + 765 <= line["x"] <= x + 805 and y + 145 <= line["y"] <= y + 185
                 and re.match(r"(?i)^(?:weixin\s+(?:id|td)|微信号)[:：]\s*[a-z0-9_-]+$", line["text"])]
        if len(field) != 1 or not any(ui.normalize(line["text"]) in {"friendprofile", "朋友资料"}
                                      and x + 690 <= line["x"] <= x + 750 for line in lines):
            raise ui.DiagnosticTestError("无法核对原生联系人资料卡。", code="send_owner_profile_unverified")
        identifier = re.split(r"[:：]", field[0]["text"], maxsplit=1)[1].strip()
        # The card wraps a long ID onto an indented second line; join it, or the ID is wrong.
        wrapped = [line for line in lines if field[0]["x"] + 30 <= line["x"] <= field[0]["x"] + 120
                   and field[0]["y"] + 8 <= line["y"] <= field[0]["y"] + 22
                   and re.fullmatch(r"(?i)[a-z0-9_-]+", line["text"].strip())]
        if len(wrapped) > 1:
            raise ui.DiagnosticTestError("无法核对原生联系人资料卡。", code="send_owner_profile_unverified")
        if wrapped:
            identifier += wrapped[0]["text"].strip()
        with Image.open(path) as image:
            glyphs = image.crop((x + 778, y + 151, x + 994, y + 183)).convert("RGB")
            return hashlib.sha256(glyphs.tobytes()).hexdigest(), identifier
    finally:
        if opened_profile:
            ui.click(*dismiss_click)
            time.sleep(0.35)
        if not ui.verify_title(settings, path, "private"):
            raise ui.DiagnosticTestError("关闭私聊详情前无法核对会话。", code="title_mismatch")
        drawer = drawer_state()
        if drawer is True:
            ui.click(*details_click)
            time.sleep(0.35)
            if not ui.verify_title(settings, path, "private"):
                raise ui.DiagnosticTestError("关闭私聊详情后无法核对会话。", code="title_mismatch")
            drawer = drawer_state()
        if drawer is not False:
            raise ui.DiagnosticTestError("无法确认私聊详情面板已关闭。", code="drawer_not_closed")


def owner_fingerprint(settings, path):
    return owner_profile(settings, path)[0]


def owner_record(settings, runtime):
    value = json.loads((runtime / "owner.json").read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("account") != settings["account_name"]
            or value.get("title") != settings["targets"]["private"]["title"]
            or not re.fullmatch(r"[0-9a-f]{64}", value.get("fingerprint", ""))):
        raise ui.DiagnosticTestError("主号绑定已变化。", code="send_owner_binding_mismatch")
    return value


def verify_owner(settings, path, runtime):
    value = owner_record(settings, runtime)
    if not hmac.compare_digest(value["fingerprint"], owner_fingerprint(settings, path)):
        raise ui.DiagnosticTestError("私聊资料卡与一次性绑定不符。", code="send_owner_binding_mismatch")


def group_fingerprints(settings, path, *, active=False):
    title = unicodedata.normalize("NFC", settings["targets"]["group"]["title"])
    if active:
        header = ui.points(settings["ocr"], path, settings["header"])
        if sum(ui.native_group_title(line["text"]) == title for line in header) != 1:
            raise ui.DiagnosticTestError("无法确认绑定群的完整原生标题。", code="title_mismatch")
    group = settings.get("_bound_group")
    rows = ui.group_chat_rows(settings, path, title, active=active, fingerprints=group.fingerprints if group else ())
    if not rows and group is not None:
        sidebar = ui.recognize(settings["ocr"], path, settings["search_results"])
        rows = ui.group_chat_rows(settings, path, title, active=active, fingerprints=group.fingerprints, lines=sidebar)
    if len(rows) != 1:
        raise ui.DiagnosticTestError("侧栏未出现唯一的绑定群。", code="send_group_binding_mismatch")
    return list(rows[0][1])


def verify_group(settings, path, runtime, *, active=False):
    group = settings.get("_bound_group")
    expected = group.fingerprints if group is not None else owner_record(settings, runtime)["group_fingerprints"]
    if not set(expected).intersection(group_fingerprints(settings, path, active=active)):
        raise ui.DiagnosticTestError("群聊头像与绑定记录不符。", code="send_group_binding_mismatch")


def enrolled_groups(settings, runtime, owner=None):
    if owner is None:
        owner = owner_record(settings, runtime)
    legacy_removed, groups = read_group_registry(runtime)
    if not legacy_removed:
        legacy = settings["targets"].get("group")
        if isinstance(legacy, dict) and owner.get("group_fingerprints"):
            group = BoundGroup(LEGACY_GROUP, parse_group_title(legacy["title"]),
                               parse_fingerprints(owner["group_fingerprints"]))
            if any(item.title == group.title for item in groups.values()):
                raise ValueError("Duplicate enrolled group title.")
            groups = {LEGACY_GROUP: group, **groups}
    if len(groups) > MAX_GROUPS:
        raise ValueError("Too many enrolled groups.")
    return groups


def settings_for_group(settings, group):
    legacy = settings["targets"].get("group", {})
    group_target = legacy if group.id == LEGACY_GROUP else {"title": group.title}
    return {**settings, "targets": {**settings["targets"], "group": group_target}, "_bound_group": group}


def active_group(settings, path):
    ui.capture_wechat(settings, path)
    titles = [title for line in ui.points(settings["ocr"], path, settings["header"])
              if (title := ui.native_group_title(line["text"])) is not None]
    if len(titles) != 1:
        raise ui.TestError("请选择显示成员人数的微信原生群聊。")
    title = parse_group_title(titles[0])
    selected_settings = {**settings, "targets": {**settings["targets"], "group": {"title": title}}}
    fingerprints = tuple(group_fingerprints(selected_settings, path, active=True))
    return title, fingerprints


def bind_selected_group(state, settings, path, runtime, *, initial_off=False, roster_selection=None, reader=None):
    groups = enrolled_groups(settings, runtime)
    title, fingerprints = active_group(settings, path)
    if roster_selection is not None and title != roster_selection[1]:
        raise ui.DiagnosticTestError("当前微信标题与列表中的群聊不符。", code="title_mismatch")
    for group in groups.values():
        if group.title == title:
            if roster_selection is None and set(group.fingerprints).intersection(fingerprints):
                return group
            raise ui.TestError("当前群名已绑定到不同的头像。")
    if len(groups) >= MAX_GROUPS:
        raise OverflowError("Group enrollment is full.")
    # The first read of a newly bound group is a baseline. Recheck the screen
    # before publishing the binding so clicks or navigation cannot substitute it.
    group = BoundGroup(uuid.uuid4().hex, title, fingerprints)
    verified_title, verified_fingerprints = active_group(settings, path)
    if verified_title != title or not set(verified_fingerprints).intersection(fingerprints):
        raise ui.DiagnosticTestError("绑定期间微信群聊已改变。", code="title_mismatch")
    owner = owner_record(settings, runtime)
    binding = group_binding_key(settings, owner, group)
    pins = DbIntake.pins(state)
    private = pins.get(private_binding_key(settings, owner))
    if private is None:
        raise ui.DiagnosticTestError("请先为已绑定的主号启用数据库监听。")
    reader = reader or DatabaseReader()
    result = reader.read({"op": "discover", "owner": {"id": private.conversation_id}, "groups": [{"title": title}]})
    if result.get("account_id") != private.account_id or len(result.get("groups", [])) != 1:
        raise DatabaseUnavailable("account_binding_changed")
    conversation = result["groups"][0]["id"]
    if roster_selection is not None and (result.get("owner", {}).get("id") != private.conversation_id
            or digest_group_id(private.account_id, conversation) != roster_selection[0]):
        raise ui.DiagnosticTestError("数据库会话与选中的群聊不符。", code="group_conversation_mismatch")
    should_attest = roster_selection is not None or any(
        row.direction == "incoming" and row.sender
        for row in ui.conversation_messages(settings_for_group(settings, group), path, "group")
    )
    if should_attest:
        attest_database_group(reader, settings, path, runtime, private.account_id, private.conversation_id, group, conversation)
    legacy_removed, additional = read_group_registry(runtime)
    if initial_off:
        write_group_policy(runtime, {"mode": "off", "sender": None}, group.id)
    new_scope = DbScope(binding, "group", conversation, read_group_policy(runtime, group.id))
    intake = DbIntake(state, private.account_id, owner["fingerprint"], (
        DbScope(private_binding_key(settings, owner), "private", private.conversation_id), new_scope,
    ))
    active_binding_ids = set(enrolled_bindings(settings, runtime, groups).values())
    intake.enroll(retired_bindings={key for key, pin in pins.items()
                                   if pin.target == "group" and key not in active_binding_ids and key != binding})
    request = intake.request()
    if request.get("baseline"):
        intake.apply(request, reader.read(request))
    additional[group.id] = group
    write_group_registry(runtime, legacy_removed, additional)
    return group


def bind_reply_group(state, settings, path, runtime, roster_id, *, reader=None):
    if len(enrolled_groups(settings, runtime)) >= MAX_GROUPS:
        raise OverflowError("Group enrollment is full.")
    _, owner, group_ids = digest_group_pins(state, settings, runtime)
    reader = reader or DatabaseReader()
    roster = reader.read({"op": "digest_group_list", "account_id": owner.account_id,
                          "owner_id": owner.conversation_id, "group_ids": group_ids})
    if roster.get("account_id") != owner.account_id:
        raise DatabaseUnavailable("account_binding_changed")
    matches = [row for row in roster["groups"] if row["id"] == roster_id and not row.get("replying")]
    if len(matches) != 1:
        raise ui.DiagnosticTestError("选中的群聊已不在可添加列表中。", code="group_not_found")
    title = parse_group_title(matches[0]["title"])
    if sum(ui.normalize(row["title"]) == ui.normalize(title) for row in roster["groups"]) != 1:
        raise ui.DiagnosticTestError("存在同名微信群，请先在微信里区分群名。", code="group_title_ambiguous")
    selected = {**settings, "targets": {**settings["targets"], "group": {"title": title}}}
    ui.open_target(selected, path, "group", search_only=True)
    return bind_selected_group(state, settings, path, runtime, roster_selection=(roster_id, title), reader=reader)


def enrollment_digest(challenge):
    return hashlib.sha256(ui.normalize(f"绑定桌宠 {challenge}").encode()).hexdigest()


def enroll(state, settings, path, runtime, digest, *, expected_fingerprint=None):
    if (runtime / "owner.json").exists():
        raise ui.TestError("主号已经绑定。")
    current = thread_snapshot(settings, path, "private")
    if not current.messages or current.messages[-1].direction != "incoming" or (
        not hmac.compare_digest(hashlib.sha256(ui.normalize(current.messages[-1].text).encode()).hexdigest(), digest)
    ):
        return False
    fingerprint, identifier = owner_profile(settings, path)
    if expected_fingerprint is not None and not hmac.compare_digest(fingerprint, expected_fingerprint):
        raise ui.TestError("私聊资料卡与发出口令前的会话不符。")
    if not hmac.compare_digest(fingerprint, owner_fingerprint(settings, path)):
        raise ui.TestError("无法得到稳定的私聊资料卡。")
    group = group_fingerprints(settings, path)
    reader = DatabaseReader()
    owner_title = settings["targets"]["private"]["title"]
    legacy_title = settings["targets"]["group"]["title"]
    discovered = reader.read({"op": "discover", "owner": {"title": owner_title, "alias": identifier},
                              "groups": [{"title": legacy_title}]})
    legacy = BoundGroup(LEGACY_GROUP, legacy_title, tuple(group))
    conversation = discovered["groups"][0]["id"]
    attest_database_group(reader, settings, path, runtime, discovered["account_id"],
                          discovered["owner"]["id"], legacy, conversation)
    ui.open_target(settings, path, "private")
    owner = {"fingerprint": fingerprint}
    scopes = [
        DbScope(private_binding_key(settings, owner), "private", discovered["owner"]["id"]),
        DbScope(group_binding_key(settings, owner, legacy), "group", conversation, read_group_policy(runtime)),
    ]
    intake = DbIntake(state, discovered["account_id"], fingerprint, scopes)
    intake.enroll()
    request = intake.request()
    if request.get("baseline"):
        intake.apply(request, reader.read(request))
    with tempfile.TemporaryDirectory(dir=runtime) as temporary:
        pending = Path(temporary) / "owner.json"
        with pending.open("x", encoding="utf-8") as handle:
            json.dump({"account": settings["account_name"], "title": settings["targets"]["private"]["title"],
                       "fingerprint": fingerprint, "group_fingerprints": group}, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(pending, runtime / "owner.json")
    return True


def private_receipt_frame(settings, path, messages):
    if owner_drawer_state(settings, path) is not False:
        return False
    with Image.open(path) as image:
        native = tuple(bubble_boxes(image, settings["chat"]))
    return native == tuple((message.direction, tuple(message.box)) for message in messages)


def receipt_text(text):
    return "".join(key(text).split())


def private_attempt_proof(settings, path, messages, original, reply, *, verified_duplicate=None):
    anchor = verified_duplicate if verified_duplicate is not None else select_quote(messages, original.sender, original.text)
    if (anchor is None or anchor.identity != original.identity or anchor != messages[-1]
            or any(item.direction == "outgoing" and receipt_text(item.text) == receipt_text(reply) for item in messages)
            or not private_receipt_frame(settings, path, messages)):
        return None
    proof = {"version": 1, "anchor": list(anchor.identity), "box": list(anchor.box)}
    if verified_duplicate is not None:
        with Image.open(path) as frame:
            proof["native_pixels"] = hashlib.sha256(ui.private_bubble_pixels(frame, anchor)).hexdigest()
    return proof


def private_receipt_matches(event, messages, settings, path):
    observation = event.observation or {}
    if (observation.get("presentation") or {}).get("voice") is True:
        return False
    proof = observation.get("receipt_proof")
    if event.status != "uncertain" or not event.reply or not isinstance(proof, dict) or proof.get("version") != 1:
        return False
    if isinstance(proof.get("native_pixels"), str):
        box = proof.get("box")
        if (not isinstance(box, list) or len(box) != 4 or len(messages) < 2
                or not private_receipt_frame(settings, path, messages)):
            return False
        anchor, reply = messages[-2:]
        if (anchor.direction != "incoming" or anchor.sender != observation.get("sender") or anchor.quoted_sender or anchor.quoted_text
                or (anchor.box[0], *anchor.box[2:]) != (box[0], *box[2:])
                or reply.direction != "outgoing" or reply.sender != settings["account_name"] or reply.quoted_sender or reply.quoted_text
                or not 0 <= reply.box[1] - anchor.box[1] - anchor.box[3] <= 100):
            return False
        with Image.open(path) as frame:
            return (hashlib.sha256(ui.private_bubble_pixels(frame, anchor)).hexdigest() == proof["native_pixels"]
                    and receipt_text(reply.text) == receipt_text(event.reply))
    anchor = select_quote(messages, observation.get("sender"), observation.get("visual_text", observation.get("text")))
    if anchor is None or list(anchor.identity) != proof.get("anchor"):
        return False
    old_box = proof.get("box")
    if not isinstance(old_box, list) or len(old_box) != 4 or (anchor.box[0], *anchor.box[2:]) != (
        old_box[0], *old_box[2:]
    ):
        return False
    expected = receipt_text(event.reply)
    matches = [item for item in messages if item.direction == "outgoing"
               and receipt_text(item.text) == expected]
    following = messages[messages.index(anchor) + 1:]
    if len(matches) != 1 or not following or following[0] != matches[0]:
        return False
    reply = matches[0]
    gap = reply.box[1] - (anchor.box[1] + anchor.box[3])
    return (key(reply.sender) == key(settings["account_name"]) and not reply.quoted_sender and not reply.quoted_text
            and 0 <= gap <= 100 and private_receipt_frame(settings, path, messages))


def observe_private(state, binding, settings, path, runtime, verified):
    private = thread_snapshot(settings, path, "private")
    old_private = state.checkpoint(binding)
    changed = old_private is None or new_messages(snapshot_from_checkpoint("private", old_private), private) != ()
    receipts = [event for event in state.uncertain(binding) if private_receipt_matches(event, private.messages, settings, path)]
    if not verified or changed or receipts:
        verify_owner(settings, path, runtime)
        private = thread_snapshot(settings, path, "private")
    for event in receipts:
        if private_receipt_matches(event, private.messages, settings, path) and state.reconcile_sent(event.id):
            log("delivery", target="private", outcome="receipt_reconciled")
    # A digest of the actual pixels can retain an already-known visual anchor
    # when OCR reads the same punctuation differently after the pane scrolls.
    pixels = private_visual_digests(path, private.messages) if private.messages else []
    private_art = sticker_visual_anchors(settings, path, private.messages) if not private.messages or (
        old_private is not None and not old_private.observation.get("messages")) else None
    return save_observation(state, binding, private, authorize=True, private_pixels=pixels, private_art=private_art,
                            private_copy=lambda message: ui.copy_private_message(settings, path, message))


def observe_group(state, group_binding, settings, path, runtime):
    group = settings.get("_bound_group")
    try:
        policy = read_group_policy(runtime, group.id) if group is not None else read_group_policy(runtime)
    except (OSError, ValueError):
        return "group_policy_invalid"
    checkpoint = state.checkpoint(group_binding)
    rebaseline = checkpoint is None or group_revision(checkpoint.observation) != policy.revision
    if policy.mode == "off":
        if rebaseline:
            state.rebaseline(group_binding, {"messages": [], "group_policy_revision": policy.revision})
        return "off"

    pending_mention = None
    group_status = "ready"
    if policy.mode == "mentions" and not rebaseline:
        sidebar = settings["search_results"]
        title = settings["targets"]["group"]["title"]
        fingerprints = group.fingerprints if group else owner_record(settings, runtime)["group_fingerprints"]
        def inspect_badge(lines):
            rows = ui.group_chat_rows(settings, path, title, fingerprints=fingerprints, lines=lines)
            if len(rows) != 1:
                return None, None
            row = rows[0][0]
            return native_group_mention(path, lines, sidebar, title, group_row=row), row

        badge, row = inspect_badge(ui.recognize(settings["ocr"], path))
        if badge is not True:
            lines = ui.recognize(settings["ocr"], path, sidebar)
            badge, row = inspect_badge(lines)
        pending_mention = state.pending_mention(group_binding)
        now = time.time()
        if pending_mention is not None and (pending_mention["sequence"] != checkpoint.sequence
                or not 0 <= now - pending_mention["seen_at"] <= MENTION_TTL):
            # Do not reopen the group or renew a stale badge as a new event.
            # Rearm only after a subsequent verified sidebar frame lacks it.
            if badge is False:
                left, top, width, height = sidebar
                x, y = row["x"], row["y"]
                below = y + max(10, row["height"] - 4)
                bottom = y + 59
                if top <= below < bottom <= top + height:
                    with Image.open(path) as image:
                        region = image.crop((max(left, x - 8), below, left + width, bottom)).convert("RGB")
                    if not any(red >= 200 and red - max(green, blue) >= 55 and abs(green - blue) <= 12
                               for red, green, blue in region.get_flattened_data()):
                        state.clear_mention(group_binding)
            pending_mention = None
            group_status = "mention_ambiguous"
        elif pending_mention is None and badge is True:
            pending_mention = {"sequence": checkpoint.sequence, "seen_at": now}
            state.note_mention(group_binding, pending_mention)
    if rebaseline or policy.mode in ("sender", "all") or pending_mention:
        try:
            current = thread_snapshot(settings, path, "group")
            verify_group(settings, path, runtime, active=True)
            with Image.open(path) as image:
                native = tuple(bubble_boxes(image, settings["chat"]))
            pixels = (private_visual_digests(path, current.messages)
                      if native and native == tuple((row.direction, tuple(row.box)) for row in current.messages) else None)
            group_status = save_observation(state, group_binding, current, policy=policy,
                                            group_account=settings.get("account_name"), group_pixels=pixels,
                                            group_copy=lambda row: ui.copy_group_sticker_message(settings, path, row))
        except ui.TestError as error:
            log_failure("waiting", error, "group_observation")
            group_status = "group_unverified"
        ui.open_target(settings, path, "private")
    return group_status


def observe(state, bindings, settings, path, runtime, verified, groups=None):
    private_status = observe_private(state, bindings["private"], settings, path, runtime, verified)
    if groups is None:
        return {"private": private_status, "group": observe_group(state, bindings["group"], settings, path, runtime)}
    statuses = {"private": private_status}
    for group in groups.values():
        statuses[group.id] = observe_group(state, bindings[group.id], settings_for_group(settings, group), path, runtime)
    return statuses


def event_group_policy(runtime, settings, observation):
    group = settings.get("_bound_group")
    try:
        if group is not None:
            legacy_removed, additional = read_group_registry(runtime)
            if (group.id == LEGACY_GROUP and legacy_removed) or (
                group.id != LEGACY_GROUP and additional.get(group.id) != group
            ):
                return "group_removed", None
        policy = read_group_policy(runtime, group.id) if group is not None else read_group_policy(runtime)
    except (OSError, ValueError):
        return "group_policy_invalid", None
    if (policy.mode == "off" or group_revision(observation) != policy.revision
            or ("database" not in observation and not group_sender_matches(policy, observation.get("sender")))):
        return "policy_changed", None
    return "ready", policy


class ReplyRouteChanged(ui.TestError):
    """The model route changed before the prepared reply could be sent."""


def reply_group_id(target, settings):
    if target == "private":
        return None
    group = settings.get("_bound_group")
    return group.id if group is not None else LEGACY_GROUP


def reply_route_matches(runtime, target, settings, presentation, *, binding=None):
    if "knowledgeReplyToken" in presentation and (target != "private" or not knowledge_reply_current(
        runtime, binding, presentation["knowledgeReplyToken"]
    )):
        return False
    if presentation.get("queueControl") is True:
        return (target == "private" and binding is not None
                and private_binding_key(settings, owner_record(settings, runtime)) == binding)
    if presentation.get("richReply") is True or presentation.get("stickerMode") in {"auto", "favorites", "library"}:
        owner = owner_record(settings, runtime)
        if target == "private":
            return private_binding_key(settings, owner) == binding
        group = settings.get("_bound_group")
        return group is not None and group_binding_key(settings, owner, group) == binding
    group_id = reply_group_id(target, settings)
    fingerprint = read_cloud_route(runtime, target, group_id)
    if fingerprint != presentation.get("cloudRoute"):
        return False
    if fingerprint is not None and binding is not None:
        owner = owner_record(settings, runtime)
        if target == "private":
            current = private_binding_key(settings, owner)
        else:
            group = settings.get("_bound_group")
            if group is None:
                return False
            current = group_binding_key(settings, owner, group)
        if current != binding:
            return False
    local_model = presentation.get("localModel")
    return local_model is None or (fingerprint is None and read_reply_settings(runtime)["model"] == local_model)


def reset_reply_route(state, event):
    if not state.reset_prepared(event.id):
        raise StateConflict("Prepared occurrence changed before model route refresh.")
    return "model_route_changed"


def prepared_sticker(runtime, event, presentation, preferences):
    if presentation.get("sticker") is not True or not preferences["stickers"]:
        return None
    try:
        if "stickerAsset" in presentation:
            data = read_staged_sticker(runtime, event.id, presentation["stickerAsset"])
        else:
            data = Path(__file__).with_name("acknowledged-cat.png").read_bytes()
        ui.prepare_sticker(data)
        return data
    except (OSError, ValueError, ui.TestError):
        log("delivery", outcome="sticker_unavailable")
        return None


def checkpoint_tail_original(state, binding, event, original, messages, checkpoint_revision, slot, target):
    """Bind a repeated input to the exact tail freshly admitted by intake."""
    if event.binding != binding or event.status != "prepared" or type(checkpoint_revision) is not int or type(slot) is not int:
        return None
    checkpoint = state.checkpoint(binding)
    if checkpoint is None or checkpoint.sequence != checkpoint_revision or not state.is_latest_checkpoint_occurrence(
        event, checkpoint_revision
    ):
        return None
    recorded = snapshot_from_checkpoint(target, checkpoint).messages
    if slot < 2 or slot != len(recorded) - 1 or slot != len(messages) - 1:
        return None
    def expected(row):
        return row.identity, tuple(row.box)
    if (original.direction != "incoming" or not original.sender or expected(original) != expected(recorded[slot])
            or expected(recorded[slot]) != expected(messages[slot])):
        return None
    if tuple(map(expected, recorded)) != tuple(map(expected, messages)):
        return None
    copies = [row for row in messages if row.identity == original.identity]
    if len(copies) < 2 or len({tuple(row.box) for row in copies}) != len(copies):
        return None
    if target == "private" and recorded[slot - 1].identity == original.identity:
        return None
    return messages[slot]


def private_duplicate_original(state, binding, event, original, messages, checkpoint_revision, slot):
    return checkpoint_tail_original(state, binding, event, original, messages, checkpoint_revision, slot, "private")


def database_message_bubble(messages, observation):
    """Locate a private reply anchor inside the independently verified chat."""
    candidates = [message for message in messages if message.direction == "incoming" and message.sender
                  and key(message.text) == key(observation["text"])]
    if len(candidates) == 1:
        return candidates[0]
    matches = [message for message in candidates if key(message.sender) == key(observation["sender"])]
    return matches[0] if len(matches) == 1 else None


def database_group_quote(settings, path, messages, observation):
    """Locate an unambiguous native quote using exact copied text in this group."""
    body = observation["text"]
    incoming = [row for row in messages if row.direction == "incoming" and row.sender
                and not row.quoted_sender and not row.quoted_text]
    candidates = [row for row in incoming if key(row.text) == key(body)]
    if not candidates:
        candidates = [row for row in incoming if key(row.sender) == key(observation["sender"])]
    if not 1 <= len(candidates) <= 6:
        return None, None
    matches = []
    for row in candidates:
        try:
            raw = ui.copy_group_sticker_message(settings, path, row)
        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
            return None, None
        if raw == body:
            with Image.open(path) as frame:
                matches.append((row, ui.private_bubble_pixels(frame, row)))
    if len(matches) != 1:
        return None, None
    original, pixels = matches[0]
    frame_layout = tuple((row.identity, tuple(row.box)) for row in messages)

    def resolve(current):
        if tuple((row.identity, tuple(row.box)) for row in current) != frame_layout:
            return None
        with Image.open(path) as frame:
            matches = [row for row in current if row.identity == original.identity and row.box == original.box
                       and ui.private_bubble_pixels(frame, row) == pixels]
        return matches[0] if len(matches) == 1 else None

    return original, resolve


def database_receipt(observation_database, *, on_prepare=None, friend_owner=None):
    """Build a pre-click snapshot and an exact post-click database check."""
    conversation = (observation_database or {}).get("conversation_id")
    account = (observation_database or {}).get("account_id")
    if not isinstance(conversation, str) or not isinstance(account, str):
        return None

    def prepare(text=None, *, kind="text"):
        reader = DatabaseReader()
        scope = ({'account_id': account, 'owner_id': friend_owner, 'friend_id': conversation}
                 if friend_owner is not None else {'account_id': account, 'conversation': conversation})
        source_id = observation_database.get("server_id") if kind == "quote" else None
        try:
            if kind == "quote" and (not isinstance(source_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", source_id)):
                raise DatabaseUnavailable("quoted_identity_unavailable")
            baseline = reader.read({"op": "send_baseline", **scope})
            if (baseline.get("account_id") != account or not isinstance(baseline.get("cursors"), dict)
                    or not baseline["cursors"] or type(baseline.get("since")) is not int):
                raise DatabaseUnavailable("guest_response_invalid")
        except DatabaseUnavailable:
            # A missing optional database witness does not invalidate the verified chat.
            return None
        request = {"op": "send_receipt", **scope, "since": baseline["since"], "cursors": baseline["cursors"],
                   "kind": kind, "text": text, "quoted_server_id": source_id}
        if on_prepare is not None:
            on_prepare(request)

        def confirm():
            deadline = time.monotonic() + DATABASE_RECEIPT_WAIT
            while time.monotonic() < deadline:
                try:
                    result = reader.read(request)
                    if result.get("account_id") == account:
                        if result.get("status") == "confirmed":
                            return True
                        if result.get("status") in ("ambiguous", "mismatch"):
                            return False
                except DatabaseUnavailable:
                    pass
                if friend_owner is not None:
                    # Leave a slow or uncommitted friend receipt to late reconciliation.
                    return False
                time.sleep(2)
            return False

        return confirm

    return prepare


def group_speaker(state, settings, bindings, target, observation):
    """Whether a group message comes from the owner, by the database sender ID."""
    if target != "group":
        return {}
    pin = DbIntake.pins(state).get(bindings.get("private"))
    sender_id = (observation.get("database") or {}).get("sender_id")
    owner = pin is not None and pin.target == "private" and isinstance(sender_id, str) and sender_id == pin.conversation_id
    name = " ".join(str(settings.get("targets", {}).get("private", {}).get("title", "")).split())[:80] or "主人"
    return {"speaker": "owner" if owner else "member", "ownerName": name}


def group_request_flooding(recent, binding, observation, now):
    """Record one group request; True when its sender passed the per-minute limit."""
    sender = (observation.get("database") or {}).get("sender_id") or observation.get("sender") or ""
    window = [at for at in recent.get((binding, sender), ()) if now - at < 60]
    if len(window) >= GROUP_SENDER_LIMIT:
        recent[(binding, sender)] = window
        return True
    recent[(binding, sender)] = [*window, now]
    return False


def group_address(sender):
    """Plain-text address used when a native quote is unavailable."""
    name = " ".join(str(sender or "").split())
    return f"@{name} " if name and len(name) <= 40 and name.isprintable() else ""


def deliver(state, binding, target, event, settings, path, runtime, *, base_settings=None, report_failure=None):
    if is_paused(runtime):
        return "paused"
    policy_guard = group_policy_lock(runtime, wait=LISTENER_LOCK_WAIT) if target == "group" else nullcontext()
    base_settings = settings if base_settings is None else base_settings
    with policy_guard, ui.vm_operation():
        observation = event.observation.copy()
        database = observation.pop("database", None)
        visual_text = observation.pop("visual_text", None)
        native_scheduled = (target == "private" and (visual_text is not None or database is not None)
                            and PRIVATE_SCHEDULED_COMMAND.match(observation["text"]) is not None)
        if visual_text is not None:
            observation["text"] = visual_text
        presentation = observation.pop("presentation", {})
        private_tail_revision = observation.pop("private_tail_checkpoint", None)
        private_tail_slot = observation.pop("private_tail_slot", None)
        group_tail_revision = observation.pop("group_tail_checkpoint", None)
        group_tail_slot = observation.pop("group_tail_slot", None)
        if target == "group":
            outcome, policy = event_group_policy(runtime, settings, event.observation)
            if outcome != "ready":
                if outcome in ("group_removed", "policy_changed"):
                    state.skip(event.id)
                return outcome
            observation.pop("group_policy_revision", None)
        if database is not None and not database_event_allowed(state, base_settings, runtime, event):
            return "database_unbound"
        try:
            if not reply_route_matches(runtime, target, settings, presentation, binding=binding):
                return reset_reply_route(state, event)
        except (OSError, ValueError):
            return "cloud_settings_invalid"
        ui.open_target(settings, path, target)
        if target == "private":
            verify_owner(settings, path, runtime)
        attempted = False
        receipt_proof = {}

        def send_receipt_options(*, final=True):
            # Reset between parts and preflight-only fallbacks. Persist the new
            # proof only at its own click boundary.
            receipt_proof.clear()
            receipt_proof.update(version=1, final=final)

            def remember_database(request):
                receipt_proof["database_request"] = request

            def remember_visual(proof):
                receipt_proof["visual"] = proof

            options = {"remember_visual": remember_visual}
            if confirm := database_receipt(database, on_prepare=remember_database):
                options["database_receipt"] = confirm
            return options

        def before_send():
            nonlocal attempted
            if is_paused(runtime):
                raise ui.TestError("监听已暂停。", code="send_policy_changed")
            if not reply_route_matches(runtime, target, settings, presentation, binding=binding):
                raise ReplyRouteChanged("微信回复模型已变化。", code="send_policy_changed")
            if database is not None and not database_event_allowed(state, base_settings, runtime, event):
                raise ui.DiagnosticTestError("数据库消息已无法核对，未发送。", code="send_policy_changed")
            if attempted:
                return state.update_attempt_proof(event.id, receipt_proof)
            attempted = state.mark_attempted(event.id, receipt_proof=receipt_proof)
            return attempted

        try:
            if target == "group":
                verify_group(settings, path, runtime, active=True)
            rich = observation.get("rich")
            current = ui.conversation_messages(settings, path, target) if (
                (target == "group" and rich is None) or database is None
                or presentation.get("stickerMode") or presentation.get("sticker")
            ) else ()
            resolve_group_quote = None
            if database is not None:
                if target == "group" and rich is not None:
                    # Card metadata is not an exact clipboard witness to native quote selection.
                    original = None
                elif target == "group":
                    original, resolve_group_quote = database_group_quote(settings, path, current, observation)
                else:
                    original = database_message_bubble(current, observation)
                matched = original
            else:
                original = VisibleMessage(**observation)
                matched = select_quote(current, original.sender, original.text)
            # The database already proved this message; only its bubble could not be pinned on
            # screen (scrolled away, rewrapped, or copied text differs). Answer it unquoted.
            unquoted = (target == "group" and database is not None and original is None
                        and group_tail_revision is None and group_tail_slot is None)
            if target == "group" and (group_tail_revision is not None or group_tail_slot is not None):
                if (original is None or policy.mode != "mentions" or not original.mentions_account
                        or not sticker_command(event.observation["text"], settings.get("account_name", ""), "group")):
                    state.skip(event.id)
                    return "original_unavailable"

                def resolve_group_quote(messages):
                    return checkpoint_tail_original(state, binding, event, original, messages,
                                                    group_tail_revision, group_tail_slot, "group")

                matched = resolve_group_quote(current)
            duplicate_original = False
            if matched is None and target == "private" and database is None:
                matched = private_duplicate_original(state, binding, event, original, current,
                                                     private_tail_revision, private_tail_slot)
                duplicate_original = matched is not None
            if (matched is None and not unquoted and (target == "group" or database is None)) or (target == "group" and database is None and (
                unicodedata.normalize("NFC", matched.sender) != unicodedata.normalize("NFC", original.sender)
                or not group_sender_matches(policy, matched.sender)
            )):
                state.skip(event.id)
                return "original_unavailable"
            reference = {"sender": original.sender, "text": original.text} if target == "group" and not unquoted else None
            addressed = group_address(observation.get("sender")) if target == "group" else ""
            preferences = read_reply_settings(runtime) if presentation else DEFAULT_REPLY
            explicit_sticker = presentation.get("stickerMode")
            if explicit_sticker:
                def verify_sticker_scope():
                    if not read_reply_settings(runtime)["stickers"]:
                        return False
                    if target == "group" and event_group_policy(runtime, settings, event.observation)[0] != "ready":
                        return False
                    return before_send()

                fallback = STICKER_NOT_AVAILABLE if preferences["stickers"] else STICKER_DISABLED
                if preferences["stickers"] and matched is not None:
                    fallback = STICKER_LIBRARY_NOT_AVAILABLE if explicit_sticker == "library" else STICKER_NOT_AVAILABLE
                    if explicit_sticker in {"auto", "favorites"}:
                        try:
                            if run_native_sticker(target, settings, path, matched, before_send=verify_sticker_scope,
                                                  receipt=lambda: state.mark_sent(event.id), **send_receipt_options()):
                                log("sticker_delivery", target=target, source="favorites", outcome="confirmed")
                                return "ready"
                            if explicit_sticker == "favorites":
                                fallback = "小号微信还没有可发送的收藏表情。"
                        except (ui.AttemptUncertain, ui.SendWindowChanged, ReplyRouteChanged):
                            raise
                        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                            if attempted:
                                raise
                            fallback = STICKER_SELECTION_FAILED
                            log("sticker_delivery", target=target, source="favorites", outcome="preflight_blocked")
                    digest = presentation.get("stickerAsset") if explicit_sticker != "favorites" else None
                    if digest:
                        try:
                            image = read_staged_sticker(runtime, event.id, digest)

                            def verify_library_scope():
                                return read_staged_sticker(runtime, event.id, digest) == image and verify_sticker_scope()

                            ui.run_sticker(target, settings, path, image, before_send=verify_library_scope,
                                           receipt=lambda: state.mark_sent(event.id), expected_anchor=matched, **send_receipt_options())
                            log("sticker_delivery", target=target, source="library", outcome="confirmed")
                            return "ready"
                        except (ui.AttemptUncertain, ui.SendWindowChanged, ReplyRouteChanged):
                            raise
                        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                            if attempted:
                                raise
                            fallback = STICKER_SELECTION_FAILED
                            log("sticker_delivery", target=target, source="library", outcome="preflight_blocked")
                    elif presentation.get("stickerSelectionFailed"):
                        fallback = STICKER_SELECTION_FAILED
                if not state.set_prepared_reply(event.id, fallback):
                    raise StateConflict("Prepared sticker outcome changed before sending.")
                evidence = {"resolve_group_quote": resolve_group_quote} if resolve_group_quote is not None else {}
                ui.run_test("send", target, (addressed if reference is None else "") + fallback, settings, path,
                            quote=reference, before_send=before_send, receipt=lambda: state.mark_sent(event.id),
                            **send_receipt_options(), **evidence)
                return "ready"
            chunks = reply_bubbles(event.reply, presentation.get("split") is True and preferences["split"])
            sticker_png = prepared_sticker(runtime, event, presentation, preferences)
            has_sticker = sticker_png is not None

            def before_send_snapshot(messages):
                if original is None:
                    return
                duplicate = None
                if duplicate_original and not attempted:
                    duplicate = private_duplicate_original(
                        state, binding, event, original, messages, private_tail_revision, private_tail_slot
                    )
                    if duplicate is None:
                        return False
                proof = private_attempt_proof(settings, path, messages, original, chunks[0],
                                              verified_duplicate=duplicate if native_scheduled else None)
                if proof is not None:
                    receipt_proof.update(proof)

            for index, text in enumerate(chunks):
                if index and target == "group":
                    verify_group(settings, path, runtime, active=True)
                final_text = index == len(chunks) - 1
                evidence = {}
                if not index and resolve_group_quote is not None:
                    evidence["resolve_group_quote"] = resolve_group_quote
                if target == "private":
                    if index:
                        evidence["previously_confirmed_part"] = chunks[index - 1]
                    elif duplicate_original or (database is None and len(chunks) == 1 and not has_sticker):
                        evidence["before_send_snapshot"] = before_send_snapshot
                    if native_scheduled and len(chunks) == 1 and not has_sticker:
                        evidence["native_private_receipt"] = True
                receipt = (lambda: state.mark_sent(event.id)) if final_text and not has_sticker else None
                quoted = reference if index == 0 else None
                text_receipt = send_receipt_options(final=final_text and not has_sticker)
                try:
                    ui.run_test("send", target, (addressed if index == 0 and quoted is None else "") + text,
                                settings, path, quote=quoted, before_send=before_send, receipt=receipt,
                                **text_receipt, **evidence)
                except ui.TestError as error:
                    # A native quote that cannot be opened or verified before anything was sent
                    # must not cost the reply: send it once more, addressed instead of quoted.
                    if (quoted is None or attempted or isinstance(error, (ui.AttemptUncertain, ui.SendWindowChanged))
                            or not addressed):
                        raise
                    log_failure("send_check_waiting", error, "group_quote_fallback")
                    ui.open_target(settings, path, target)
                    verify_group(settings, path, runtime, active=True)
                    ui.run_test("send", target, addressed + text, settings, path, before_send=before_send, receipt=receipt,
                                **send_receipt_options(final=final_text and not has_sticker))
            if has_sticker:
                if target == "group":
                    verify_group(settings, path, runtime, active=True)

                def before_sticker():
                    if not read_reply_settings(runtime)["stickers"]:
                        return False
                    if "stickerAsset" in presentation:
                        try:
                            if read_staged_sticker(runtime, event.id, presentation["stickerAsset"]) != sticker_png:
                                return False
                        except (OSError, ValueError):
                            return False
                    return before_send()

                ui.run_sticker(target, settings, path, sticker_png, before_send=before_sticker,
                               receipt=lambda: state.mark_sent(event.id), **send_receipt_options())
        except ReplyRouteChanged as error:
            if attempted:
                if report_failure is not None:
                    report_failure(error)
                state.mark_uncertain(event.id)
                return "send_uncertain"
            return reset_reply_route(state, event)
        except (ui.AttemptUncertain, ui.SendWindowChanged) as error:
            if report_failure is not None:
                report_failure(error)
            log_failure("send_check_waiting", error, f"{target}_send")
            if attempted and isinstance(error, ui.SendWindowChanged):
                # The click guard explicitly denied this part.
                state.update_attempt_proof(event.id, {})
            state.mark_uncertain(event.id)
            return "send_uncertain"
        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError) as error:
            if report_failure is not None:
                report_failure(error)
            log_failure("send_check_waiting", error, f"{target}_send")
            if attempted:
                state.mark_uncertain(event.id)
                return "send_uncertain"
            return "send_preflight_blocked"
        finally:
            if target == "group" and database is None:
                try:
                    ui.open_target(settings, path, "private")
                except ui.TestError as error:
                    log_failure("waiting", error, "return_to_private")
        return "ready"


def group_binding_key(settings, owner, group):
    generation = owner["fingerprint"] if group.id == LEGACY_GROUP else f'{owner["fingerprint"]}:{group.id}'
    title = settings["targets"]["group"]["title"] if group.id == LEGACY_GROUP else group.title
    return binding_key(settings["account_name"], "group", title, generation)


def private_binding_key(settings, owner):
    return binding_key(settings["account_name"], "private", settings["targets"]["private"]["title"], owner["fingerprint"])


def enrolled_bindings(settings, runtime, groups=None):
    owner = owner_record(settings, runtime)
    if groups is None:
        groups = enrolled_groups(settings, runtime, owner)
    return {"private": private_binding_key(settings, owner),
            **{group.id: group_binding_key(settings, owner, group) for group in groups.values()}}


def database_intake(state, settings, runtime, groups, bindings, reader=None):
    owner = owner_record(settings, runtime)
    pins = DbIntake.pins(state)
    private = pins.get(bindings["private"])
    statuses = {entry: "database_unbound" for entry in bindings}
    if private is None or private.owner_fingerprint != owner["fingerprint"]:
        return None, statuses
    scopes = [DbScope(bindings["private"], "private", private.conversation_id,
                      display_name=settings["targets"]["private"]["title"])]
    unresolved = []
    for entry in groups:
        binding = bindings[entry]
        pin = pins.get(binding)
        if pin is None:
            continue
        try:
            policy = read_group_policy(runtime, entry)
        except (OSError, ValueError):
            statuses[entry] = "group_policy_invalid"
            continue
        sender = pin.sender_id if policy.mode == "sender" and pin.sender_revision == policy.revision else None
        scopes.append(DbScope(binding, "group", pin.conversation_id, policy, sender))
        if policy.mode == "sender" and sender is None:
            unresolved.append(scopes[-1])
    if unresolved and reader is not None:
        try:
            result = reader.read({"op": "resolve_senders", "account_id": private.account_id,
                                  "owner_id": private.conversation_id,
                                  "group_ids": [scope.conversation_id for scope in unresolved],
                                  "requests": [{"group_id": scope.conversation_id, "name": scope.policy.sender}
                                               for scope in unresolved]})
            if result.get("account_id") != private.account_id:
                raise DatabaseUnavailable("account_binding_changed")
            requested = {(scope.conversation_id, scope.policy.sender) for scope in unresolved}
            resolved = {(row["group_id"], row["name"]): row["sender_id"] for row in result["results"]
                        if row["status"] == "resolved" and row["sender_id"] != private.account_id
                        and (row["group_id"], row["name"]) in requested}
            scopes = [DbScope(scope.binding, scope.target, scope.conversation_id, scope.policy,
                              scope.sender_id or resolved.get((scope.conversation_id, scope.policy.sender)),
                              scope.display_name) if scope.policy is not None else scope for scope in scopes]
            DbIntake(state, private.account_id, owner["fingerprint"], scopes).enroll()
        except (DatabaseUnavailable, OSError, ValueError, KeyError, TypeError, StateConflict) as error:
            log_failure("waiting", error, "database_sender_lookup")
    return DbIntake(state, private.account_id, owner["fingerprint"], scopes), statuses


# One message must never hold its conversation: a few retries, then move on (and say so in private).
RETRY_DELAYS = (10, 30, 90)
# Statuses that are not this message's failure: waiting on the owner, on a pause, or on a receipt check.
HOLDING_STATUSES = {"ready", "paused", "queue_paused", "send_uncertain", "queue_full"}
GIVE_UP_NOTICE = "刚才那条消息我没处理好，可以再发一次吗？"
# Answering a question long after it was asked does more harm than skipping it.
MAX_WAIT = {"private": 30 * 60, "group": 10 * 60}
# A send that could not be confirmed is released after this, without sending it again.
UNCONFIRMED_RELEASE = 120
DROPPED_WINDOW = 24 * 60 * 60


class DeliveryRetries:
    """Failures of each conversation's first message, kept until it is sent or given up on."""

    def __init__(self):
        self.failures = {}

    def failed(self, event_id):
        """The wait before the next try, or None once its retries are used up."""
        count = self.failures.get(event_id, 0)
        if count >= len(RETRY_DELAYS):
            return None
        self.failures[event_id] = count + 1
        return RETRY_DELAYS[count]

    def clear(self, event_id):
        self.failures.pop(event_id, None)


class QueueGuard:
    """Keeps a conversation's failing first message from holding everything behind it."""

    def __init__(self):
        self.retries = DeliveryRetries()
        self.notice_due = set()
        self.uncertain_since = {}

    def settle(self, state, binding, target, head, outcome, eligible_after, now=None):
        """After a turn at the first message: done, retry later, or give up so the next one can go."""
        now = time.monotonic() if now is None else now
        queue = state.pending(binding)
        if not queue or queue[0].id != head:
            self.retries.clear(head)
            self.notice_due.discard(head)
            return
        if outcome in HOLDING_STATUSES:
            return
        wait = self.retries.failed(head)
        if wait is not None:
            eligible_after[binding] = max(eligible_after.get(binding, 0.0), now + wait)
            log("delivery", target=target, outcome="retry_scheduled", reason=outcome, wait=wait)
            return
        if target == "private" and queue[0].status == "pending" and head not in self.notice_due:
            # Tell the owner rather than go quiet: the next turns try a short notice in its place.
            self.notice_due.add(head)
            self.retries.clear(head)
            log("delivery", target=target, outcome="give_up_notice_due", reason=outcome)
            return
        self.notice_due.discard(head)
        if state.give_up(head, outcome):
            log("delivery", target=target, outcome="given_up", reason=outcome)


def drop_expired(state, binding, target, queue, now=None):
    """Skip messages at the front that waited too long to be worth answering; returns what is left."""
    now = time.time() if now is None else now
    kept = list(queue)
    while kept and kept[0].status == "pending":
        created = ((kept[0].observation or {}).get("database") or {}).get("created_at")
        if type(created) is not int or now - created <= MAX_WAIT[target]:
            break
        if state.give_up(kept[0].id, "expired"):
            log("delivery", target=target, outcome="expired")
        kept.pop(0)
    return kept


def release_unconfirmed(state, binding, target, since, now=None):
    """Stop waiting on a send that could not be confirmed; it is not sent again."""
    now = time.monotonic() if now is None else now
    for event in state.uncertain(binding):
        first = since.setdefault(event.id, now)
        if now - first >= UNCONFIRMED_RELEASE and state.give_up(event.id, "unconfirmed"):
            since.pop(event.id, None)
            log("delivery", target=target, outcome="unconfirmed_released")


def dropped_summary(state, now=None):
    now = time.time() if now is None else now
    dropped = state.dropped_since(now - DROPPED_WINDOW)
    return len(dropped), (dropped[0][2] if dropped else None)


def skipped_summary(state, now=None):
    now = time.time() if now is None else now
    skipped = state.skipped_since(now - DROPPED_WINDOW)
    return len(skipped), (skipped[0][1] if skipped else None), sorted({kind for kind, _ in skipped})[:12]


def reply_texts(event, target):
    """What the reply services may be sent for an event: the request without a /voice command, and
    the text the reply model reads, told when the answer will be spoken. Authorisation accepts only these."""
    text = event.observation["text"]
    if "rich" in event.observation and chat_quote_excerpt(event.observation) is None:
        return text, text, False
    heard = (event.observation.get("voice") or {}).get("heard") is True
    voice = target == "private" and (heard or PRIVATE_VOICE_COMMAND.match(text) is not None)
    asked = PRIVATE_VOICE_COMMAND.sub("", text, count=1) if voice else text
    spoken = asked + VOICE_REPLY_NOTE
    return asked, spoken if voice and len(spoken) <= 500 else asked, voice


def hear_owner_voices(request, response, reader, settings):
    """Transcribe the owner's private voice messages in place; untouched when voice is off."""
    owner = request.get("owner_id")
    rows = [row for row in response.get("rows", []) if isinstance(row, dict) and row.get("conversation_id") == owner
            and row.get("sender_id") == owner and type(row.get("type")) is int
            and row["type"] & 0xFFFFFFFF == OWNER_VOICE_TYPE] if isinstance(response, dict) else []
    if not rows or request.get("baseline"):
        return
    from wechat_voice_transcribe import VoiceTranscriptionError, transcribe, voice_runtime

    try:
        if voice_runtime() is None:
            return
    except VoiceTranscriptionError as error:
        log_failure("waiting", error, "voice_transcription")
        return
    for index, row in enumerate(rows):
        row["transcript"] = ""
        if index >= MAX_HEARD_PER_POLL:
            continue
        try:
            audio = None
            # The message row can land before WeChat has stored its audio.
            for attempt in range(3):
                audio = reader.voice_audio(request["account_id"], owner, row["server_id"])
                if audio is not None:
                    break
                time.sleep(1)
            if audio is not None:
                row["transcript"] = transcribe(audio, [settings["account_name"]])
        except (DatabaseUnavailable, VoiceTranscriptionError) as error:
            log_failure("waiting", error, "voice_transcription")


def visual_send_matches(event, proof, messages, settings, path, target):
    visual = proof.get("visual")
    if isinstance(visual, dict):
        kind = visual.get("kind")
        if kind == "text" and ui.text_attempt_matches(visual, messages, settings["account_name"]):
            return True
        if kind in ("image", "sticker"):
            fingerprints = visual.get("fingerprints")
            if not isinstance(fingerprints, list) or not 1 <= len(fingerprints) <= 3:
                return False
            anchor = ui.media_attempt_anchor(visual, messages, path)
            if anchor is None or not ui.sticker_editor_ready(settings, path):
                return False
            if kind == "image":
                return bool(ui.sticker_receipt_box(settings, path, None, anchor, fingerprints=fingerprints))
            return sticker_receipt_art(settings, path, (), anchor, fingerprints=fingerprints)
    return target == "private" and private_receipt_matches(event, messages, settings, path)


def database_send_matches(event, proof, pin, reader):
    request = proof.get("database_request")
    if (not isinstance(request, dict) or pin is None or pin.retired or request.get("account_id") != pin.account_id
            or request.get("conversation") != pin.conversation_id or request.get("op") != "send_receipt"):
        return False
    visual = proof.get("visual")
    if isinstance(visual, dict):
        kind = request.get("kind")
        if visual.get("kind") == "text":
            if kind not in ("text", "quote") or request.get("text") != visual.get("text"):
                return False
        elif kind not in ("image", "sticker") or kind != visual.get("kind"):
            return False
    elif request.get("kind") != "text" or request.get("text") != event.reply:
        return False
    try:
        receipt = reader.read(request)
        return receipt.get("account_id") == pin.account_id and receipt.get("status") == "confirmed"
    except DatabaseUnavailable as error:
        log_failure("waiting", error, "receipt_reconciliation")
        return False


def reconcile_conversation_sends(state, settings, path, runtime, groups, bindings, scopes, reader):
    pins = DbIntake.pins(state)
    for entry, binding in bindings.items():
        target = "private" if entry == "private" else "group"
        active = settings if target == "private" else settings_for_group(settings, groups[entry])
        pending = []
        pin = pins.get(binding)
        for event in state.uncertain(binding):
            observation = event.observation or {}
            proof = observation.get("receipt_proof")
            if (event.status != "uncertain" or not event.reply or not isinstance(proof, dict)
                    or proof.get("version") != 1):
                continue
            source = observation.get("database")
            if source is not None and (not isinstance(source, dict) or binding not in scopes
                    or pin is None or pin.retired or pin.target != target
                    or source.get("account_id") != pin.account_id or source.get("conversation_id") != pin.conversation_id):
                continue
            pending.append((event, proof))
        if not pending or is_paused(runtime):
            continue

        visual_matches = set()
        if any("visual" in proof or "anchor" in proof for _, proof in pending):
            try:
                with ui.vm_operation():
                    if target == "private":
                        verify_owner_window(settings, path, runtime)
                    else:
                        ui.open_target(active, path, "group")
                        verify_group(active, path, runtime, active=True)
                    window = ui.active_window_id()
                    if ui.verify_title(active, path, target) and ui.active_window_id() == window:
                        messages = ui.conversation_messages(active, path, target)
                        if ui.active_window_id() == window:
                            visual_matches = {event.id for event, proof in pending
                                              if visual_send_matches(event, proof, messages, active, path, target)}
            except (ui.TestError, OSError, ValueError, subprocess.SubprocessError) as error:
                log_failure("waiting", error, "receipt_reconciliation")

        # A control reply can coexist with an unresolved ordinary reply. Never
        # use the same ambiguous visual witness to acknowledge two attempts.
        if len(visual_matches) > 1:
            visual_matches.clear()
        for event, proof in pending:
            if event.id not in visual_matches and not database_send_matches(event, proof, pin, reader):
                continue
            if proof.get("final") is False:
                if state.give_up(event.id, "partial_delivery"):
                    log("delivery", target=target, outcome="partial_reconciled")
            elif state.reconcile_sent(event.id):
                log("delivery", target=target, outcome="receipt_reconciled")


def observe_database(state, settings, path, runtime, groups, bindings, reader):
    with group_policy_lock(runtime, wait=LISTENER_LOCK_WAIT):
        intake, statuses = database_intake(state, settings, runtime, groups, bindings, reader)
        scopes = intake.scopes if intake is not None else {}
        if intake is not None:
            try:
                request = intake.request(limit=60)
                response = reader.read(request)
                hear_owner_voices(request, response, reader, settings)
                result = intake.apply(request, response)
                for entry, binding in bindings.items():
                    if binding in result.statuses:
                        statuses[entry] = result.statuses[binding]
            except (DatabaseUnavailable, StateConflict, ValueError) as error:
                log_failure("waiting", error, "database_observation")
                statuses = {entry: "database_unavailable" if binding in scopes else statuses[entry]
                            for entry, binding in bindings.items()}
        reconcile_conversation_sends(state, settings, path, runtime, groups, bindings, scopes, reader)
    return statuses


def database_event_allowed(state, settings, runtime, event):
    groups = enrolled_groups(settings, runtime)
    bindings = enrolled_bindings(settings, runtime, groups)
    intake, _ = database_intake(state, settings, runtime, groups, bindings)
    return intake is not None and intake.event_authorized(event)


def verify_owner_window(settings, path, runtime):
    ui.open_target(settings, path, "private")
    owner = owner_record(settings, runtime)
    fingerprint, identifier = owner_profile(settings, path)
    if not hmac.compare_digest(owner["fingerprint"], fingerprint):
        raise ui.DiagnosticTestError("私聊资料卡与一次性绑定不符。", code="send_owner_binding_mismatch")
    return owner, identifier


def discover_database_owner(reader, settings, identifier, groups):
    result = reader.read({"op": "discover",
                          "owner": {"title": settings["targets"]["private"]["title"], "alias": identifier},
                          "groups": [{"title": group.title} for group in groups]})
    return result["account_id"], result["owner"]["id"], {row["title"]: row["id"] for row in result["groups"]}


def attest_database_group(reader, settings, path, runtime, account, owner_id, group, conversation):
    active = settings_for_group(settings, group)
    frame = thread_snapshot(active, path, "group")
    verify_group(active, path, runtime, active=True)
    witnesses = []
    for message in reversed(frame.messages):
        if len(witnesses) >= 4:
            break
        if message.direction != "incoming" or not message.sender or message.quoted_text or message.quoted_sender:
            continue
        try:
            native = ui.copy_group_sticker_message(active, path, message)
        except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
            continue
        if 0 < len(native) <= 2000 and native not in witnesses:
            witnesses.append(native)
    if len(witnesses) >= 2:
        result = reader.read({"op": "attest", "account_id": account, "owner_id": owner_id,
                              "group_ids": [conversation],
                              "witnesses": [{"group_id": conversation, "bodies": witnesses}]})
        if result.get("account_id") == account and result.get("results") == [{"group_id": conversation, "matched": True}]:
            return
    raise ui.DiagnosticTestError("无法将已绑定的群聊画面与微信数据库记录关联。")


def enroll_database(state, settings, path, runtime, reader):
    groups = enrolled_groups(settings, runtime)
    bindings = enrolled_bindings(settings, runtime, groups)
    owner, identifier = verify_owner_window(settings, path, runtime)
    account, owner_id, conversations = discover_database_owner(reader, settings, identifier, groups.values())
    scopes = [DbScope(bindings["private"], "private", owner_id,
                      display_name=settings["targets"]["private"]["title"])]
    pins = DbIntake.pins(state)
    for entry, group in groups.items():
        conversation = conversations[group.title]
        binding = bindings[entry]
        if binding not in pins:
            attest_database_group(reader, settings, path, runtime, account, owner_id, group, conversation)
        scopes.append(DbScope(binding, "group", conversation, read_group_policy(runtime, entry)))
    ui.open_target(settings, path, "private")
    DbIntake(state, account, owner["fingerprint"], scopes).enroll()
    intake, _ = database_intake(state, settings, runtime, groups, bindings, reader)
    request = intake.request()
    if not request.get("baseline"):
        return 0
    return len(intake.apply(request, reader.read(request)).baselined)


def queue_command(text):
    return isinstance(text, str) and text.strip().lower() in QUEUE_COMMANDS


def authorize_cloud_request(state, settings, runtime, request):
    if is_paused(runtime):
        return None
    target, group_id = request["target"], request["groupId"]
    if target == 'friend':
        return authorize_friend(state, settings, runtime, request)
    groups = enrolled_groups(settings, runtime)
    scope = "private" if target == "private" else group_id
    binding = enrolled_bindings(settings, runtime, groups).get(scope)
    if not binding or binding != request["binding"]:
        return None
    queue = state.pending(binding)
    if not queue:
        return None
    event = queue[0]
    local = request.get("contextOnly") is True
    command = request.get("ownerCommand") is True
    read_tool = request.get("readTool") is True
    sticker = request.get("stickerSelection") is True
    article = request.get("article")
    rich = request.get("rich")
    quote = chat_quote_excerpt(event.observation)
    expected_quote = None if command or read_tool or sticker else quote
    daily_digests = request.get('dailyDigests')
    if daily_digests is not None and (target != 'private' or local or command or read_tool or sticker
            or article is not None or rich is not None or daily_digests != state.daily_digest_context(binding)):
        return None
    if (event.status != "pending" or event.id != request["eventId"] or request["text"] not in reply_texts(event, target)[:2]
            or article != event.observation.get("article")
            or rich != (event.observation.get("rich") if quote is None else None)
            or request.get("quote") != expected_quote
            or (article is None and rich is None and not (command or read_tool or sticker)
                and state.history(binding, for_cloud=not local, owner=target == "private") != request["history"])):
        return None
    if "database" in event.observation and not database_event_allowed(state, settings, runtime, event):
        return None
    if "database" not in event.observation and binding in DbIntake.pins(state):
        return None
    if command and rich is None:
        return "owner-command" if target == "private" and not request["history"] and owner_command_candidate(request["text"]) else None
    if target == "group" and event_group_policy(
        runtime, settings_for_group(settings, groups[group_id]), event.observation,
    )[0] != "ready":
        return None
    if rich is not None:
        source = event.observation.get("database")
        if (not isinstance(source, dict) or not valid_rich(rich, source.get("type"))
                or (target == "group" and rich["kind"] in {"transfer", "redpacket"})
                or local or command or read_tool or sticker or article is not None
                or request["history"] != [] or request["split"] is not False or request["stickers"] is not False):
            return None
        return "rich"
    preferences = read_reply_settings(runtime)
    if any(preferences[key] != request[key] for key in ("split", "stickers")):
        return None
    if article is not None:
        return "article" if target == "private" and "database" in event.observation and not request["history"] else None
    if read_tool:
        return "read-tool" if not request["history"] and read_tool_candidate(request["text"], settings["account_name"], target) else None
    if sticker:
        return "sticker-selection" if request["stickers"] and not request["history"] else None
    route = read_cloud_route(runtime, target, group_id)
    if local:
        return "local" if route is None and preferences["model"] == request["localModel"] else None
    return route


def authorize_moment_answer(state, settings, runtime, request, draft_id):
    if request["target"] != "private" or not re.fullmatch(r"[a-f0-9]{64}", draft_id):
        return None
    route = authorize_cloud_request(state, settings, runtime, request)
    if not route or not re.fullmatch(r"[a-f0-9]{64}", route):
        return None
    event = state.pending(request["binding"])[0]
    return state.moment_answer_context(request["binding"], draft_id, event)


def owner_turn_waiting(state, binding):
    queue = state.pending(binding)
    if any(database_queue_command(event.observation or {}) for event in queue):
        return True
    return bool(queue) and not state.queue_paused(binding) and not state.uncertain(binding)


def owner_priority_check(state, settings, runtime, binding, reader):
    next_poll = 0.0

    def check(*, force=False):
        nonlocal next_poll
        if is_paused(runtime) or owner_turn_waiting(state, binding):
            raise ReplyYielded()
        now = time.monotonic()
        if not force and now < next_poll:
            return
        next_poll = now + ACTIVE_POLL
        try:
            intake, _ = database_intake(state, settings, runtime, {}, {'private': binding}, reader)
            if intake is None:
                raise ReplyYielded()
            request = intake.request(limit=12)
            response = reader.read(request)
            hear_owner_voices(request, response, reader, settings)
            intake.apply(request, response)
        except (DatabaseUnavailable, StateConflict, ValueError, OSError) as error:
            raise ReplyYielded() from error
        if owner_turn_waiting(state, binding):
            raise ReplyYielded()

    return check


def run(state, settings, path, runtime, *, state_path=None):
    pending_binding = runtime / "pending-enrollment.json"
    while not (runtime / "owner.json").exists():
        if is_paused(runtime):
            write_status(runtime, "paused", reason="awaiting_owner_binding")
        else:
            reason = "awaiting_owner_binding"
            try:
                if pending_binding.exists():
                    request = json.loads(pending_binding.read_text(encoding="ascii"))
                    if time.time() >= request["expires_at"]:
                        reason = "binding_challenge_expired"
                    else:
                        with ui.vm_operation():
                            if enroll(state, settings, path, runtime, request["digest"],
                                      expected_fingerprint=request["fingerprint"]):
                                pending_binding.unlink(missing_ok=True)
                                log("owner_bound")
                                break
            except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                reason = "binding_desktop_unavailable"
            write_status(runtime, "degraded", reason=reason)
        time.sleep(8)
    recovered = set()
    model = None
    eligible_after = {}
    recent_requests = {}
    delay = ACTIVE_POLL
    reader = DatabaseReader()
    guard = QueueGuard()
    friend_lane = FriendReplyLane()
    send_failures = {}
    prune_samples_after = 0.0
    watchdog = None
    if state_path is not None:
        from wechat_app_watchdog import AppWatchdog
        from wechat_owner_delivery import deliver_watchdog_notice

        watchdog = AppWatchdog(state.db, runtime, lambda identity, text, guard:
                               deliver_watchdog_notice(settings, runtime, state_path, identity, text, guard))
    try:
        while True:
            if time.monotonic() >= prune_samples_after:
                prune_samples_after = time.monotonic() + 3600
                try:
                    prune_send_samples(prepare_runtime(prepare_runtime(runtime) / "send-checks"))
                except (OSError, TypeError):
                    pass
            paused = is_paused(runtime)
            if watchdog is not None:
                try:
                    watchdog.tick(paused=paused)
                except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
                    pass  # A failed watchdog must not stop normal replies.
            if paused:
                write_status(runtime, "paused", friends=friend_lane.status(state, 'paused') or None)
                time.sleep(ACTIVE_POLL)
                continue
            stage = "bindings"
            try:
                groups = enrolled_groups(settings, runtime)
                bindings = enrolled_bindings(settings, runtime, groups)
                if set(bindings.values()) - recovered:
                    state.register_transcript_scopes(transcript_scopes(settings, groups, bindings))
                for binding in set(bindings.values()) - recovered:
                    state.recover_attempted(binding)
                    recovered.add(binding)
                stage = "database_observation"
                statuses = observe_database(state, settings, path, runtime, groups, bindings, reader)
                delay = ACTIVE_POLL
                for entry, binding in bindings.items():
                    head = None
                    escaped = False
                    active_settings = settings

                    def report_send_failure(error):
                        send_failures[entry] = ui.send_reason(error)
                        save_send_sample(runtime, active_settings, path, error)

                    try:
                        target = "private" if entry == "private" else "group"
                        stage = f"{target}_delivery"
                        active_settings = settings if target == "private" else settings_for_group(settings, groups[entry])
                        release_unconfirmed(state, binding, target, guard.uncertain_since)
                        if state.uncertain(binding):
                            statuses[entry] = "send_uncertain"
                        queue = state.pending(binding)
                        if not queue and statuses[entry] != "send_uncertain":
                            send_failures.pop(entry, None)
                        controls = [event for event in queue if database_queue_command(event.observation or {})] if target == "private" else []
                        if (statuses[entry] not in ("ready", "queue_full", "send_uncertain") or not queue):
                            continue
                        if controls:
                            event = controls[0]
                            if "database" not in event.observation or not database_event_allowed(state, settings, runtime, event):
                                statuses[entry] = "database_unbound"
                                continue
                            if event.status == "pending":
                                if not state.prepare_queue_command(event, presentation={"queueControl": True, "localContext": True}):
                                    continue
                                event = next(row for row in state.pending(binding) if row.id == event.id)
                            control_status = deliver(state, binding, target, event, active_settings, path, runtime,
                                                     report_failure=report_send_failure)
                            log("delivery", target=target, outcome=control_status)
                            if control_status != "ready" or statuses[entry] != "send_uncertain":
                                statuses[entry] = control_status
                            continue
                        if statuses[entry] == "send_uncertain":
                            continue
                        if time.monotonic() < eligible_after.get(binding, 0.0):
                            if entry in send_failures:
                                statuses[entry] = "send_preflight_blocked"
                            continue
                        if target == "private" and state.queue_paused(binding):
                            statuses[entry] = "queue_paused"
                            continue
                        queue = drop_expired(state, binding, target, queue)
                        if not queue:
                            continue
                        event = queue[0]
                        head = event.id
                        if "database" not in event.observation or not database_event_allowed(state, settings, runtime, event):
                            statuses[entry] = "database_unbound"
                            continue
                        heard = (event.observation.get("voice") or {}) if target == "private" else {}
                        article = event.observation.get("article") if target == "private" else None
                        quote = chat_quote_excerpt(event.observation)
                        rich = event.observation.get("rich") if quote is None else None
                        asked, model_text, voice_requested = reply_texts(event, target)
                        if target == "group":
                            outcome, _ = event_group_policy(runtime, active_settings, event.observation)
                            if outcome != "ready":
                                statuses[entry] = outcome
                                if outcome in ("group_removed", "policy_changed"):
                                    state.skip(event.id)
                                continue
                            if (event.status == "pending"
                                    and group_speaker(state, settings, bindings, target, event.observation).get("speaker") != "owner"
                                    and group_request_flooding(recent_requests, binding, event.observation, time.monotonic())):
                                state.skip(event.id)
                                log("delivery", target=target, outcome="rate_limited")
                                continue
                        if event.status == "pending" and rich is not None:
                            request = {"target": target, "groupId": reply_group_id(target, active_settings), "binding": binding,
                                       "eventId": event.id, "text": asked, "history": [], "split": False, "stickers": False,
                                       "rich": rich}
                            try:
                                reply = GIVE_UP_NOTICE if event.id in guard.notice_due else rich_reply_plan(runtime, request)
                            except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                                statuses[entry] = "rich_reply_unavailable"
                                log("delivery", target=target, outcome=statuses[entry])
                                continue
                            if not state.prepare(event.id, reply, presentation={"richReply": True, "localContext": True}):
                                raise StateConflict("Prepared rich occurrence changed.")
                            event = state.pending(binding)[0]
                        if event.status == "pending":
                            try:
                                preferences = read_reply_settings(runtime)
                                group_id = reply_group_id(target, active_settings)
                                explicit_sticker = sticker_mode(event.observation["text"], settings["account_name"], target)
                                if explicit_sticker:
                                    selection = {"stickerMode": explicit_sticker, "localContext": True}
                                    if preferences["stickers"] and explicit_sticker != "favorites":
                                        try:
                                            digest = select_reply_sticker(runtime, {
                                                "target": target, "groupId": group_id, "binding": binding,
                                                "eventId": event.id, "text": event.observation["text"], "history": [],
                                                "split": preferences["split"], "stickers": True,
                                            }, "已发送表情包")
                                            if digest:
                                                selection["stickerAsset"] = digest
                                        except (OSError, ValueError, subprocess.SubprocessError):
                                            selection["stickerSelectionFailed"] = True
                                    if not state.prepare(event.id, "[表情包]", presentation=selection):
                                        raise StateConflict("Prepared sticker occurrence changed.")
                                    event = state.pending(binding)[0]
                                else:
                                    fingerprint = read_cloud_route(runtime, target, group_id)
                            except (OSError, ValueError):
                                statuses[entry] = "cloud_settings_invalid"
                                continue
                        if event.status == "pending":
                            route = ({"cloudRoute": fingerprint} if fingerprint is not None
                                     else {"localModel": preferences["model"]})
                            candidate_command = (target == "private" and not voice_requested
                                                 and owner_command_candidate(event.observation["text"]))
                            try:
                                owner = target == "private"
                                history = state.history(binding, for_cloud=fingerprint is not None, owner=owner)
                                request = {"target": target, "groupId": group_id, "binding": binding,
                                           "eventId": event.id, "text": asked, "history": history,
                                           "split": preferences["split"], "stickers": preferences["stickers"],
                                           **group_speaker(state, settings, bindings, target, event.observation)}
                                context = None
                                plan = None
                                command = False
                                local_result_request = None
                                if heard and not heard.get("heard"):
                                    # Nothing to answer: ask again rather than guess at what was said.
                                    plan = {"reply": VOICE_UNHEARD_REPLY, "sticker": False}
                                    command = True
                                if event.id in guard.notice_due:
                                    plan = {"reply": GIVE_UP_NOTICE, "sticker": False}
                                    command = True
                                if plan is None and article is not None:
                                    plan = article_reply_plan(runtime, {**request, "article": article, "history": []})
                                    command = True
                                if plan is None and read_tool_candidate(request["text"], settings["account_name"], target):
                                    plan = read_tool_plan(runtime, request)
                                    command = True
                                if plan is None and candidate_command:
                                    plan = owner_command_plan(runtime, {**request, "history": []})
                                    command = plan is not None
                                daily_digests = state.daily_digest_context(binding) if plan is None and target == 'private' else None
                                reference_context = {"quote": quote} if quote is not None else {}
                                if daily_digests is not None:
                                    reference_context['dailyDigests'] = daily_digests
                                if plan is None and fingerprint is None:
                                    if model is None:
                                        model = DeskPet()
                                    context_request = {**request, **({"quote": quote} if quote is not None else {})}
                                    context = local_reply_context(runtime, context_request, preferences["model"])
                                    model_input = {**preferences, **reference_context, **({"context": context} if context else {})}
                                    plan = model.reply_plan(event.id, target, model_text, history, model_input)
                                    local_result_request = context_request
                                elif plan is None:
                                    plan = cloud_reply_plan(runtime, {**request, **reference_context, "text": model_text}, fingerprint)
                            except ReplyRejected:
                                if target == "group" and not reply_route_matches(runtime, target, active_settings, route, binding=binding):
                                    continue
                                # Preserve the conversation's chosen route and give a visible outcome.
                                plan = {"reply": GROUP_REPLY_DECLINED if target == "group" else PRIVATE_REPLY_REJECTED, "sticker": False}
                                command = True
                                log("delivery", target=target, outcome="reply_rejected_notice_prepared")
                            except (ui.TestError, OSError, ValueError, subprocess.SubprocessError):
                                if fingerprint is None and model is not None:
                                    model.close()
                                    model = None
                                statuses[entry] = ("read_tools_unavailable" if read_tool_candidate(event.observation["text"], settings["account_name"], target)
                                                   else "owner_commands_unavailable" if candidate_command and plan is None
                                                   else "cloud_model_unavailable" if fingerprint is not None else "model_unavailable")
                                log("delivery", target=target, outcome=statuses[entry])
                                continue
                            presentation = {"split": preferences["split"] and not command and not plan.get("assistant"),
                                            "sticker": preferences["stickers"] and plan["sticker"], **route}
                            if voice_requested:
                                presentation.update(voice=True, split=False, sticker=False)
                            if presentation["sticker"]:
                                try:
                                    digest = plan.get("stickerAsset") or select_reply_sticker(runtime, request, plan["reply"])
                                    if digest is not None:
                                        presentation["stickerAsset"] = digest
                                except (OSError, ValueError, subprocess.SubprocessError):
                                    presentation["sticker"] = False
                            if (command or plan.get("privateContext")
                                    or (fingerprint is None and (context or state.history(binding, for_cloud=True, owner=owner) != history))):
                                presentation["localContext"] = True
                            if command and target == "private" and ephemeral_owner_reply(event.observation["text"]):
                                presentation["ephemeralReply"] = True
                            if "knowledgeReplyToken" in plan:
                                # DeskPet's own history keeps the revocable provenance.
                                # Do not copy the result into the listener's plain history or digests.
                                presentation.update(knowledgeReplyToken=plan["knowledgeReplyToken"], ephemeralReply=True)
                            if not command and daily_digests is not None:
                                presentation['dailyDigestUntil'] = daily_digests['expiresAt']
                            if not reply_route_matches(runtime, target, active_settings, presentation, binding=binding):
                                statuses[entry] = "model_route_changed"
                                continue
                            if local_result_request is not None and (owner or plan.get("mood")):
                                report_local_reply(runtime, local_result_request, preferences["model"], plan)
                            if not state.prepare(event.id, plan["reply"], presentation=presentation):
                                raise StateConflict("Prepared occurrence changed.")
                            event = state.pending(binding)[0]
                        if voice_requested and (event.observation.get("presentation") or {}).get("voice") is True:
                            from wechat_voice_send import deliver_private_voice
                            statuses[entry] = deliver_private_voice(state, binding, event, active_settings, path, runtime)
                            if statuses[entry] == "voice_unavailable":
                                # Nothing was clicked: say it in text rather than hold the owner's queue.
                                statuses[entry] = deliver(state, binding, target, event, active_settings, path, runtime,
                                                          base_settings=settings, report_failure=report_send_failure)
                        else:
                            statuses[entry] = deliver(state, binding, target, event, active_settings, path, runtime,
                                                      base_settings=settings, report_failure=report_send_failure)
                        log("delivery", target=target, outcome=statuses[entry])
                        eligible_after[binding] = time.monotonic() + (20 if target == "group" else 8)
                    except (ui.OperationBusy, BlockingIOError, ui.WindowCaptureError):
                        # The desktop itself is busy or lost: every conversation waits for the recovery below.
                        escaped = True
                        raise
                    except (ui.TestError, OSError, ValueError, sqlite3.Error, StateConflict, subprocess.SubprocessError) as error:
                        # One conversation failing must not hold the others.
                        report_send_failure(error)
                        log_failure("waiting", error, stage)
                        statuses[entry] = "delivery_failed"
                    finally:
                        if head is not None and not escaped and statuses[entry] not in SEND_FAILURE_STATES:
                            send_failures.pop(entry, None)
                        if head is not None and not escaped:
                            guard.settle(state, binding, target, head, statuses[entry], eligible_after)
                if not owner_turn_waiting(state, bindings['private']) and not is_paused(runtime):
                    priority = owner_priority_check(state, settings, runtime, bindings['private'], reader)
                    model = friend_lane.step(state, settings, path, runtime, reader, model, priority)
                group_statuses = {group_id: {"status": statuses[group_id],
                                            "pending": state.pending_count(bindings[group_id]),
                                            "uncertain": len(state.uncertain(bindings[group_id]))}
                                  for group_id in groups}
                if statuses["private"] == "ready" and state.queue_paused(bindings["private"]):
                    statuses["private"] = "queue_paused"
                dropped, dropped_at = dropped_summary(state)
                skipped, skipped_at, skipped_kinds = skipped_summary(state)
                send_reason = next((send_failures[entry] for entry, status in statuses.items()
                                    if entry in send_failures and status in SEND_FAILURE_STATES), None)
                write_status(runtime, "running" if all(code in ("ready", "off", "queue_paused") for code in statuses.values()) else "degraded",
                             reason=send_reason, private=statuses["private"], group=statuses.get(LEGACY_GROUP), groups=group_statuses,
                             friends=friend_lane.status(state) or None,
                             pending=sum(state.pending_count(binding) for binding in bindings.values()),
                             uncertain=sum(len(state.uncertain(binding)) for binding in bindings.values()),
                             dropped=dropped, dropped_at=dropped_at,
                             skipped=skipped, skipped_at=skipped_at, skipped_kinds=skipped_kinds)
            except (ui.OperationBusy, BlockingIOError):
                write_status(runtime, "degraded", reason="desktop_busy")
            except (ui.TestError, OSError, ValueError, sqlite3.Error, StateConflict, subprocess.SubprocessError) as error:
                if getattr(error, "code", None) in ui.SEND_REASONS:
                    save_send_sample(runtime, settings, path, error)
                reason = (ui.send_reason(error) if getattr(error, "code", None) in ui.SEND_REASONS
                          else "desktop_or_state_unverified")
                write_status(runtime, "degraded", reason=reason)
                log_failure("waiting", error, stage)
                refocused = False
                if isinstance(error, ui.WindowCaptureError) and error.returncode in (41, 42, 44):
                    try:
                        with ui.vm_operation():
                            if is_paused(runtime):
                                pass
                            elif error.returncode == 44:
                                moved_from = ui.realign_wechat(settings)
                                refocused = moved_from is not None
                                if refocused:
                                    log("wechat_realigned")
                            else:
                                refocused = ui.refocus_wechat(settings)
                                if refocused:
                                    log("wechat_refocused")
                    except (ui.TestError, OSError, ValueError, subprocess.SubprocessError) as recovery_error:
                        log_failure("waiting", recovery_error, "focus_recovery")
                delay = ACTIVE_POLL if refocused else min(delay * 2, 30)
            time.sleep(delay)
    finally:
        friend_lane.close()
        if model:
            model.close()


def public_group(group, runtime, statuses=None, *, needs_worker_upgrade=False):
    status = (statuses or {}).get(group.id, {})
    try:
        policy = read_group_policy(runtime, group.id).public()
    except (OSError, ValueError):
        policy = {"mode": "off", "sender": None}
        status = {**status, "status": "group_policy_invalid"}
    return {"id": group.id, "title": group.title, "policy": policy,
            "status": "worker_upgrade_required" if needs_worker_upgrade else status.get("status"),
            "pending": status.get("pending", 0), "uncertain": status.get("uncertain", 0)}


def channel_status(settings, runtime):
    status = read_status(runtime, stale_after=200)
    title = None
    try:
        legacy = settings["targets"].get("group", {})
        title = legacy.get("title") if isinstance(legacy, dict) else None
        owner = owner_record(settings, runtime)
        groups = enrolled_groups(settings, runtime, owner)
        configured = True
    except (ui.TestError, OSError, ValueError, TypeError, KeyError):
        configured = False
        groups = {}
    version = status["group_policy_version"]
    needs_worker_upgrade = (configured and status["state"] in ("starting", "running", "paused", "degraded")
                            and status["heartbeat_at"] is not None and (version is None or version < GROUP_POLICY_VERSION))
    try:
        policy = read_group_policy(runtime).public()
    except (OSError, ValueError):
        policy = {"mode": "off", "sender": None}
        status = {**status, "state": "degraded", "group": "group_policy_invalid"}
    group_statuses = dict(status.get("groups", {}))
    if status.get("group") and LEGACY_GROUP not in group_statuses:
        group_statuses[LEGACY_GROUP] = {"status": status["group"]}
    legacy_status = status.get("group") if LEGACY_GROUP in groups or not configured else None
    try:
        reply_settings = read_reply_settings(runtime)
    except (OSError, ValueError):
        reply_settings = DEFAULT_REPLY.copy()
    return {"configured": configured,
            "groupName": groups[LEGACY_GROUP].title if LEGACY_GROUP in groups else title if not configured else None,
            "groupBindingSupported": configured and not needs_worker_upgrade,
            "replyTargetBindingSupported": configured and reply_target_binding_supported(status),
            'friendReplySupported': configured and reply_target_binding_supported(status, minimum_version=2),
            'friendStatuses': status.get('friends', []),
            "state": status["state"], "stale": status["stale"], "paused": status["paused"],
            "privateStatus": status.get("private"),
            "sendReason": status.get("reason") if status.get("reason") in ui.SEND_REASONS else None,
            "groupStatus": "worker_upgrade_required" if needs_worker_upgrade else legacy_status,
            "pending": status.get("pending", 0), "uncertain": status.get("uncertain", 0), "groupPolicy": policy,
            "dropped": status.get("dropped", 0), "droppedAt": status.get("dropped_at"),
            "skipped": status.get("skipped", 0), "skippedAt": status.get("skipped_at"),
            "skippedKinds": status.get("skipped_kinds", []),
            "groups": [public_group(group, runtime, group_statuses, needs_worker_upgrade=needs_worker_upgrade)
                       for group in groups.values()], "reply": reply_settings}


def control_group_policy(runtime, change, group_id=LEGACY_GROUP):
    if not GROUP_ID.fullmatch(group_id):
        control_error("invalid_group")
    if group_id != LEGACY_GROUP and group_id not in read_group_registry(runtime)[1]:
        control_error("group_not_found")
    if not change:
        policy = read_group_policy(runtime) if group_id == LEGACY_GROUP else read_group_policy(runtime, group_id)
        print(json.dumps(policy.public(), ensure_ascii=False))
        return
    try:
        raw = sys.stdin.buffer.read(MAX_POLICY_BYTES + 1)
        if len(raw) > MAX_POLICY_BYTES:
            raise ValueError("Group policy exceeds its size limit.")
        value = json.loads(raw)
        parse_policy(value)
    except ValueError:
        control_error("invalid_policy")
    try:
        with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT):
            legacy_removed, groups = read_group_registry(runtime)
            if (group_id == LEGACY_GROUP and legacy_removed) or (group_id != LEGACY_GROUP and group_id not in groups):
                control_error("group_not_found")
            policy = write_group_policy(runtime, value) if group_id == LEGACY_GROUP else write_group_policy(runtime, value, group_id)
    except BlockingIOError:
        control_error("busy")
    print(json.dumps(policy.public(), ensure_ascii=False))


def control_error(code):
    print(json.dumps({"error": code}))
    raise SystemExit(1) from None


def transcript_scopes(settings, groups, bindings):
    return {bindings["private"]: ("private", settings["targets"]["private"]["title"]),
            **{bindings[group.id]: ("group", group.title) for group in groups.values()}}


def control_transcript(action, config, runtime, database):
    if action == "transcript-read":
        groups = enrolled_groups(config, runtime)
        scopes = transcript_scopes(config, groups, enrolled_bindings(config, runtime, groups))
        with WeChatState(database) as state:
            state.register_transcript_scopes(scopes)
            print(json.dumps(state.transcript_batch(), ensure_ascii=False))
        return
    raw = sys.stdin.buffer.read(16_385)
    if len(raw) > 16_384:
        raise ValueError("Transcript acknowledgement is too large.")
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {"version", "entries"} or type(value["version"]) is not int
            or value["version"] != 1 or not isinstance(value["entries"], list) or len(value["entries"]) > 50):
        raise ValueError("Invalid transcript acknowledgement.")
    identities = []
    for entry in value["entries"]:
        if (not isinstance(entry, dict) or set(entry) != {"id", "role"}
                or not isinstance(entry["id"], str) or not re.fullmatch(r"[a-f0-9]{64}", entry["id"])
                or entry["role"] not in ("user", "assistant")):
            raise ValueError("Invalid transcript event.")
        identities.append((entry["id"], entry["role"]))
    with WeChatState(database) as state:
        state.acknowledge_transcript(identities)
    print('{"ok":true}')


@contextmanager
def reply_target_binding(runtime, *, minimum_version=1):
    with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT):
        if not reply_target_binding_supported(read_status(runtime, stale_after=200), minimum_version=minimum_version):
            raise ui.DiagnosticTestError("请先更新微信监听服务。", code="reply_targets_worker_upgrade_required")
        # The pause stops new replies; a reply already being sent finishes first.
        with pause_for_target_binding(runtime), ui.vm_operation(wait=CONTROL_VM_WAIT):
            yield


def control_friend_binding(args, settings, runtime):
    action = args.action
    if ((action == "bind-reply-friend" and not FRIEND_ROSTER_ID.fullmatch(args.roster_id))
            or (action == "remove-reply-friend" and not FRIEND_ID.fullmatch(args.friend))):
        control_error("invalid_friend")
    try:
        if action in ("list-reply-friends", "reply-friend-roster"):
            with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT):
                if action == "list-reply-friends":
                    result = {"friends": [friend.public() for friend in enrolled_friends(settings, runtime).values()]}
                else:
                    with WeChatState(args.state, read_only=True) as state:
                        result = {"friends": reply_friend_roster(state, settings, runtime)}
        else:
            with reply_target_binding(runtime, minimum_version=2), WeChatState(args.state) as state:
                if action == "remove-reply-friend":
                    remove_reply_friend(state, settings, runtime, args.friend)
                    result = {"removed": True}
                else:
                    with tempfile.TemporaryDirectory(prefix="deskpet-wechat-friend-") as temporary:
                        friend = bind_reply_friend(state, settings, Path(temporary) / "screen.png", runtime, args.roster_id)
                        result = friend.public()
    except (BlockingIOError, ui.OperationBusy):
        control_error("busy")
    except OverflowError:
        control_error("friend_limit")
    except DatabaseUnavailable as error:
        control_error({"friend_binding_ambiguous": "friend_title_ambiguous",
                       "friend_binding_invalid": "friend_conversation_mismatch"}.get(error.code, "friend_unverified"))
    except ui.TestError as error:
        code = getattr(error, "code", None)
        control_error(code if code in {"friend_not_found", "friend_title_ambiguous", "send_target_ambiguous",
                                       "title_mismatch", "friend_conversation_mismatch",
                                       "reply_targets_worker_upgrade_required"} else "friend_unverified")
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, StateConflict, subprocess.SubprocessError):
        control_error("friend_unverified")
    print(json.dumps(result, ensure_ascii=False))


def control_group_binding(args, settings, runtime):
    if args.action == "bind-reply-group":
        if not re.fullmatch(r"[a-f0-9]{64}", args.roster_id):
            control_error("invalid_group")
        try:
            with (reply_target_binding(runtime), WeChatState(args.state) as state,
                  tempfile.TemporaryDirectory(prefix="deskpet-wechat-bind-") as temporary):
                group = bind_reply_group(state, settings, Path(temporary) / "screen.png", runtime, args.roster_id)
        except (BlockingIOError, ui.OperationBusy):
            control_error("busy")
        except OverflowError:
            control_error("group_limit")
        except DatabaseUnavailable as error:
            control_error({"binding_ambiguous": "group_title_ambiguous",
                           "binding_not_found": "group_conversation_mismatch"}.get(error.code, "group_unverified"))
        except ui.TestError as error:
            code = getattr(error, "code", None)
            control_error(code if code in {"group_not_found", "group_title_ambiguous", "send_target_ambiguous",
                                           "title_mismatch", "group_conversation_mismatch",
                                           "reply_targets_worker_upgrade_required"} else "group_unverified")
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, StateConflict, subprocess.SubprocessError):
            control_error("group_unverified")
        print(json.dumps(public_group(group, runtime), ensure_ascii=False))
        return

    if args.action == "group-bind":
        status = read_status(runtime, stale_after=200)
        if not status["paused"] or status["state"] not in ("paused", "stopped") or status["stale"]:
            control_error("not_paused")
        try:
            with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT), ui.vm_operation(wait=CONTROL_LOCK_WAIT), WeChatState(args.state) as state:
                if not is_paused(runtime):
                    control_error("not_paused")
                with tempfile.TemporaryDirectory(prefix="deskpet-wechat-bind-") as temporary:
                    group = bind_selected_group(state, settings, Path(temporary) / "screen.png", runtime,
                                                initial_off=args.initial_off)
        except (BlockingIOError, ui.OperationBusy):
            control_error("busy")
        except OverflowError:
            control_error("group_limit")
        except (ui.TestError, OSError, ValueError, KeyError, sqlite3.Error, StateConflict, subprocess.SubprocessError):
            control_error("group_unverified")
        print(json.dumps(public_group(group, runtime), ensure_ascii=False))
        return

    if not GROUP_ID.fullmatch(args.group):
        control_error("invalid_group")
    try:
        with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT), ui.vm_operation(wait=CONTROL_LOCK_WAIT), WeChatState(args.state) as state:
            active = enrolled_groups(settings, runtime)
            if args.group not in active:
                control_error("group_not_found")
            binding = enrolled_bindings(settings, runtime, active)[args.group]
            checkpoint = state.checkpoint(binding)
            if checkpoint is not None:
                state.rebaseline(binding, checkpoint.observation)
            legacy_removed, groups = read_group_registry(runtime)
            if args.group == LEGACY_GROUP:
                legacy_removed = True
            else:
                del groups[args.group]
            write_group_registry(runtime, legacy_removed, groups)
    except (BlockingIOError, ui.OperationBusy):
        control_error("busy")
    except (ui.TestError, OSError, ValueError, KeyError):
        control_error("group_unverified")
    print(json.dumps({"removed": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    for action in ("enroll", "arm-enrollment"):
        actions.add_parser(action).add_argument("challenge")
    for action in ("rebaseline", "acknowledge"):
        recovery = actions.add_parser(action)
        recovery.add_argument("target", choices=TARGETS)
        recovery.add_argument("--group", default=LEGACY_GROUP)
    for action in ("run", "status", "pause", "resume", "plist", "channel-status", "reply-models", "recover-window", "db-enroll",
                   "open-viewer", "cloud-authorize", "cloud-bindings", "transcript-read", "transcript-ack", "owner-deliver",
                   "moments-post", "moments-preview", "digest-group-list", "digest-group-select", "digest-group-read",
                   "followup-group-select", "followup-group-read", "self-test", "vm-health", "app-outage-status", "restart-listener",
                   "official-list", "official-read", "friends-moments-read", "list-reply-friends", "reply-friend-roster"):
        actions.add_parser(action)
    actions.add_parser("moments-answer-context").add_argument("draft_id")
    actions.add_parser("reply-settings").add_argument("--set", action="store_true", required=True)
    policy = actions.add_parser("group-policy")
    policy.add_argument("--set", action="store_true", dest="set_policy")
    policy.add_argument("--group", default=LEGACY_GROUP)
    bind = actions.add_parser("group-bind")
    bind.add_argument("--selected", action="store_true", required=True)
    bind.add_argument("--initial-off", action="store_true")
    actions.add_parser("bind-reply-group").add_argument("--roster-id", required=True)
    actions.add_parser("bind-reply-friend").add_argument("--roster-id", required=True)
    actions.add_parser("remove-reply-friend").add_argument("--friend", required=True)
    actions.add_parser("group-remove").add_argument("--group", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'app-outage-status':
        from wechat_app_watchdog import outage_status

        print(json.dumps(outage_status(args.state)))
        return
    runtime = prepare_runtime(args.runtime)
    if args.action == "plist":
        os.write(1, launchd_plist(args.config, runtime, Path(__file__), state=args.state))
        return
    if args.action == "group-policy":
        control_group_policy(runtime, args.set_policy, args.group)
        return
    if args.action == "reply-models":
        print(json.dumps(list_models()))
        return
    if args.action == "open-viewer":
        print(json.dumps({"url": start_viewer()}))
        return
    if args.action == "reply-settings":
        try:
            value = json.loads(sys.stdin.buffer.read(4097))
            print(json.dumps(write_reply_settings(runtime, value)))
        except LookupError:
            control_error("model_unavailable")
        except (ValueError, OSError):
            control_error("invalid_policy")
        return
    if args.action in ("pause", "resume", "status"):
        if args.action != "status":
            set_paused(runtime, args.action == "pause")
        print(json.dumps(read_status(runtime, stale_after=200)))
        return

    os.environ["DESKPET_WECHAT_VM_CONFIG"] = str(args.config)
    if args.action == "vm-health":
        from wechat_vm_health import vm_health_control
        vm_health_control()
        return
    if args.action == "self-test":
        from wechat_self_test import self_test_control
        self_test_control(ui.config(), runtime, args.state)
        return
    if args.action in ("digest-group-list", "digest-group-select", "digest-group-read"):
        try:
            digest_group_control(args.action, ui.config(), runtime, args.state)
        except (BlockingIOError, ui.OperationBusy):
            control_error("busy")
        except DatabaseUnavailable as error:
            control_error(error.code)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("digest_source_unavailable")
        return
    if args.action in ("followup-group-select", "followup-group-read"):
        from wechat_followup_groups import followup_group_control

        try:
            followup_group_control(args.action, ui.config(), runtime, args.state)
        except (BlockingIOError, ui.OperationBusy):
            control_error("busy")
        except DatabaseUnavailable as error:
            control_error(error.code)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("followup_source_unavailable")
        return
    if args.action in ("official-list", "official-read"):
        try:
            official_source_control(args.action, ui.config(), runtime, args.state)
        except DatabaseUnavailable as error:
            control_error(error.code)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("official_source_unavailable")
        return
    if args.action == "friends-moments-read":
        try:
            friends_moments_control(ui.config(), runtime, args.state)
        except DatabaseUnavailable as error:
            control_error(error.code)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("moments_source_unavailable")
        return
    if args.action in ("moments-post", "moments-preview"):
        from wechat_moments import moments_control, preview_control
        (moments_control if args.action == "moments-post" else preview_control)(ui.config(), runtime, args.state)
        return
    if args.action == "owner-deliver":
        from wechat_owner_delivery import owner_delivery_control
        owner_delivery_control(ui.config(), runtime, args.state)
        return
    if args.action in ("transcript-read", "transcript-ack"):
        try:
            control_transcript(args.action, ui.config(), runtime, args.state)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("transcript_unavailable")
        return
    if args.action in ("cloud-authorize", "cloud-bindings", "moments-answer-context"):
        try:
            settings = ui.config()
            if args.action == "cloud-bindings":
                bindings = enrolled_bindings(settings, runtime)
                owner = owner_record(settings, runtime)
                try:
                    friends = enrolled_friends(settings, runtime, owner)
                except (ui.TestError, OSError, ValueError):
                    friends = {}
                bindings.update({'friend:' + friend.id: friend_binding_key(settings, owner, friend) for friend in friends.values()})
                print(json.dumps(bindings))
                return
            raw = sys.stdin.buffer.read(CLOUD_REQUEST_LIMIT + 1)
            # stdin is already bounded by EOF. The socket parser still
            # requires one newline-terminated frame.
            request = cloud_request_from_bytes(raw if raw.endswith(b"\n") else raw + b"\n")
            with WeChatState(args.state, read_only=True) as state:
                if args.action == "moments-answer-context":
                    state.db.execute("BEGIN")
                    context = authorize_moment_answer(state, settings, runtime, request, args.draft_id)
                    if context is None:
                        control_error("cloud_not_authorized")
                    print(json.dumps({"context": context}))
                    return
                fingerprint = authorize_cloud_request(state, settings, runtime, request)
        except (ui.TestError, OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            control_error("cloud_not_authorized")
        if fingerprint is None:
            control_error("cloud_not_authorized")
        print(json.dumps({"ok": True, "routeFingerprint": fingerprint}))
        return
    if args.action == "restart-listener":
        settings = ui.config()
        if not channel_status(settings, runtime)["configured"]:
            print(json.dumps({"started": False}))
            return
        print(json.dumps(restart_listener(runtime)))
        return
    if args.action == "channel-status":
        try:
            settings = ui.config()
        except (ui.TestError, OSError, TypeError, ValueError):
            settings = {}
        print(json.dumps(channel_status(settings, runtime), ensure_ascii=False))
        return
    if args.action in ("list-reply-friends", "reply-friend-roster", "bind-reply-friend", "remove-reply-friend"):
        try:
            settings = ui.config()
        except (ui.TestError, OSError, TypeError, ValueError):
            control_error("friend_unverified")
        control_friend_binding(args, settings, runtime)
        return
    if args.action in ("group-bind", "group-remove", "bind-reply-group"):
        try:
            settings = ui.config()
        except (ui.TestError, OSError, TypeError, ValueError):
            control_error("group_unverified")
        control_group_binding(args, settings, runtime)
        return
    settings = ui.config()
    if args.action == "db-enroll":
        status = read_status(runtime, stale_after=200)
        if not status["paused"] or status["state"] not in ("paused", "stopped") or status["stale"]:
            control_error("not_paused")
        with group_policy_lock(runtime, wait=CONTROL_LOCK_WAIT), ui.vm_operation(wait=CONTROL_LOCK_WAIT), WeChatState(args.state) as state, tempfile.TemporaryDirectory() as tmp:
            count = enroll_database(state, settings, Path(tmp) / "screen.png", runtime, DatabaseReader())
        print(json.dumps({"baselined": count}))
        return
    if args.action == "recover-window":
        try:
            with ui.vm_operation(), tempfile.TemporaryDirectory(prefix="deskpet-wechat-recover-") as temporary:
                outcome = ui.recover_window(settings, Path(temporary) / "screen.png")
        except ui.OperationBusy:
            control_error("busy")
        print(json.dumps({"outcome": outcome}))
        return
    if args.action in ("enroll", "arm-enrollment") and not re.fullmatch(r"[0-9a-f]{10}", args.challenge):
        raise ui.TestError("无效的一次性口令。")
    if args.action == "arm-enrollment":
        if (runtime / "owner.json").exists():
            raise ui.TestError("主号已经绑定。")
        with ui.vm_operation(), tempfile.TemporaryDirectory(prefix="deskpet-wechat-enroll-") as temporary:
            path = Path(temporary) / "screen.png"
            ui.open_target(settings, path, "private")
            fingerprint = owner_fingerprint(settings, path)
        with tempfile.TemporaryDirectory(dir=runtime) as temporary:
            pending = Path(temporary) / "pending.json"
            pending.write_text(json.dumps({"digest": enrollment_digest(args.challenge),
                                           "fingerprint": fingerprint,
                                           "expires_at": time.time() + ENROLLMENT_TTL}), encoding="ascii")
            os.replace(pending, runtime / "pending-enrollment.json")
        return
    if args.action in ("rebaseline", "acknowledge"):
        status = read_status(runtime, stale_after=200)
        if not status["paused"] or status["state"] not in ("paused", "stopped") or status["stale"]:
            raise ui.TestError("先暂停并等待监听器进入 paused 状态。")
        groups = enrolled_groups(settings, runtime)
        entry = "private" if args.target == "private" else args.group
        binding = enrolled_bindings(settings, runtime, groups).get(entry)
        if not binding:
            raise ui.TestError("没有这个已绑定的会话。")
        if args.target == "group":
            settings = settings_for_group(settings, groups[entry])
        with ui.vm_operation(wait=CONTROL_LOCK_WAIT), WeChatState(args.state) as state, tempfile.TemporaryDirectory() as tmp:
            if args.action == "acknowledge":
                log("uncertain_acknowledged", target=args.target, count=state.acknowledge_uncertain(binding))
            else:
                if binding in DbIntake.pins(state):
                    raise ui.DiagnosticTestError("此会话使用微信数据库检查点。")
                path = Path(tmp) / "screen.png"
                ui.open_target(settings, path, args.target)
                if args.target == "private":
                    verify_owner(settings, path, runtime)
                current = thread_snapshot(settings, path, args.target)
                observation = {"messages": [asdict(message) for message in current.messages]}
                if args.target == "group":
                    verify_group(settings, path, runtime, active=True)
                    observation["group_policy_revision"] = read_group_policy(runtime, entry).revision
                    with Image.open(path) as image:
                        native = tuple(bubble_boxes(image, settings["chat"]))
                    if native and native == tuple((row.direction, tuple(row.box)) for row in current.messages):
                        observation["group_pixels"] = private_visual_digests(path, current.messages)
                else:
                    observation["private_pixels"] = private_visual_digests(path, current.messages)
                    if not current.messages:
                        observation["private_art"] = sticker_visual_anchors(settings, path, current.messages)
                state.rebaseline(binding, observation)
                log("baseline_reset", target=args.target)
        return

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    if args.action == "enroll":
        with ui.vm_operation(), WeChatState(args.state) as state, tempfile.TemporaryDirectory(prefix="deskpet-wechat-enroll-") as tmp:
            if not enroll(state, settings, Path(tmp) / "screen.png", runtime, enrollment_digest(args.challenge)):
                raise ui.TestError("私聊中尚未出现当前一次性口令。")
            (runtime / "pending-enrollment.json").unlink(missing_ok=True)
        log("owner_bound")
        return
    with service_lock(runtime), tempfile.TemporaryDirectory(prefix="deskpet-wechat-listener-") as tmp:
        try:
            write_status(runtime, "starting")
            with WeChatState(args.state) as state:
                run(state, settings, Path(tmp) / "screen.png", runtime, state_path=args.state)
        finally:
            write_status(runtime, "stopped")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (ui.TestError, OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
        log_failure("stopped", error, "startup_or_control")
        raise SystemExit(1)
