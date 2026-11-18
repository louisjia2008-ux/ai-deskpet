"""Guarded, once-only send to the verified owner's private chat.

The account never used File Transfer, so desktop search cannot find it; the owner chose to
receive one short daily test message instead.

No text, contact identity, exception message or path is returned to the doctor.
"""

from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

import vm_console as ui
from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_intake import DbIntake
from wechat_service import is_paused
from wechat_state import WeChatState


STAGES = ("lock", "open", "title", "paste", "click", "ocrReceipt", "dbReceipt")


def parse_request(raw):
    request = json.loads(raw)
    if (not isinstance(request, dict) or set(request) != {"id", "text"}
            or not isinstance(request["id"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["id"])
            or not isinstance(request["text"], str) or not 1 <= len(request["text"]) <= 100
            or not request["text"].strip() or not request["text"].isprintable()):
        raise ValueError("invalid_payload")
    return request


class SelfTestLedger:
    def __init__(self, db):
        self.db = db
        with db:
            db.execute("""CREATE TABLE IF NOT EXISTS wechat_self_tests (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('attempted','sent','uncertain')),
                result TEXT
            )""")

    def previous(self, identifier, digest):
        row = self.db.execute("SELECT digest,status,result FROM wechat_self_tests WHERE id=?", (identifier,)).fetchone()
        if row is None:
            return None
        if row[0] != digest:
            return {"status": "failed", "code": "self_test_conflict"}
        return json.loads(row[2]) if row[2] else {"status": "uncertain", "code": "self_test_db_unconfirmed"}

    def begin(self, identifier, digest):
        with self.db:
            return self.db.execute("INSERT OR IGNORE INTO wechat_self_tests VALUES (?,?,'attempted',NULL)",
                                   (identifier, digest)).rowcount == 1

    def finish(self, identifier, result):
        with self.db:
            self.db.execute("UPDATE wechat_self_tests SET status=?,result=? WHERE id=? AND status='attempted'",
                            ("sent" if result["status"] == "passed" else "uncertain", json.dumps(result), identifier))


def owner_busy(state, pin, reader, now):
    # Include prepared/split replies and uncertain queues: never use their silence as permission.
    if state.db.execute("SELECT 1 FROM wechat_occurrences WHERE status IN ('pending','prepared','attempted','uncertain') LIMIT 1").fetchone():
        return True
    # Completed occurrences have NULL observations and transcripts may already be migrated.
    # Query only the native session's timestamp, not either local content cache.
    try:
        activity = reader.read({'op': 'owner_activity', 'account_id': pin.account_id, 'owner_id': pin.conversation_id})
    except DatabaseUnavailable:
        return True
    if (set(activity) != {'ok', 'at'} or activity['ok'] is not True
            or type(activity['at']) is not int or activity['at'] <= 0):
        return True
    return activity['at'] >= now - 300


def mandatory_receipt(account, conversation, stages, reader):
    def prepare(text, *, kind):
        try:
            baseline = reader.read({"op": "send_baseline", "account_id": account, "conversation": conversation})
            if (baseline.get("account_id") != account or not baseline.get("cursors")
                    or not isinstance(baseline["cursors"], dict) or type(baseline.get("since")) is not int):
                raise DatabaseUnavailable("guest_response_invalid")
        except DatabaseUnavailable as error:
            raise ui.TestError("数据库基线不可用。", code="self_test_db_unavailable") from error
        request = {"op": "send_receipt", "account_id": account, "conversation": conversation,
                   "cursors": baseline["cursors"], "since": baseline["since"], "kind": "text",
                   "text": text, "quoted_server_id": None}

        def confirm():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    response = reader.read(request, timeout=max(0.1, min(8, deadline - time.monotonic())))
                    if response.get("account_id") == account and response.get("status") == "confirmed":
                        stages["dbReceipt"] = True
                        return True
                    if response.get("status") in ("ambiguous", "mismatch"):
                        return False
                except DatabaseUnavailable:
                    pass
                time.sleep(min(2, max(0, deadline - time.monotonic())))
            return False
        return confirm
    return prepare


def self_test(settings, runtime, state_path, request):
    from wechat_listener import owner_record, private_binding_key, owner_priority_check, verify_owner, ReplyYielded

    started = time.monotonic()
    stages = dict.fromkeys(STAGES, False)
    result = {"status": "failed", "code": "self_test_send", "stages": stages, "durationMs": 0}
    attempted = False
    digest = sha256(request["text"].encode()).hexdigest()
    try:
        with ui.vm_operation(wait=60), WeChatState(state_path) as state, TemporaryDirectory(prefix="deskpet-self-test-") as tmp:
            stages["lock"] = True
            ledger = SelfTestLedger(state.db)
            previous = ledger.previous(request["id"], digest)
            if previous is not None:
                return {**result, **previous}
            path = Path(tmp) / "screen.png"
            opened = False
            try:
                if is_paused(runtime):
                    result.update(status="paused", code=None)
                    return result
                owner = owner_record(settings, runtime)
                binding = private_binding_key(settings, owner)
                pin = DbIntake.pins(state).get(binding)
                if pin is None or pin.retired or pin.target != "private" or pin.owner_fingerprint != owner["fingerprint"]:
                    result["code"] = "self_test_db_unavailable"
                    return result
                reader = DatabaseReader()
                priority = owner_priority_check(state, settings, runtime, binding, reader)

                def yield_to_owner():
                    priority(force=True)
                    if owner_busy(state, pin, reader, time.time()):
                        raise ReplyYielded()

                yield_to_owner()
                opened = True
                ui.open_target(settings, path, "private")
                stages["open"] = True
                verify_owner(settings, path, runtime)
                if not ui.verify_title(settings, path, "private"):
                    result["code"] = "self_test_target"
                    return result
                stages["title"] = True

                def before_send():
                    nonlocal attempted
                    if is_paused(runtime):
                        result.update(status="paused", code=None)
                        return False
                    # Re-read on the irreversible boundary, not the in-memory temporary target.
                    if ui.config() != settings or owner_record(settings, runtime) != owner or DbIntake.pins(state).get(binding) != pin:
                        result["code"] = "self_test_settings_changed"
                        return False
                    try:
                        yield_to_owner()
                    except ReplyYielded:
                        result.update(status="paused" if is_paused(runtime) else "skipped", code=None)
                        return False
                    if not ui.verify_title(settings, path, "private"):
                        result["code"] = "self_test_target"
                        return False
                    attempted = ledger.begin(request["id"], digest)
                    return attempted

                ui.run_test("send", "private", request["text"], settings, path,
                            before_send=before_send, require_database_receipt=True,
                            database_receipt=mandatory_receipt(pin.account_id, pin.conversation_id, stages, reader),
                            send_progress=lambda stage, passed: stages.__setitem__(stage, passed))
                result.update(status="passed" if stages["dbReceipt"] else "uncertain",
                              code=None if stages["dbReceipt"] else "self_test_db_unconfirmed")
            except ReplyYielded:
                result.update(status="paused" if is_paused(runtime) else "skipped", code=None)
            except (ui.TestError, OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
                if stages["click"]:
                    result.update(status="uncertain", code="self_test_db_unconfirmed")
                elif getattr(error, "code", None) in ("title_mismatch", "send_target_ambiguous", "send_target_unbound",
                                                          "send_owner_binding_mismatch"):
                    result.update(status="failed", code="self_test_target")
                elif getattr(error, "code", None) == "self_test_db_unavailable":
                    result.update(status="failed", code="self_test_db_unavailable")
            finally:
                result["durationMs"] = max(0, int((time.monotonic() - started) * 1000))
                if attempted:
                    ledger.finish(request["id"], result)
                # Restore the current owner view under the same GUI lock. Never send here.
                try:
                    if opened:
                        current = ui.config()
                        ui.realign_wechat(current)
                        ui.refocus_wechat(current)
                        ui.open_target(current, path, "private")
                except (ui.TestError, OSError, ValueError, KeyError, subprocess.SubprocessError):
                    pass
    except ui.OperationBusy:
        result.update(status="busy", code=None)
    except (ui.TestError, OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError):
        result.update(status="uncertain" if attempted else "failed", code="self_test_send")
    result["durationMs"] = max(0, int((time.monotonic() - started) * 1000))
    return result


def self_test_control(settings, runtime, state_path):
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ValueError("invalid_payload")
        request = parse_request(raw)
    except (ValueError, TypeError):
        result = {"status": "failed", "code": "self_test_payload", "stages": dict.fromkeys(STAGES, False), "durationMs": 0}
    else:
        result = self_test(settings, runtime, state_path, request)
    print(json.dumps(result))
