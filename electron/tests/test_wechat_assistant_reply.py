import json
import sys
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import vm_console as ui
import wechat_listener as listener
import wechat_replies as replies
from wechat_messages import VisibleMessage

FINGERPRINT = "a" * 64
KNOWLEDGE_REPLY_TOKEN = "7" * 64
REQUEST = {"target": "private", "groupId": None, "binding": "b" * 64, "eventId": "c" * 64, "text": "明早八点提醒我查天气",
           "history": [], "split": True, "stickers": True}
ARTICLE = {"url": "https://mp.weixin.qq.com/s/0123456789ab", "title": "画板实验", "account": "测试账号"}


class AssistantReplyTest(unittest.TestCase):
    def plan(self, value, request=REQUEST):
        with patch.object(replies, "_host_reply", return_value=value) as host:
            return replies.cloud_reply_plan(Path("/unused"), request, FINGERPRINT), host

    def test_private_assistant_reply_may_be_long_and_carry_a_link(self):
        reply = "好的，每天早上八点我会查一下天气发给你。来源：https://weather.example/today " + "晴" * 300
        plan, host = self.plan({"reply": reply, "sticker": False, "routeFingerprint": FINGERPRINT, "format": "assistant"})
        self.assertEqual(plan, {"reply": reply, "sticker": False, "assistant": True})
        self.assertEqual(host.call_args.kwargs["timeout"], replies.PRIVATE_REPLY_TIMEOUT)

    def test_assistant_reply_keeps_history_and_printable_limits(self):
        for reply in ("晴" * 501, "第一行\n第二行", " "):
            with self.subTest(reply=reply[:8]), self.assertRaises(ValueError):
                self.plan({"reply": reply, "sticker": False, "routeFingerprint": FINGERPRINT, "format": "assistant"})

    def test_only_private_assistant_replies_accept_an_opaque_knowledge_token(self):
        response = {"reply": "Synthetic answer", "sticker": False, "routeFingerprint": FINGERPRINT,
                    "format": "assistant", "knowledgeReplyToken": KNOWLEDGE_REPLY_TOKEN}
        plan, _ = self.plan(response)
        self.assertEqual(plan["knowledgeReplyToken"], KNOWLEDGE_REPLY_TOKEN)
        for invalid, request in [
            ({**response, "knowledgeReplyToken": "invalid"}, REQUEST),
            ({key: value for key, value in response.items() if key != "format"}, REQUEST),
            (response, {**REQUEST, "target": "group", "groupId": "d" * 32}),
        ]:
            with self.assertRaises(ValueError):
                self.plan(invalid, request)

    def test_knowledge_reply_check_requires_exact_boolean_and_fails_closed_on_unavailable_socket(self):
        runtime = Path("/unused")
        binding = REQUEST["binding"]
        with patch.object(replies, "_host_reply", return_value={"valid": True}) as host:
            self.assertTrue(replies.knowledge_reply_current(runtime, binding, KNOWLEDGE_REPLY_TOKEN))
            host.assert_called_once_with(runtime, {"binding": binding, "validateKnowledgeReply": KNOWLEDGE_REPLY_TOKEN},
                                         timeout=2, response_limit=128)
        for result in ({"valid": False}, {"valid": 1}, {"error": "cloud_model_unavailable"}):
            with patch.object(replies, "_host_reply", return_value=result):
                self.assertFalse(replies.knowledge_reply_current(runtime, binding, KNOWLEDGE_REPLY_TOKEN))
        with patch.object(replies, "_host_reply", side_effect=TimeoutError):
            self.assertFalse(replies.knowledge_reply_current(runtime, binding, KNOWLEDGE_REPLY_TOKEN))

    def test_groups_accept_assistant_replies_with_the_group_timeout(self):
        group = {**REQUEST, "target": "group", "groupId": "d" * 32}
        plan, host = self.plan({"reply": "查到了：明天晴，18 度。" * 3, "sticker": False, "routeFingerprint": FINGERPRINT,
                                "format": "assistant"}, group)
        self.assertEqual(plan, {"reply": "查到了：明天晴，18 度。" * 3, "sticker": False, "assistant": True})
        self.assertEqual(host.call_args.kwargs["timeout"], replies.GROUP_REPLY_TIMEOUT)
        plan, host = self.plan({"reply": "好的", "sticker": False, "routeFingerprint": FINGERPRINT}, group)
        self.assertEqual(plan, {"reply": "好的", "sticker": False})
        with self.assertRaises(ValueError):
            self.plan({"reply": "好" * 81, "sticker": False, "routeFingerprint": FINGERPRINT}, group)

    def test_one_shot_private_reply_keeps_its_short_limit(self):
        with self.assertRaises(ValueError):
            self.plan({"reply": "好" * 81, "sticker": False, "routeFingerprint": FINGERPRINT})

    def test_owner_only_history_and_local_reply_observation_shapes(self):
        def parse(value):
            return replies.cloud_request_from_bytes((json.dumps(value, ensure_ascii=False) + "\n").encode())

        history = [{"role": "assistant" if index % 2 else "user", "text": f"合成记录 {index}"} for index in range(16)]
        packet = {**REQUEST, "history": history, "contextOnly": True, "localModel": "fixture",
                  "localResult": {"reply": "明早见。", "mood": "happy"}}
        self.assertEqual(parse(packet), packet)
        for changes in ({"target": "group", "groupId": "d" * 32},
                        {"history": [{**item, "text": "字" * 400} for item in history]},
                        {"localResult": {"reply": "明早见。", "mood": "unknown"}},
                        {"localResult": {"reply": "明早见。", "mood": []}},
                        {"localResult": {"reply": "https://example.test", "mood": "happy"}}):
            with self.subTest(changes=tuple(changes)), self.assertRaises(ValueError):
                parse({**packet, **changes})
        with self.assertRaises(ValueError):
            parse({key: value for key, value in packet.items() if key not in ("contextOnly", "localModel")})
        with patch.object(replies, "_host_reply", return_value={"accepted": True}) as host:
            replies.report_local_reply(Path("/unused"), {**REQUEST, "history": history}, "fixture",
                                       {"reply": "明早见。", "mood": "happy"})
            host.assert_called_once_with(Path("/unused"), packet, timeout=4, response_limit=512, wait_hook=None)

    def test_only_owner_reply_carries_private_context_retention_flag(self):
        response = {"reply": "好的", "sticker": False, "routeFingerprint": FINGERPRINT, "privateContext": True}
        self.assertTrue(self.plan(response)[0]["privateContext"])
        with self.assertRaises(ValueError):
            self.plan(response, {**REQUEST, "target": "group", "groupId": "d" * 32})
        with self.assertRaises(ValueError):
            self.plan({**response, "privateContext": 1})

    def test_local_owner_identity_keeps_both_exact_frames_up_to_the_ipc_bound(self):
        local = {"name": "Fixture", "persona": None, "memories": [], "identity": ["设" * 9_900, "정" * 11_000]}
        with patch.object(replies, "_host_reply", return_value=local) as host:
            self.assertEqual(replies.local_reply_context(Path("/unused"), REQUEST, "fixture"), local)
            self.assertEqual(host.call_args.kwargs["response_limit"], replies.LOCAL_CONTEXT_RESPONSE_LIMIT)
        with patch.object(replies, "_host_reply", return_value={**local, "identity": ["😀" * 6_001]}):
            self.assertIsNone(replies.local_reply_context(Path("/unused"), REQUEST, "fixture"))

    def test_article_request_is_a_separate_private_wire_shape(self):
        request = {**REQUEST, "text": ARTICLE["url"], "article": ARTICLE}

        def parse(value):
            return replies.cloud_request_from_bytes((json.dumps(value) + "\n").encode())

        self.assertEqual(parse(request), request)
        for changes in ({"target": "group", "groupId": "a" * 32},
                        {"ownerCommand": True}, {"text": "/queue"},
                        {"article": {**ARTICLE, "url": ARTICLE["url"] + "?srcid=tracker"}},
                        {"history": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hi"}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse({**request, **changes})

    def test_article_question_has_time_to_read_without_slowing_simple_commands(self):
        with patch.object(replies, "_host_reply", return_value={"reply": "已处理"}) as host:
            replies.owner_command_plan(Path("/unused"), {**REQUEST, "text": "收藏"})
            self.assertEqual(host.call_args.kwargs["timeout"], 8)
            replies.owner_command_plan(Path("/unused"), {**REQUEST, "text": "问文章 第二条是什么意思"})
            self.assertEqual(host.call_args.kwargs["timeout"], 120)
        for text in ("收藏", "收藏这篇", "收藏列表 2", "打开收藏 1234abcd", "问文章 第二条", "继续聊", "先放着"):
            self.assertTrue(replies.owner_command_candidate(text), text)
        for text in ("要是有收藏就好了", "查一下微信的收藏列表", "问文章", "继续聊别的"):
            self.assertFalse(replies.owner_command_candidate(text), text)


class FakeState:
    def __init__(self):
        self.calls = []

    def mark_attempted(self, event_id, *, receipt_proof=None):
        self.calls.append("attempted")
        return True

    def mark_sent(self, event_id):
        self.calls.append("sent")
        return True

    def mark_uncertain(self, event_id):
        self.calls.append("uncertain")

    def skip(self, event_id):
        self.calls.append("skip")


class GroupDeliveryTest(unittest.TestCase):
    sender = "测试群成员"
    incoming = VisibleMessage(direction="incoming", sender=sender, text="@小桌宠 今天几号", box=(40, 300, 160, 35),
                              mentions_account=True, quotes_account=False)

    def event(self):
        observation = {"direction": "incoming", "sender": self.sender, "text": self.incoming.text,
                       "box": list(self.incoming.box), "mentions_account": True, "quotes_account": False, "database": {"server_id": "1"},
                       "presentation": {"split": False, "sticker": False}}
        return SimpleNamespace(id="e" * 64, binding="f" * 64, observation=observation, reply="今天是 11 月 14 日。",
                               status="prepared")

    def deliver(self, send, quote=(None, None)):
        state = FakeState()
        policy = SimpleNamespace(mode="mentions", sender=None)
        with (
            patch.object(listener, "is_paused", return_value=False),
            patch.object(listener, "group_policy_lock", return_value=nullcontext()),
            patch.object(listener.ui, "vm_operation", side_effect=nullcontext),
            patch.object(listener, "event_group_policy", return_value=("ready", policy)),
            patch.object(listener, "database_event_allowed", return_value=True),
            patch.object(listener, "reply_route_matches", return_value=True),
            patch.object(listener, "read_reply_settings", return_value=dict(listener.DEFAULT_REPLY)),
            patch.object(listener, "verify_group"),
            patch.object(listener.ui, "open_target"),
            patch.object(listener.ui, "conversation_messages", return_value=(self.incoming,)),
            patch.object(listener, "database_group_quote", return_value=quote),
            patch.object(listener.ui, "run_test", side_effect=send),
        ):
            outcome = listener.deliver(state, "f" * 64, "group", self.event(), {"account_name": "小桌宠"},
                                       Path("/unused/screen.png"), Path("/unused"))
        return outcome, state.calls

    def test_unlocated_database_message_is_answered_addressed_instead_of_dropped(self):
        sent = []

        def send(action, target, text, settings, path, *, quote=None, before_send, receipt, **evidence):
            self.assertIsNone(quote)
            self.assertTrue(callable(evidence["remember_visual"]))
            self.assertNotIn("database_receipt", evidence)
            self.assertTrue(before_send())
            sent.append(text)
            receipt()

        self.assertEqual(self.deliver(send), ("ready", ["attempted", "sent"]))
        self.assertEqual(sent, [f"@{self.sender} 今天是 11 月 14 日。"])

    def test_quote_that_fails_before_sending_falls_back_once_to_an_addressed_reply(self):
        sent = []

        def send(action, target, text, settings, path, *, quote=None, before_send, receipt, **evidence):
            if quote is not None:
                raise ui.TestError("无法在目标气泡的菜单里确认原生引用按钮。")
            self.assertTrue(before_send())
            sent.append(text)
            receipt()

        resolve = lambda messages: self.incoming  # noqa: E731
        self.assertEqual(self.deliver(send, (self.incoming, resolve)), ("ready", ["attempted", "sent"]))
        self.assertEqual(sent, [f"@{self.sender} 今天是 11 月 14 日。"])

    def test_quote_failure_after_the_send_click_is_never_resent(self):
        attempts = []

        def send(action, target, text, settings, path, *, quote=None, before_send, receipt, **evidence):
            attempts.append(quote)
            self.assertTrue(before_send())
            raise ui.TestError("发送后无法确认。")

        resolve = lambda messages: self.incoming  # noqa: E731
        outcome, calls = self.deliver(send, (self.incoming, resolve))
        self.assertEqual(outcome, "send_uncertain")
        self.assertEqual(len(attempts), 1)
        self.assertEqual(calls, ["attempted", "uncertain"])

    def test_address_is_plain_and_bounded(self):
        self.assertEqual(listener.group_address("  小  明 "), "@小 明 ")
        self.assertEqual(listener.group_address(None), "")
        self.assertEqual(listener.group_address("x" * 41), "")
        self.assertEqual(listener.group_address("a‮b"), "")


class PrivateVoiceCommandTest(unittest.TestCase):
    def test_only_a_database_authorized_private_voice_question_selects_voice(self):
        cases = (
            ("private", "  /voice 你好吗？ ", True, "你好吗？ "),
            ("private", "/voice你好吗？", True, "你好吗？"),
            ("private", "/voice 你好吗？", False, None),
            ("private", "/voice   ", True, None),
            ("private", "请用语音回答", True, None),
            ("group", "/voice 你好吗？", True, None),
        )
        for target, text, authorized, spoken in cases:
            expected_voice = spoken is not None
            with self.subTest(target=target, text=text, authorized=authorized):
                event, actions = self.poll(target, text, authorized)
                if not authorized:
                    actions["cloud_reply_plan"].assert_not_called()
                    actions["deliver"].assert_not_called()
                    actions["deliver_private_voice"].assert_not_called()
                    continue
                # The model reads the request without its command, told that the reply will be spoken.
                expected_text = spoken + listener.VOICE_REPLY_NOTE if expected_voice else text
                self.assertEqual(actions["cloud_reply_plan"].call_args.args[1]["text"], expected_text)
                presentation = event.observation["presentation"]
                self.assertEqual(presentation.get("voice", False), expected_voice)
                self.assertEqual((presentation["split"], presentation["sticker"]), (not expected_voice,) * 2)
                if expected_voice:
                    actions["owner_command_plan"].assert_not_called()
                    actions["select_reply_sticker"].assert_not_called()
                    actions["deliver_private_voice"].assert_called_once()
                    actions["deliver"].assert_not_called()
                else:
                    actions["deliver_private_voice"].assert_not_called()
                    actions["deliver"].assert_called_once()

    def test_an_owner_voice_message_that_was_heard_is_answered_by_voice(self):
        event, actions = self.poll("private", "今天好累", True, voice={"heard": True})
        self.assertEqual(actions["cloud_reply_plan"].call_args.args[1]["text"], "今天好累" + listener.VOICE_REPLY_NOTE)
        self.assertIs(event.observation["presentation"]["voice"], True)
        actions["deliver_private_voice"].assert_called_once()
        actions["deliver"].assert_not_called()

    def test_an_unheard_voice_message_gets_a_text_request_to_repeat_without_a_model_call(self):
        event, actions = self.poll("private", "[没听清的语音]", True, voice={"heard": False})
        actions["cloud_reply_plan"].assert_not_called()
        self.assertEqual(event.reply, listener.VOICE_UNHEARD_REPLY)
        self.assertFalse(event.observation["presentation"].get("voice", False))
        actions["deliver_private_voice"].assert_not_called()
        actions["deliver"].assert_called_once()

    def test_a_voice_that_cannot_be_made_or_recorded_is_sent_as_text_instead_of_blocking_the_queue(self):
        _, actions = self.poll("private", "/voice 晚安", True, voice_outcome="voice_unavailable")
        actions["deliver_private_voice"].assert_called_once()
        actions["deliver"].assert_called_once()

    def test_private_article_uses_its_own_host_service_and_one_text_message(self):
        for fingerprint in (FINGERPRINT, None):
            with self.subTest(local=fingerprint is None):
                event, actions = self.poll("private", ARTICLE["url"], True, article=ARTICLE, fingerprint=fingerprint)
                wire = actions["article_reply_plan"].call_args.args[1]
                self.assertEqual(wire["article"], ARTICLE)
                self.assertEqual(wire["history"], [])
                self.assertEqual(wire["text"], ARTICLE["url"])
                actions["cloud_reply_plan"].assert_not_called()
                actions["owner_command_plan"].assert_not_called()
                actions["deliver_private_voice"].assert_not_called()
                actions["deliver"].assert_called_once()
                self.assertEqual(event.reply, "文章要点。要收藏还是先放着？")
                self.assertFalse(event.observation["presentation"]["split"])
                self.assertFalse(event.observation["presentation"]["sticker"])

    def test_knowledge_reply_carries_policy_guard_and_skips_listener_history(self):
        event, actions = self.poll("private", "Synthetic note question", True, cloud_plan={
            "reply": "Synthetic note answer", "sticker": False, "assistant": True, "knowledgeReplyToken": KNOWLEDGE_REPLY_TOKEN,
        })
        presentation = event.observation["presentation"]
        self.assertEqual(presentation["knowledgeReplyToken"], KNOWLEDGE_REPLY_TOKEN)
        self.assertTrue(presentation["ephemeralReply"])
        actions["deliver"].assert_called_once()

    def poll(self, target, text, authorized, *, voice=None, voice_outcome="ready", article=None, fingerprint=FINGERPRINT, cloud_plan=None):
        entry = target
        event = SimpleNamespace(id="event", status="pending", observation={"text": text, "database": {},
                                                                           **({"voice": voice} if voice else {}),
                                                                           **({"article": article} if article else {})})
        settings = {"account_name": "小桌宠"}
        groups = {"group": object()} if target == "group" else {}
        bindings = {name: name for name in ("private", *groups)}
        state = Mock()
        state.pending.side_effect = lambda binding: (event,) if binding == entry else ()
        state.pending_count.return_value = 1
        state.uncertain.return_value = ()
        state.queue_paused.return_value = False
        state.history.return_value = []
        state.daily_digest_context.return_value = None
        state.dropped_since.return_value = []
        state.skipped_since.return_value = []

        def prepare(_, reply, *, presentation):
            event.status = "prepared"
            event.reply = reply
            event.observation["presentation"] = presentation
            return True

        state.prepare.side_effect = prepare
        runtime = Mock()
        runtime.__truediv__ = Mock(return_value=SimpleNamespace(exists=lambda: True))
        voice = ModuleType("wechat_voice_send")
        voice.deliver_private_voice = Mock(return_value=voice_outcome)
        values = {
            "is_paused": False, "enrolled_groups": groups, "enrolled_bindings": bindings, "transcript_scopes": (),
            "observe_database": dict.fromkeys(bindings, "ready"), "event_group_policy": ("ready", None),
            "settings_for_group": settings, "group_speaker": {"speaker": "owner"} if groups else {},
            "database_event_allowed": authorized, "read_reply_settings": {**listener.DEFAULT_REPLY, "split": True, "stickers": True},
            "read_cloud_route": fingerprint, "cloud_reply_plan": cloud_plan or {"reply": "测试回复", "sticker": True},
            "article_reply_plan": {"reply": "文章要点。要收藏还是先放着？", "sticker": False},
            "owner_command_plan": None, "reply_route_matches": True, "select_reply_sticker": "b" * 64,
            "deliver": "ready", "write_status": None, "log": None,
        }
        with ExitStack() as stack:
            actions = {key: stack.enter_context(patch.object(listener, key, return_value=value)) for key, value in values.items()}
            stack.enter_context(patch.object(listener.FriendReplyLane, 'step', return_value=None))
            stack.enter_context(patch.dict(sys.modules, {"wechat_voice_send": voice}))
            stack.enter_context(patch.object(listener.time, "sleep", side_effect=StopIteration))
            with self.assertRaises(StopIteration):
                listener.run(state, settings, Path("/unused"), runtime)
        return event, {**actions, "deliver_private_voice": voice.deliver_private_voice}


class PrivateKnowledgeDeliveryTest(unittest.TestCase):
    def test_revocation_between_opening_conversation_and_click_discards_prepared_reply(self):
        runtime = Path("/unused")
        binding = REQUEST["binding"]
        state = Mock()
        event = SimpleNamespace(id=REQUEST["eventId"], binding=binding, status="prepared", reply="Synthetic note answer",
                                observation={"text": "Synthetic note question", "database": {}, "presentation": {
                                    "cloudRoute": FINGERPRINT, "knowledgeReplyToken": KNOWLEDGE_REPLY_TOKEN,
                                }})

        def click(*_args, before_send, **_kwargs):
            before_send()
            self.fail("Revoked note reply reached the click boundary")

        with (
            patch.object(listener, "is_paused", return_value=False),
            patch.object(listener, "knowledge_reply_current", side_effect=[True, False]) as current,
            patch.object(listener, "read_cloud_route", return_value=FINGERPRINT),
            patch.object(listener, "owner_record", return_value={}),
            patch.object(listener, "private_binding_key", return_value=binding),
            patch.object(listener, "database_event_allowed", return_value=True),
            patch.object(listener, "database_message_bubble", return_value=None),
            patch.object(listener, "read_reply_settings", return_value=listener.DEFAULT_REPLY),
            patch.object(listener.ui, "vm_operation", side_effect=nullcontext),
            patch.object(listener.ui, "open_target"),
            patch.object(listener, "verify_owner"),
            patch.object(listener.ui, "run_test", side_effect=click),
        ):
            self.assertEqual(listener.deliver(state, binding, "private", event, {}, runtime, runtime), "model_route_changed")
        self.assertEqual(current.call_count, 2)
        state.mark_attempted.assert_not_called()
        state.reset_prepared.assert_called_once_with(event.id)


if __name__ == "__main__":
    unittest.main()


class GroupSpeakerTest(unittest.TestCase):
    def request(self, **changes):
        value = {**REQUEST, "target": "group", "groupId": "d" * 32, **changes}
        return (json.dumps(value, ensure_ascii=False) + "\n").encode()

    def test_group_requests_may_name_the_speaker_and_nothing_else_may(self):
        parsed = replies.cloud_request_from_bytes(self.request(speaker="owner", ownerName="阿明"))
        self.assertEqual((parsed["speaker"], parsed["ownerName"]), ("owner", "阿明"))
        for changes in ({"speaker": "owner"}, {"speaker": "admin", "ownerName": "阿明"}, {"speaker": "member", "ownerName": ""},
                        {"speaker": "member", "ownerName": "a‮b"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                replies.cloud_request_from_bytes(self.request(**changes))
        with self.assertRaises(ValueError):
            replies.cloud_request_from_bytes((json.dumps({**REQUEST, "speaker": "owner", "ownerName": "阿明"}) + "\n").encode())

    def test_owner_is_recognised_by_the_database_sender_id(self):
        pin = SimpleNamespace(target="private", conversation_id="wxid_owner")
        settings = {"targets": {"private": {"title": " 阿明 "}}}
        with patch.object(listener.DbIntake, "pins", return_value={"p" * 64: pin}):
            speak = lambda sender: listener.group_speaker(None, settings, {"private": "p" * 64}, "group",  # noqa: E731
                                                          {"database": {"sender_id": sender}})
            self.assertEqual(speak("wxid_owner"), {"speaker": "owner", "ownerName": "阿明"})
            self.assertEqual(speak("wxid_other"), {"speaker": "member", "ownerName": "阿明"})
            self.assertEqual(listener.group_speaker(None, settings, {"private": "p" * 64}, "private", {}), {})


class GroupFloodingTest(unittest.TestCase):
    def test_a_member_is_answered_three_times_a_minute_and_others_are_unaffected(self):
        recent, observation = {}, {"database": {"sender_id": "wxid_a"}}
        results = [listener.group_request_flooding(recent, "g", observation, now) for now in (0, 10, 20, 30)]
        self.assertEqual(results, [False, False, False, True])
        self.assertFalse(listener.group_request_flooding(recent, "g", {"database": {"sender_id": "wxid_b"}}, 31))
        self.assertFalse(listener.group_request_flooding(recent, "other", observation, 31))
        self.assertFalse(listener.group_request_flooding(recent, "g", observation, 61))
