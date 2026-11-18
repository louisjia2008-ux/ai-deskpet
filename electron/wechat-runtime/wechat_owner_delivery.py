"""Deliver host-generated notices to the verified WeChat owner."""

from hashlib import sha256
import hmac
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

import vm_console as ui
from wechat_db_intake import DbIntake
from wechat_service import is_paused
from wechat_state import DIGEST_KINDS, WeChatState


DELIVERY_ID = re.compile(r"[0-9a-f]{64}\Z")
MAX_REQUEST_BYTES = 8192
MAX_TEXT_LENGTH = 500


def parse_delivery(raw):
    value = json.loads(raw.decode("utf-8"))
    if (not isinstance(value, dict) or not {"id", "binding", "text"} <= set(value)
            or not set(value) <= {"id", "binding", "text", "stickerAsset", "voice", "recordTranscript", "digestKind"}
            or ("voice" in value and type(value["voice"]) is not bool)
            or ("digestKind" in value and (value["digestKind"] not in DIGEST_KINDS or value.get("voice")
                or "stickerAsset" in value or "recordTranscript" in value))
            or ("recordTranscript" in value and (value["recordTranscript"] is not False or value.get("voice") or "stickerAsset" in value))):
        raise ValueError("Invalid owner delivery request.")
    for field in ("id", "binding"):
        if not isinstance(value[field], str) or not DELIVERY_ID.fullmatch(value[field]):
            raise ValueError("Invalid owner delivery identifier.")
    if "stickerAsset" in value and (not isinstance(value["stickerAsset"], str) or not DELIVERY_ID.fullmatch(value["stickerAsset"])):
        raise ValueError("Invalid owner sticker identifier.")
    text = value["text"]
    if (not isinstance(text, str) or not 1 <= len(text) <= MAX_TEXT_LENGTH or not text.strip()
            or not text.isprintable()):
        raise ValueError("Invalid owner delivery text.")
    return value


class OwnerDeliveryLedger:
    def __init__(self, db):
        self.db = db
        with db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS wechat_owner_deliveries (
                    id TEXT PRIMARY KEY,
                    binding TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('attempted', 'sent', 'uncertain'))
                )
            """)

    def previous(self, delivery_id, binding, digest):
        row = self.db.execute(
            "SELECT binding, digest, status FROM wechat_owner_deliveries WHERE id = ?", (delivery_id,)
        ).fetchone()
        if row is None:
            return None
        if row[:2] != (binding, digest):
            return "conflict"
        return "uncertain" if row[2] == "attempted" else row[2]

    def begin(self, delivery_id, binding, digest):
        with self.db:
            changed = self.db.execute("""
                INSERT OR IGNORE INTO wechat_owner_deliveries (id, binding, digest, status)
                VALUES (?, ?, ?, 'attempted')
            """, (delivery_id, binding, digest)).rowcount == 1
            if changed:
                self.db.execute("UPDATE wechat_moment_previews SET interrupted=1 WHERE binding=?", (binding,))
            return changed

    def finish(self, delivery_id, status, record_sent=None):
        with self.db:
            changed = self.db.execute("""
                UPDATE wechat_owner_deliveries SET status = ? WHERE id = ? AND status = 'attempted'
            """, (status, delivery_id)).rowcount == 1
            if changed and status == "sent" and record_sent is not None:
                record_sent()
            return changed


def owner_delivery_pin(state, settings, runtime, binding):
    from wechat_listener import owner_record, private_binding_key

    owner = owner_record(settings, runtime)
    if not hmac.compare_digest(private_binding_key(settings, owner), binding):
        return None
    pin = DbIntake.pins(state).get(binding)
    if pin is None or pin.retired or pin.target != "private" or pin.owner_fingerprint != owner["fingerprint"]:
        return None
    return pin


def receipt_for_pin(pin):
    from wechat_listener import database_receipt

    return database_receipt({"account_id": pin.account_id, "conversation_id": pin.conversation_id})

def _deliver_text(settings, runtime, state_path, request, *, allow_send=None):
    from wechat_listener import owner_record, private_binding_key, verify_owner

    def binding_matches():
        try:
            current = private_binding_key(settings, owner_record(settings, runtime))
            return hmac.compare_digest(current, request["binding"])
        except (OSError, KeyError, ValueError, ui.TestError):
            return False

    if not binding_matches():
        return "binding_invalid"
    delivery_id, binding, text = request["id"], request["binding"], request["text"]
    record = request.get("recordTranscript", True)
    digest_kind = request.get('digestKind')
    prefix = f'\0digest-{digest_kind}\0' if digest_kind else '' if record else '\0digest-private\0'
    digest = sha256((prefix + text).encode("utf-8")).hexdigest()
    attempted = False
    try:
        with ui.vm_operation(wait=30), WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-wechat-notice-") as tmp:
            ledger = OwnerDeliveryLedger(state.db)
            previous = ledger.previous(delivery_id, binding, digest)
            if previous is not None:
                return previous
            if is_paused(runtime):
                return "paused"
            if allow_send is not None and not allow_send():
                return "retry"
            pin = owner_delivery_pin(state, settings, runtime, binding)
            if pin is None and (request.get("voice") is not True or binding in DbIntake.pins(state)):
                return "binding_invalid"
            path = Path(tmp) / "screen.png"
            ui.open_target(settings, path, "private")
            verify_owner(settings, path, runtime)

            def before_send():
                nonlocal attempted
                if is_paused(runtime) or not binding_matches() or (allow_send is not None and not allow_send()):
                    return False
                if pin is None:
                    if binding in DbIntake.pins(state):
                        return False
                elif owner_delivery_pin(state, settings, runtime, binding) != pin:
                    return False
                attempted = ledger.begin(delivery_id, binding, digest)
                return attempted

            def record_delivery():
                if digest_kind:
                    state.record_owner_digest(delivery_id, binding, digest_kind, text, time.time())
                elif record:
                    state.record_owner_notice(delivery_id, binding, text, time.time())

            try:
                ui.run_test("send", "private", text, settings, path, before_send=before_send,
                            database_receipt=receipt_for_pin(pin) if pin is not None else None,
                            receipt=lambda: ledger.finish(delivery_id, "sent", record_delivery))
            except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
                pass
            if attempted:
                if ledger.previous(delivery_id, binding, digest) == "sent":
                    return "sent"
                ledger.finish(delivery_id, "uncertain")
                return "uncertain"
            return "paused" if is_paused(runtime) else "retry" if binding_matches() else "binding_invalid"
    except ui.OperationBusy:
        return "busy"
    except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        return "uncertain" if attempted else "retry"


def _try_owner_voice(settings, runtime, state_path, request):
    from wechat_listener import owner_record, private_binding_key, verify_owner
    from wechat_voice_send import record_voice
    from wechat_voice_synthesis import synthesize_wav, VoiceSynthesisError

    attempted = False
    digest = sha256(request['text'].encode('utf-8')).hexdigest()
    try:
        with WeChatState(state_path) as state:
            ledger = OwnerDeliveryLedger(state.db)
            previous = ledger.previous(request['id'], request['binding'], digest)
            if previous is not None:
                return previous
            if is_paused(runtime):
                return 'paused'
            if not hmac.compare_digest(private_binding_key(settings, owner_record(settings, runtime)), request['binding']):
                return 'binding_invalid'
            pin = owner_delivery_pin(state, settings, runtime, request['binding'])
            if pin is None:
                # A legacy verified owner may receive the text fallback before
                # voice's database account and conversation have been pinned.
                return 'binding_invalid' if request['binding'] in DbIntake.pins(state) else None
            wav = synthesize_wav(request['text'])
            with ui.vm_operation(wait=30), TemporaryDirectory(prefix='deskpet-owner-voice-') as tmp:
                path = Path(tmp) / 'screen.png'
                ui.open_target(settings, path, 'private')
                verify_owner(settings, path, runtime)

                def before_send():
                    nonlocal attempted
                    if (is_paused(runtime) or not hmac.compare_digest(private_binding_key(settings, owner_record(settings, runtime)), request['binding'])
                            or owner_delivery_pin(state, settings, runtime, request['binding']) != pin):
                        return False
                    attempted = ledger.begin(request['id'], request['binding'], digest)
                    return attempted

                result = record_voice(settings, path, runtime, pin, wav, before_send=before_send)
                if attempted and result['status'] == 'confirmed':
                    ledger.finish(request['id'], 'sent', lambda: state.record_owner_notice(request['id'], request['binding'], request['text'], time.time()))
                    return 'sent'
                if attempted:
                    ledger.finish(request['id'], 'uncertain')
                    return 'uncertain'
    except ui.OperationBusy:
        return 'busy'
    except (ui.TestError, OSError, ValueError, KeyError, VoiceSynthesisError, sqlite3.Error, subprocess.SubprocessError):
        if attempted:
            return 'uncertain'
    return None  # only a proven pre-send failure may fall back to text


def owner_deliver(settings, runtime, state_path, request):
    if request.get('voice') is True:
        voice_status = _try_owner_voice(settings, runtime, state_path, request)
        if voice_status is not None:
            return voice_status
    status = _deliver_text(settings, runtime, state_path, request)
    if status != "sent" or "stickerAsset" not in request:
        return status
    from wechat_listener import verify_owner
    from wechat_reply_settings import read_reply_settings
    from wechat_sticker_spool import read_staged_sticker

    image_id = sha256(f"{request['id']}:sticker".encode()).hexdigest()
    attempted = False
    try:
        with ui.vm_operation(wait=30), WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-owner-sticker-") as tmp:
            ledger = OwnerDeliveryLedger(state.db)
            previous = ledger.previous(image_id, request["binding"], request["stickerAsset"])
            if previous is not None:
                return previous
            pin = owner_delivery_pin(state, settings, runtime, request["binding"])
            if pin is None:
                return "binding_invalid"
            image = read_staged_sticker(runtime, request["id"], request["stickerAsset"])
            path = Path(tmp) / "screen.png"
            ui.open_target(settings, path, "private")
            verify_owner(settings, path, runtime)

            def before_send():
                nonlocal attempted
                if is_paused(runtime) or owner_delivery_pin(state, settings, runtime, request["binding"]) != pin:
                    return False
                if not read_reply_settings(runtime)["stickers"]:
                    return False
                attempted = ledger.begin(image_id, request["binding"], request["stickerAsset"])
                return attempted

            ui.run_sticker("private", settings, path, image, before_send=before_send,
                           receipt=lambda: ledger.finish(image_id, "sent"), database_receipt=receipt_for_pin(pin))
            if ledger.previous(image_id, request["binding"], request["stickerAsset"]) == "sent":
                return "sent"
            if attempted:
                ledger.finish(image_id, "uncertain")
            return "uncertain" if attempted else "retry"
    except ui.OperationBusy:
        return "busy"
    except (ui.TestError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        return "uncertain" if attempted else "retry"


def owner_delivery_control(settings, runtime, state_path):
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Invalid owner delivery size.")
        request = parse_delivery(raw)
    except ValueError:
        status = "invalid_payload"
    else:
        status = owner_deliver(settings, runtime, state_path, request)
    print(json.dumps({"status": status}))


def deliver_watchdog_notice(settings, runtime, state_path, delivery_id, text, allow_send):
    from wechat_listener import owner_record, private_binding_key

    try:
        binding = private_binding_key(settings, owner_record(settings, runtime))
    except (OSError, KeyError, ValueError, ui.TestError):
        return 'binding_invalid'
    return _deliver_text(settings, runtime, state_path,
                         {'id': delivery_id, 'binding': binding, 'text': text, 'recordTranscript': False}, allow_send=allow_send)
