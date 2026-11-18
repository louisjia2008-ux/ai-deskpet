"""One message that keeps failing must not hold its conversation, or any other."""

from contextlib import ExitStack
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import wechat_listener as listener
from test_wechat_db_intake import ACCOUNT, ALL, CONTACT, FINGERPRINT, GROUP, OWNER, ROOM, poll, row
from wechat_db_intake import DbIntake, DbScope
from wechat_state import WeChatState

NOW = 1_800_000_000


class QueueGuardTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.state = WeChatState(Path(root.name) / "ledger.db")
        self.addCleanup(self.state.db.close)
        owner = DbScope(OWNER, "private", CONTACT, display_name="主号")
        room = DbScope(ROOM, "group", GROUP, policy=ALL)
        self.intake = DbIntake(self.state, ACCOUNT, FINGERPRINT, (owner, room))
        self.intake.enroll()
        request = self.intake.request()
        self.intake.apply(request, poll(request))
        self.guard = listener.QueueGuard()
        self.eligible = {}
        patcher = patch.object(listener, "log")
        self.log = patcher.start()
        self.addCleanup(patcher.stop)

    def admit(self, *rows):
        request = self.intake.request()
        self.intake.apply(request, poll(request, rows))

    def fail(self, binding, target, outcome="cloud_model_unavailable"):
        head = self.state.pending(binding)[0].id
        self.guard.settle(self.state, binding, target, head, outcome, self.eligible, now=0)
        return head

    def test_a_failing_private_message_retries_then_says_so_then_lets_the_next_one_go(self):
        self.admit(row(local=11, created=NOW, body="第一条"), row(local=12, created=NOW, body="第二条"))
        waits = []
        for _ in listener.RETRY_DELAYS:
            head = self.fail(OWNER, "private")
            waits.append(self.eligible[OWNER])
        self.assertEqual(waits, list(listener.RETRY_DELAYS))
        # Out of retries: it is not dropped silently; the next turns send the notice in its place.
        self.fail(OWNER, "private")
        self.assertIn(head, self.guard.notice_due)
        self.assertEqual(self.state.pending(OWNER)[0].id, head)
        # The notice gets its own retries, and if it cannot be sent either, the queue still moves on.
        for _ in range(len(listener.RETRY_DELAYS) + 1):
            self.fail(OWNER, "private", "send_preflight_blocked")
        remaining, = self.state.pending(OWNER)
        self.assertEqual(remaining.observation["text"], "第二条")
        (binding, reason, _), = self.state.dropped_since(0)
        self.assertEqual((binding, reason), (OWNER, "send_preflight_blocked"))
        self.assertNotIn(head, self.guard.notice_due)

    def test_a_group_message_is_given_up_quietly(self):
        self.admit(row(GROUP, local=11, sender="member", created=NOW, body="a"),
                   row(GROUP, local=12, sender="member", created=NOW, body="b"))
        for _ in range(len(listener.RETRY_DELAYS) + 1):
            self.fail(ROOM, "group", "send_preflight_blocked")
        self.assertEqual([event.observation["text"] for event in self.state.pending(ROOM)], ["b"])
        self.assertEqual(self.guard.notice_due, set())

    def test_waiting_on_a_pause_or_a_receipt_is_not_a_failure_and_success_forgets_the_count(self):
        self.admit(row(local=11, created=NOW, body="a"))
        for outcome in ("paused", "queue_paused", "send_uncertain", "ready"):
            self.fail(OWNER, "private", outcome)
        self.assertEqual(self.guard.retries.failures, {})
        head = self.fail(OWNER, "private")
        self.assertEqual(self.guard.retries.failures, {head: 1})
        self.assertTrue(self.state.prepare(head, "回复"))
        self.assertTrue(self.state.mark_attempted(head))
        self.assertTrue(self.state.mark_sent(head))
        self.guard.settle(self.state, OWNER, "private", head, "ready", self.eligible, now=0)
        self.assertEqual(self.guard.retries.failures, {})

    def test_messages_that_waited_too_long_are_skipped_not_answered_late(self):
        self.admit(row(local=11, created=NOW - 31 * 60, body="很早"), row(local=12, created=NOW - 11 * 60, body="稍早"),
                   row(GROUP, local=11, sender="member", created=NOW - 11 * 60, body="群里稍早"),
                   row(GROUP, local=12, sender="member", created=NOW - 60, body="群里刚才"))
        private = listener.drop_expired(self.state, OWNER, "private", self.state.pending(OWNER), now=NOW)
        group = listener.drop_expired(self.state, ROOM, "group", self.state.pending(ROOM), now=NOW)
        self.assertEqual([event.observation["text"] for event in private], ["稍早"])
        self.assertEqual([event.observation["text"] for event in group], ["群里刚才"])
        self.assertEqual(sorted(reason for _, reason, _ in self.state.dropped_since(0)), ["expired", "expired"])

    def test_an_unconfirmed_send_is_released_after_a_while_and_never_sent_again(self):
        self.admit(row(local=11, created=NOW, body="a"))
        event, = self.state.pending(OWNER)
        self.assertTrue(self.state.prepare(event.id, "回复"))
        self.assertTrue(self.state.mark_attempted(event.id))
        # A send in flight is never given up on: it may be on screen.
        self.assertFalse(self.state.give_up(event.id, "x"))
        self.assertTrue(self.state.mark_uncertain(event.id))
        listener.release_unconfirmed(self.state, OWNER, "private", self.guard.uncertain_since, now=0)
        self.assertEqual(len(self.state.uncertain(OWNER)), 1)
        listener.release_unconfirmed(self.state, OWNER, "private", self.guard.uncertain_since, now=listener.UNCONFIRMED_RELEASE)
        self.assertEqual((self.state.uncertain(OWNER), self.state.pending(OWNER)), ((), ()))
        self.assertEqual([reason for _, reason, _ in self.state.dropped_since(0)], ["unconfirmed"])
        count, at = listener.dropped_summary(self.state)
        self.assertEqual(count, 1)
        self.assertIsInstance(at, float)


class ConversationIsolationTest(unittest.TestCase):
    def test_an_error_in_the_private_chat_does_not_stop_the_group_reply(self):
        events = {name: SimpleNamespace(id=name * 32, status="pending", observation={"text": f"{name} 你好", "database": {}})
                  for name in ("p", "g")}
        bindings = {"private": "p", "group": "g"}
        state = Mock()
        state.pending.side_effect = lambda binding: (events[binding],) if events[binding].status != "sent" else ()
        state.uncertain.return_value = ()
        state.queue_paused.return_value = False
        state.history.return_value = []
        state.dropped_since.return_value = []
        state.skipped_since.return_value = []
        state.pending_count.return_value = 0

        def prepare(event_id, reply, *, presentation):
            event = next(item for item in events.values() if item.id == event_id)
            event.status, event.reply, event.observation["presentation"] = "prepared", reply, presentation
            return True

        def deliver(state, binding, target, event, *args, **kwargs):
            event.status = "sent"
            return "ready"

        def allowed(state, settings, runtime, event):
            if event is events["p"]:
                raise ValueError("private database check failed")
            return True

        state.prepare.side_effect = prepare
        runtime = Mock()
        runtime.__truediv__ = Mock(return_value=SimpleNamespace(exists=lambda: True))
        values = {
            "is_paused": False, "enrolled_groups": {"group": object()}, "enrolled_bindings": bindings, "transcript_scopes": (),
            "observe_database": {"private": "ready", "group": "ready"}, "event_group_policy": ("ready", None),
            "settings_for_group": {"account_name": "小桌宠"}, "group_speaker": {}, "read_reply_settings": {**listener.DEFAULT_REPLY},
            "read_cloud_route": "route", "cloud_reply_plan": {"reply": "群回复", "sticker": False},
            "reply_route_matches": True, "write_status": None, "log": None, "log_failure": None,
        }
        with ExitStack() as stack:
            actions = {key: stack.enter_context(patch.object(listener, key, return_value=value)) for key, value in values.items()}
            stack.enter_context(patch.object(listener, "database_event_allowed", side_effect=allowed))
            delivered = stack.enter_context(patch.object(listener, "deliver", side_effect=deliver))
            stack.enter_context(patch.object(listener.time, "sleep", side_effect=StopIteration))
            with self.assertRaises(StopIteration):
                listener.run(state, {"account_name": "小桌宠"}, Path("/unused"), runtime)
        self.assertEqual([call.args[2] for call in delivered.call_args_list], ["group"])
        self.assertEqual(events["g"].status, "sent")
        actions["log_failure"].assert_called_once()
        status = actions["write_status"].call_args
        self.assertEqual(status.kwargs["private"], "delivery_failed")
        retry = [call for call in actions["log"].call_args_list if call.kwargs.get("outcome") == "retry_scheduled"]
        self.assertEqual([(call.kwargs["target"], call.kwargs["reason"]) for call in retry], [("private", "delivery_failed")])


if __name__ == "__main__":
    unittest.main()
