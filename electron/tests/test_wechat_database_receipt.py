"""A send that OCR cannot confirm is confirmed, or not, by WeChat's own message record."""
from contextlib import ExitStack, contextmanager, nullcontext
import json
import os
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui
import wechat_db_guest as guest
import wechat_listener as listener
import wechat_native_sticker as native
from wechat_db_intake import DbIntake, DbScope
from wechat_messages import VisibleMessage
from wechat_state import WeChatState


ANSWER = "一条很长的回复"
ACCOUNT = "Companion"
ORIGINAL = VisibleMessage("incoming", "Owner", "原消息", False, False, (28, 40, 30, 22))
REPLY = VisibleMessage("outgoing", ACCOUNT, ANSWER, False, False, (76, 76, 70, 26))


class SendWithDatabaseReceiptTest(unittest.TestCase):
    def setUp(self):
        self.settings = {"ocr": "fixture", "chat": [0, 0, 1, 1], "draft": [20, 20, 50, 28], "draft_click": [25, 25],
                         "send": [60, 51, 40, 20], "send_click": [82, 63], "quote_preview": [0, 0, 1, 1]}
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "screen.png"
        self.frame = Image.new("RGB", (120, 100), (247, 247, 247))
        self.button = (66, 56)
        self.frame.putpixel(self.button, (237, 237, 237))
        self.frame.save(self.path)
        self.events = []
        self.current = (ORIGINAL,)
        stack = ExitStack()
        self.addCleanup(stack.close)
        for name in ("open_target", "click", "paste", "clear_clipboard", "open_quote"):
            stack.enter_context(patch.object(ui, name))
        stack.enter_context(patch.object(ui.time, "sleep"))
        stack.enter_context(patch.object(ui, "points", return_value=[]))
        stack.enter_context(patch.object(ui, "verify_title", return_value=True))
        stack.enter_context(patch.object(ui, "active_window_id", return_value=123))
        stack.enter_context(patch.object(ui, "read_draft", return_value=ANSWER))
        stack.enter_context(patch.object(ui, "click_send", side_effect=lambda *_: self.events.append("click")))
        def visible(*_):
            self.events.append("visual")
            return self.current if "click" in self.events else (ORIGINAL,)

        stack.enter_context(patch.object(ui, "conversation_messages", side_effect=visible))

    def send(self, found):
        def prepare(text, *, kind):
            self.events.append(("baseline", text, kind))
            def confirm():
                self.events.append("database")
                return found
            return confirm
        return ui.run_test("send", "group", ANSWER, self.settings, self.path,
                           before_send=lambda: self.events.append("before") or True,
                           receipt=lambda: self.events.append("receipt") or True, database_receipt=prepare)

    def test_visual_receipt_finishes_without_waiting_for_database(self):
        self.current = (ORIGINAL, REPLY)
        self.assertTrue(self.send(False)["ok"])
        self.assertEqual(self.events, [("baseline", ANSWER, "text"), "visual", "before", "click", "visual", "receipt"])

    def test_ocr_box_straddling_the_editor_divider_does_not_block_send(self):
        ImageDraw.Draw(self.frame).rectangle((28, 12, 65, 23), fill=(50, 50, 50))
        self.frame.save(self.path)
        spilled = {"text": "Toolbar label", "x": 28, "y": 12, "width": 38, "height": 17}
        self.current = (ORIGINAL, REPLY)
        with patch.object(ui, "points", side_effect=lambda _ocr, _path, area: [spilled] if area == self.settings["draft"] else []):
            self.assertTrue(self.send(False)["ok"])
        self.assertEqual(self.events.count("click"), 1)

    def test_existing_text_or_unrecognized_media_draft_is_preserved(self):
        self.frame.putpixel(self.button, (0, 185, 111))
        self.frame.save(self.path)
        for manual in ("尚未发送的手写草稿", ""):
            with self.subTest(manual=manual), patch.object(ui, "read_draft", return_value=manual), \
                    patch.object(ui, "paste") as paste, self.assertRaises(ui.TestError) as failure:
                self.send(False)
            self.assertEqual(failure.exception.code, "send_draft_occupied")
            paste.assert_not_called()
        self.assertEqual(self.events, [])

    def test_exact_existing_automated_draft_resumes_without_pasting_again(self):
        self.frame.putpixel(self.button, (0, 185, 111))
        self.frame.save(self.path)
        self.current = (ORIGINAL, REPLY)
        with patch.object(ui, "paste") as paste:
            self.assertTrue(self.send(False)["ok"])
        paste.assert_not_called()
        self.assertEqual(self.events.count("click"), 1)

    def test_database_baseline_precedes_click_and_fallback_follows_visual(self):
        self.assertTrue(self.send(True)["ok"])
        self.assertEqual(self.events, [("baseline", ANSWER, "text"), "visual", "before", "click",
                                       "visual", "visual", "database", "receipt"])

    def test_no_database_record_stays_uncertain(self):
        with self.assertRaises(ui.AttemptUncertain) as failure:
            self.send(False)
        self.assertEqual(failure.exception.code, "send_receipt_unconfirmed")
        self.assertEqual(self.events.count("click"), 1)
        self.assertNotIn("receipt", self.events)

    def test_window_rejection_does_not_consult_a_database_receipt_or_retry(self):
        def reject(*_):
            self.events.append("click_rejected")
            raise ui.SendWindowChanged("window changed")

        with patch.object(ui, "click_send", side_effect=reject):
            with self.assertRaises(ui.SendWindowChanged):
                self.send(True)
        self.assertEqual(self.events, [("baseline", ANSWER, "text"), "visual", "before", "click_rejected"])

    def test_listener_builds_a_receipt_only_with_an_account_and_conversation(self):
        self.assertIsNone(listener.database_receipt(None))
        self.assertIsNone(listener.database_receipt({"local_id": 3}))
        self.assertIsNone(listener.database_receipt({"conversation_id": "123@chatroom"}))
        self.assertTrue(callable(listener.database_receipt(
            {"conversation_id": "123@chatroom", "account_id": "fixture_bot"})))

    def test_unavailable_database_does_not_prevent_visual_receipt(self):
        self.current = (ORIGINAL, REPLY)
        with patch.object(listener.DatabaseReader, "read", return_value={"ok": True, "account_id": "wrong_account"}):
            prepare = listener.database_receipt({"conversation_id": "fixture_owner", "account_id": "fixture_bot"})
            result = ui.run_test("send", "private", ANSWER, self.settings, self.path,
                                 before_send=lambda: self.events.append("before"), database_receipt=prepare)
        self.assertTrue(result["ok"])
        self.assertEqual(self.events, ["visual", "before", "click", "visual"])

    def test_self_test_never_uses_visual_success_as_a_database_receipt(self):
        self.current = (ORIGINAL, REPLY)
        stages = {}
        with self.assertRaises(ui.AttemptUncertain) as failure:
            ui.run_test('send', 'private', ANSWER, self.settings, self.path, before_send=lambda: True,
                        database_receipt=lambda *_args, **_kwargs: lambda: False,
                        require_database_receipt=True, send_progress=lambda stage, passed: stages.__setitem__(stage, passed))
        self.assertEqual(failure.exception.code, 'self_test_db_unconfirmed')
        self.assertTrue(stages['ocrReceipt'])
        self.assertFalse(stages['dbReceipt'])
        self.assertEqual(self.events.count('click'), 1)

    def test_self_test_missing_baseline_never_pastes_or_clicks(self):
        with patch.object(ui, 'paste') as paste, self.assertRaises(ui.TestError) as failure:
            ui.run_test('send', 'private', ANSWER, self.settings, self.path, before_send=lambda: True,
                        database_receipt=lambda *_args, **_kwargs: None, require_database_receipt=True)
        self.assertEqual(failure.exception.code, 'self_test_db_unavailable')
        self.assertNotIn('click', self.events)
        paste.assert_not_called()

    def test_self_test_database_can_confirm_when_ocr_cannot(self):
        stages = {}
        result = ui.run_test('send', 'private', ANSWER, self.settings, self.path, before_send=lambda: True,
                             database_receipt=lambda *_args, **_kwargs: lambda: True,
                             require_database_receipt=True, send_progress=lambda stage, passed: stages.__setitem__(stage, passed))
        self.assertTrue(result['ok'])
        self.assertFalse(stages['ocrReceipt'])
        self.assertTrue(stages['dbReceipt'])


class MediaReceiptPriorityTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "screen.png"
        self.asset = Image.new("RGB", (180, 120), "pink")
        self.asset.save(self.path)
        self.settings = {"send_click": (150, 100), "send": (140, 90, 20, 20)}
        self.events = []
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name in ("open_target", "focus_wechat_editor", "clear_clipboard"):
            self.stack.enter_context(patch.object(ui, name))
        for name in ("verify_title", "sticker_editor_ready", "sticker_draft_verified"):
            self.stack.enter_context(patch.object(ui, name, return_value=True))
        self.stack.enter_context(patch.object(ui.time, "sleep"))
        self.stack.enter_context(patch.object(ui, "active_window_id", return_value=123))
        self.stack.enter_context(patch.object(ui, "conversation_messages", return_value=(ORIGINAL,)))

    def database(self, *, kind):
        self.events.append(("baseline", kind))

        def confirm():
            self.events.append("database")
            return True

        return confirm

    def callbacks(self):
        return {
            "before_send": lambda: self.events.append("durable_attempt"),
            "receipt": lambda: self.events.append("receipt"),
            "database_receipt": self.database,
            "remember_visual": lambda proof: self.events.append(("visual_proof", proof["kind"])),
        }

    def send_image(self, visual):
        with (
            patch.object(ui, "prepare_sticker", return_value=(b"png", self.asset)),
            patch.object(ui, "sticker_receipt_box", side_effect=(None, None, visual, visual)),
            patch.object(ui, "click_send", side_effect=lambda *_: self.events.append("click")),
        ):
            return ui.run_sticker("private", self.settings, self.path, b"png", **self.callbacks())

    def test_visible_image_needs_no_database_row_and_confirms_once(self):
        self.assertTrue(self.send_image((76, 76, 30))["ok"])
        self.assertEqual(self.events, [("baseline", "image"), ("visual_proof", "image"), "durable_attempt", "click", "receipt"])

    def test_missing_visual_image_may_use_the_database_witness_once(self):
        self.assertTrue(self.send_image(None)["ok"])
        self.assertEqual(self.events, [("baseline", "image"), ("visual_proof", "image"), "durable_attempt",
                                       "click", "database", "receipt"])

    def test_visible_favorite_sticker_needs_no_database_row(self):
        def panel_click(*_):
            self.events.append("click" if "durable_attempt" in self.events else "tab")

        with (
            patch.object(native, "open_panel", return_value=native.Panel(124, 123, (0, 0, 240, 240))),
            patch.object(native, "close_panel"),
            patch.object(native, "capture_panel"),
            patch.object(native, "labels", return_value=set()),
            patch.object(native, "favorites_selected", return_value=True),
            patch.object(native, "favorite_art", return_value=self.asset),
            patch.object(native, "panel_click", side_effect=panel_click),
            patch.object(native, "sticker_receipt_art", side_effect=(False, False, True)),
        ):
            self.assertTrue(native.run_native_sticker("private", self.settings, self.path, ORIGINAL, **self.callbacks()))
        self.assertEqual(self.events, [("baseline", "sticker"), "tab", ("visual_proof", "sticker"),
                                       "durable_attempt", "click", "receipt"])


class OwnSentTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE Name2Id(user_name)")
        self.db.executemany("INSERT INTO Name2Id VALUES (?)", (("wxid_own",), ("wxid_friend",)))
        self.table = guest.table_for("123@chatroom")
        self.db.execute(f'CREATE TABLE "{self.table}"(local_id INTEGER, real_sender_id INTEGER, local_type INTEGER, '
                        'create_time INTEGER, message_content, compress_content)')
        self.db.executemany(f'INSERT INTO "{self.table}" VALUES (?,?,?,?,?,NULL)', [
            (1, 1, 1, 100, "旧的同样文字"), (2, 2, 1, 200, "wxid_friend:\n朋友说的"), (3, 1, 1, 200, "新回复\n第二行"),
            (4, 1, 3, 200, "图片"),
        ])

    def found(self, text, since=150, conversation="123@chatroom"):
        @contextmanager
        def fake_open(path, keys):
            yield self.db, None

        with patch.object(guest, "message_shards", return_value=[Path("message_0.db")]), \
                patch.object(guest, "open_logical", new=fake_open):
            return guest.own_sent(Path("."), None, "wxid_own", conversation, since, text)

    def test_only_own_text_after_the_click_matches_exactly(self):
        self.assertTrue(self.found("新回复\n第二行"))
        self.assertFalse(self.found("新回复"))
        self.assertFalse(self.found("旧的同样文字"))
        self.assertTrue(self.found("旧的同样文字", since=0))
        self.assertFalse(self.found("朋友说的"))
        self.assertFalse(self.found("图片"))
        self.assertFalse(self.found("新回复\n第二行", conversation="456@chatroom"))
        with self.assertRaises(guest.LocalDataError):
            self.found("x", conversation="bad id!")


class FreshReceiptTest(unittest.TestCase):
    account = "fixture_self"
    owner = "fixture_owner"

    def setUp(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        self.db = db
        self.generation = "f" * 32
        db.execute("CREATE TABLE Name2Id(user_name)")
        db.executemany("INSERT INTO Name2Id VALUES (?)", ((self.account,), (self.owner,)))
        self.table = guest.table_for(self.owner)
        db.execute(f'CREATE TABLE "{self.table}"(local_id INTEGER, server_id INTEGER, real_sender_id INTEGER, '
                   'local_type INTEGER, create_time INTEGER, message_content, compress_content)')
        self.scope = {"account_id": self.account, "conversation": self.owner}

        @contextmanager
        def open_shard(_path, _keys):
            yield db, self.generation

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(guest, "open_logical", side_effect=open_shard))
        stack.enter_context(patch.object(guest, "message_shards", return_value=[Path("message_0.db")]))
        stack.enter_context(patch.object(guest.time, "time", return_value=1_000))
        self.insert(1, 11, "样本文字")
        self.baseline = self.request("send_baseline")

    def insert(self, local_id, server_id, body, *, kind=1, sender=1, created_at=1_000):
        self.db.execute(f'INSERT INTO "{self.table}" VALUES (?,?,?,?,?,?,NULL)',
                        (local_id, server_id, sender, kind, created_at, body))

    def request(self, operation, **fields):
        return guest.own_send_receipt(Path("."), None, self.account, {"op": operation, **self.scope, **fields})

    def status(self, *, kind="text", text="样本文字", quoted_server_id=None):
        return self.request("send_receipt", **self.baseline, kind=kind, text=text,
                            quoted_server_id=quoted_server_id)["status"]

    def test_previous_same_second_row_does_not_count_and_new_row_must_be_ours(self):
        self.insert(2, 12, "样本文字", sender=2)
        self.assertEqual(self.status(), "pending")
        self.insert(3, 0, "样本文字")
        self.assertEqual(self.status(), "pending")
        self.db.execute(f'UPDATE "{self.table}" SET server_id=13 WHERE local_id=3')
        self.assertEqual(self.status(), "confirmed")
        self.insert(4, 14, "样本文字")
        self.assertEqual(self.status(), "ambiguous")

    def test_quote_must_match_the_typed_title_and_original_server_id(self):
        self.insert(2, 12, "<msg><appmsg><type>57</type><title>样本文字</title>"
                    "<refermsg><svrid>10</svrid></refermsg></appmsg></msg>", kind=(57 << 32) | 49)
        self.assertEqual(self.status(), "pending")
        self.assertEqual(self.status(kind="quote", quoted_server_id="10"), "confirmed")
        self.assertEqual(self.status(kind="quote", quoted_server_id="20"), "mismatch")
        self.assertEqual(self.status(kind="quote", quoted_server_id="10", text="different"), "mismatch")

    def test_clock_drift_uses_the_cursor_to_exclude_existing_rows(self):
        self.insert(2, 12, "样本文字", created_at=997)
        self.assertEqual(self.status(), "pending")
        self.insert(3, 13, "样本文字", created_at=998)
        self.assertEqual(self.status(), "confirmed")

    def test_media_receipt_requires_a_fresh_record_of_the_correct_kind(self):
        self.insert(2, 12, "fixture", kind=3, sender=2)
        self.insert(3, 13, "fixture", kind=47)
        self.assertEqual(self.status(kind="image", text=None), "pending")
        self.assertEqual(self.status(kind="sticker", text=None), "confirmed")
        self.insert(4, 14, "fixture", kind=3)
        self.assertEqual(self.status(kind="image", text=None), "confirmed")

    def test_shard_generation_change_cannot_inherit_the_old_baseline(self):
        self.generation = "a" * 32
        with self.assertRaisesRegex(guest.LocalDataError, "cursor_generation_changed"):
            self.status()

    def test_filehelper_uses_own_fresh_exact_text_without_returning_any_body(self):
        helper = guest.table_for('filehelper')
        self.db.execute(f'ALTER TABLE "{self.table}" RENAME TO "{helper}"')
        self.table = helper
        self.scope = {**self.scope, 'conversation': 'filehelper'}
        self.baseline = self.request('send_baseline')
        self.assertEqual(self.status(), 'pending')
        self.insert(2, 12, '样本文字')
        result = self.request('send_receipt', **self.baseline, kind='text', text='样本文字', quoted_server_id=None)
        self.assertEqual(result, {'status': 'confirmed'})
        self.assertNotIn('样本文字', json.dumps(result, ensure_ascii=False))


class ReconciledReceiptTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = WeChatState(self.root / "ledger.db")
        self.addCleanup(self.state.db.close)
        self.binding = "f" * 64
        self.settings = {"account_name": ACCOUNT}
        self.path = self.root / "synthetic.png"

    def attempt(self, proof, *, next_part=None, database=None):
        event_id = "e" * 64
        observation = {"text": ORIGINAL.text, "sender": ORIGINAL.sender}
        if database is not None:
            observation["database"] = database
        with self.state.db:
            self.state.db.execute("INSERT INTO wechat_occurrences VALUES (?, ?, 1, ?, 'pending', NULL)",
                                  (event_id, self.binding, json.dumps(observation)))
        self.assertTrue(self.state.prepare(event_id, ANSWER))
        self.assertTrue(self.state.mark_attempted(event_id, receipt_proof=proof))
        if next_part is not None:
            self.assertTrue(self.state.update_attempt_proof(event_id, next_part))
        self.assertEqual(self.state.recover_attempted(self.binding), 1)
        return event_id

    def reconcile(self, messages, *, scopes=None, db_match=False):
        with (
            patch.object(ui, "vm_operation", side_effect=nullcontext),
            patch.object(listener, "verify_owner_window"),
            patch.object(listener, "is_paused", return_value=False),
            patch.object(listener, "log"),
            patch.object(ui, "active_window_id", return_value=123),
            patch.object(ui, "verify_title", return_value=True),
            patch.object(ui, "conversation_messages", return_value=messages),
            patch.object(ui, "click_send") as click,
            patch.object(listener.DatabaseReader, "read", return_value={
                "account_id": "fixture_self", "status": "confirmed" if db_match else "pending",
            }) as read,
        ):
            listener.reconcile_conversation_sends(self.state, self.settings, self.path, self.root, {},
                                                   {"private": self.binding}, scopes or {}, listener.DatabaseReader())
            click.assert_not_called()
        return read.call_count

    def assert_recorded_once(self):
        self.assertEqual(self.state.history(self.binding),
                         [{"role": "user", "text": ORIGINAL.text}, {"role": "assistant", "text": ANSWER}])

    def test_late_quote_reconciles_from_visual_without_any_database_pin(self):
        quoted = VisibleMessage("outgoing", ACCOUNT, ANSWER, False, False, REPLY.box, ORIGINAL.sender, ORIGINAL.text)
        proof = {"version": 1, "final": True, "visual": ui.text_attempt_proof((ORIGINAL,), ANSWER, ORIGINAL)}
        self.attempt(proof)
        self.assertEqual(self.reconcile((ORIGINAL, REPLY)), 0)
        self.assertEqual(len(self.state.uncertain(self.binding)), 1)
        self.assertEqual(self.reconcile((ORIGINAL, quoted)), 0)
        self.assertEqual(self.state.uncertain(self.binding), ())
        self.assert_recorded_once()

    def test_late_legacy_proof_reconciles_from_original_visual_witness(self):
        self.attempt({"version": 1, "anchor": list(ORIGINAL.identity), "box": list(ORIGINAL.box)})
        with patch.object(listener, "private_receipt_frame", return_value=True):
            self.assertEqual(self.reconcile((ORIGINAL, REPLY)), 0)
        self.assert_recorded_once()

    def test_partial_receipt_releases_the_queue_without_recording_the_full_reply(self):
        self.attempt({"version": 1, "final": False, "visual": ui.text_attempt_proof((ORIGINAL,), ANSWER, None)})
        self.assertEqual(self.reconcile((ORIGINAL, REPLY)), 0)
        self.assertEqual((self.state.pending(self.binding), self.state.uncertain(self.binding)), ((), ()))
        self.assertEqual(self.state.history(self.binding), [])
        self.assertEqual([reason for _, reason, _ in self.state.dropped_since(0)], ["partial_delivery"])

    def test_only_the_last_attempted_part_is_reconciled(self):
        first_text = "第一段"
        first = VisibleMessage("outgoing", ACCOUNT, first_text, False, False, (76, 60, 70, 14))
        partial = {"version": 1, "final": False, "visual": ui.text_attempt_proof((ORIGINAL,), first_text, None)}
        final = {"version": 1, "final": True, "visual": ui.text_attempt_proof((ORIGINAL, first), ANSWER, None)}
        self.attempt(partial, next_part=final)
        self.assertEqual(self.reconcile((ORIGINAL, first)), 0)
        self.assertEqual(len(self.state.uncertain(self.binding)), 1)
        self.assertEqual(self.reconcile((ORIGINAL, first, REPLY)), 0)
        self.assert_recorded_once()

    def test_late_database_fallback_is_bound_to_the_enrolled_conversation(self):
        owner = DbScope(self.binding, "private", "fixture_owner")
        intake = DbIntake(self.state, "fixture_self", "a" * 64, (owner,))
        intake.enroll()
        fields = {"account_id": "fixture_self", "conversation": "fixture_owner", "op": "send_receipt",
                  "kind": "text", "text": ANSWER}
        database = {"account_id": "fixture_self", "conversation_id": "fixture_owner"}
        self.attempt({"version": 1, "database_request": fields}, database=database)
        self.assertEqual(self.reconcile((ORIGINAL,), db_match=True), 0)
        self.assertEqual(len(self.state.uncertain(self.binding)), 1)
        self.assertEqual(self.reconcile((ORIGINAL,), scopes=intake.scopes, db_match=True), 1)
        self.assert_recorded_once()

    def test_media_visual_proof_requires_a_stable_anchor_and_matching_art(self):
        fixed = Image.new("RGB", (180, 120), "pink")
        fixed.save(self.path)
        signature = Image.new("RGB", (50, 50), "black")
        ImageDraw.Draw(signature).rectangle((4, 4, 24, 45), fill="white")
        pixels = ui.private_bubble_pixels(fixed, ORIGINAL)
        visual = ui.media_attempt_proof("image", ORIGINAL, pixels, [signature])
        proof = {"version": 1, "final": True, "visual": visual}
        self.assertTrue(ui.matches_receipt_fingerprint(signature, visual["fingerprints"]))
        self.assertFalse(ui.matches_receipt_fingerprint(Image.new("RGB", (50, 50), "green"), visual["fingerprints"]))
        self.attempt(proof)
        with patch.object(ui, "sticker_editor_ready", return_value=True), patch.object(ui, "sticker_receipt_box",
                                                                                       return_value=(76, 76, 30)) as box:
            self.assertEqual(self.reconcile((REPLY,)), 0)
            box.assert_not_called()
            self.assertEqual(self.reconcile((ORIGINAL,)), 0)
            box.assert_called_once_with(self.settings, self.path, None, ORIGINAL, fingerprints=visual["fingerprints"])
        self.assert_recorded_once()


class SendSamplesTest(unittest.TestCase):
    def test_captures_private_redacted_samples_and_prunes_count_and_age(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "synthetic.png"
            settings = {"size": (1000, 700), "window": (0, 0, 1000, 700), "send_click": (980, 670)}
            Image.new("RGB", settings["size"], "magenta").save(source)
            for _ in range(23):
                listener.save_send_sample(root, settings, source, ui.TestError("synthetic data", code="drawer_state_unknown"))
            folder = root / "send-checks"
            samples = list(folder.iterdir())
            self.assertEqual(len(samples), 20)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
            self.assertEqual(samples[0].stat().st_mode & 0o777, 0o600)
            self.assertRegex(samples[0].name, r"^\d+_drawer_state_unknown\.png$")
            with Image.open(samples[0]) as isolated:
                self.assertEqual(isolated.getpixel((100, 200)), (0, 0, 0))
                self.assertEqual(isolated.getpixel((748, 200)), (255, 0, 255))
            os.utime(samples[0], (900, 900))
            listener.prune_send_samples(folder, now=900 + listener.SEND_SAMPLE_AGE)
            self.assertFalse(samples[0].exists())
            self.assertEqual(len(list(folder.iterdir())), 19)


if __name__ == "__main__":
    unittest.main()
