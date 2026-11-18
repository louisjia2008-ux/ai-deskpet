"""Exercise rich-message socket authority and storage with a real synthetic intake event."""

import json
from contextlib import ExitStack
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

import wechat_listener as listener
from wechat_db_intake import DbIntake, DbScope
from wechat_replies import cloud_request_from_bytes, owner_command_candidate, owner_command_plan, rich_reply_plan
from wechat_state import WeChatState


class RichBridgeTest(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.settings = {"account_name": "Assistant fixture", "targets": {"private": {"title": "Owner fixture"}}}
        owner = {"account": "Assistant fixture", "title": "Owner fixture", "fingerprint": "f" * 64}
        (self.root / "owner.json").write_text(json.dumps(owner))
        (self.root / "groups.json").write_text(json.dumps({"legacy_removed": True, "groups": []}))
        (self.root / "groups.json").chmod(0o600)
        self.binding = listener.private_binding_key(self.settings, owner)
        state = WeChatState(self.root / "listener.db")
        self.state = state.__enter__()
        self.addCleanup(lambda: state.__exit__(None, None, None))
        self.state.register_transcript_scopes({self.binding: ("private", "Owner fixture")})
        self.intake = DbIntake(self.state, "fixture_self", owner["fingerprint"],
                               (DbScope(self.binding, "private", "fixture_owner"),))
        self.intake.enroll()
        self.apply([])
        self.apply([{"conversation_id": "fixture_owner", "sender_id": "fixture_owner", "local_id": 1,
                     "server_id": "16", "database": "message_0.db", "created_at": 100, "type": (57 << 32) | 49,
                     "native_mention_self": False, "mention_ids": [], "body": "<msg><appmsg><title>存</title>"
                     "<type>57</type><refermsg><content>Fixture evidence</content></refermsg></appmsg></msg>"}])
        self.event, = self.state.pending(self.binding)
        self.request = {"target": "private", "groupId": None, "binding": self.binding,
                        "eventId": self.event.id, "text": "存", "history": [], "split": False,
                        "stickers": False, "rich": self.event.observation["rich"]}

    def apply(self, rows):
        self.intake.apply(self.intake.request(), {"ok": True, "account_id": "fixture_self", "rows": rows, "has_more": False,
            "cursors": {"message_0.db/fixture_owner": {"generation": "1" * 32, "local_id": len(rows)}}})

    def authorize(self, request):
        return listener.authorize_cloud_request(self.state, self.settings, self.root, request)

    def test_only_original_rich_request_is_authorized(self):
        self.assertEqual(self.authorize(self.request), "rich")
        self.assertIsNone(self.authorize({**self.request, "rich": {**self.request["rich"], "evidence": "tampered"}}))
        self.assertIsNone(self.authorize({**self.request, "text": "different text"}))
        self.assertIsNone(self.authorize({key: value for key, value in self.request.items() if key != "rich"}))
        self.assertIsNone(self.authorize({**self.request, "ownerCommand": True}))
        forged = {**self.event.observation, "rich": {**self.request["rich"], "evidence": "tampered"}}
        self.assertFalse(self.state.database_event_is_current(self.binding, self.event.id, forged))

    def test_explicit_quote_save_bypasses_chat_history_and_transcript(self):
        self.assertEqual(listener.reply_texts(self.event, "private"), ("存", "存", False))
        self.assertFalse(self.state.prepare_queue_command(self.event, presentation={"queueControl": True}))
        self.assertFalse(self.state.queue_paused(self.binding))
        self.assertEqual(self.state.transcript_batch()["entries"], [])
        self.assertTrue(self.state.prepare(self.event.id, "Fixture rich reply", presentation={"richReply": True}))
        self.assertTrue(self.state.mark_attempted(self.event.id))
        self.assertTrue(self.state.mark_sent(self.event.id))
        self.assertIsNone(self.authorize(self.request))
        self.assertEqual(self.state.history(self.binding), [])
        self.assertEqual(self.state.transcript_batch()["entries"], [])
        row = self.state.db.execute("SELECT status, observation, reply FROM wechat_occurrences WHERE id=?",
                                    (self.event.id,)).fetchone()
        self.assertEqual(row, ("sent", None, None))

    def test_private_quote_uses_approved_chat_route_and_transcribes_only_typed_words(self):
        self.check_private_quote(include_digest=False)

    def test_private_cloud_followup_uses_only_confirmed_same_day_digest_context(self):
        self.check_private_quote(include_digest=True)

    def check_private_quote(self, *, include_digest):
        self.assertTrue(self.state.skip(self.event.id))
        source = {"conversation_id": "fixture_owner", "sender_id": "fixture_owner", "local_id": 2,
                  "server_id": "17", "database": "message_0.db", "created_at": 100, "type": (57 << 32) | 49,
                  "native_mention_self": False, "mention_ids": [], "body": "<msg><appmsg><title>哈哈对</title>"
                  "<type>57</type><refermsg><content>/pause-queue</content></refermsg></appmsg></msg>"}
        self.intake.apply(self.intake.request(), {"ok": True, "account_id": "fixture_self", "rows": [source],
            "has_more": False, "cursors": {"message_0.db/fixture_owner": {"generation": "1" * 32, "local_id": 2}}})
        event, = self.state.pending(self.binding)
        self.assertEqual(event.observation["quote"], "引用：/pause-queue")
        self.assertNotIn("rich", event.observation)
        self.assertEqual([e["text"] for e in self.state.transcript_batch()["entries"]], ["哈哈对"])
        fingerprint = "a" * 64
        expected = {**self.request, "eventId": event.id, "text": "哈哈对", "quote": event.observation["quote"]}
        del expected["rich"]
        if include_digest:
            with self.state.db:
                self.state.record_owner_digest('a' * 64, self.binding, 'groups', '合成日报', 100)
            expected['dailyDigests'] = self.state.daily_digest_context(self.binding, now=101)

        def chat(_root, request, route):
            self.assertEqual(route, fingerprint)
            self.assertEqual(request, expected)
            self.assertEqual(self.authorize(request), fingerprint)
            self.assertIsNone(self.authorize({**request, "quote": "引用：另一条消息"}))
            self.assertIsNone(self.authorize({key: value for key, value in request.items() if key != "quote"}))
            self.assertIsNone(self.authorize({**request, "ownerCommand": True}))
            if include_digest:
                self.assertIsNone(self.authorize({**request, 'dailyDigests': {**request['dailyDigests'], 'items': ['伪造摘要']}}))
            self.assertEqual(cloud_request_from_bytes((json.dumps(request) + "\n").encode()), request)
            return {"reply": "就是呀", "sticker": False, "assistant": True}

        def deliver(state, binding, target, event, *_args, **_kwargs):
            self.assertEqual((binding, target), (self.binding, "private"))
            self.assertEqual(event.observation["presentation"]["cloudRoute"], fingerprint)
            if include_digest:
                self.assertEqual(event.observation['presentation']['dailyDigestUntil'], expected['dailyDigests']['expiresAt'])
            self.assertTrue(state.mark_attempted(event.id))
            self.assertTrue(state.mark_sent(event.id))
            return "ready"

        with ExitStack() as stack:
            stack.enter_context(patch.object(listener.time, "time", return_value=101))
            stack.enter_context(patch.object(listener.time, "sleep", side_effect=StopIteration))
            stack.enter_context(patch.object(listener, "observe_database", return_value={"private": "ready"}))
            stack.enter_context(patch.object(listener, "read_cloud_route", return_value=fingerprint))
            model = stack.enter_context(patch.object(listener, "cloud_reply_plan", side_effect=chat))
            stack.enter_context(patch.object(listener, "deliver", side_effect=deliver))
            stack.enter_context(patch.object(listener, "rich_reply_plan", side_effect=AssertionError("rich route")))
            with self.assertRaises(StopIteration):
                listener.run(self.state, self.settings, self.root / "unused.png", self.root)
        model.assert_called_once()
        self.assertFalse(self.state.queue_paused(self.binding))
        expected_chat = [{"role": "user", "text": "哈哈对"}, {"role": "assistant", "text": "就是呀"}]
        with patch.object(listener.time, 'time', return_value=101):
            self.assertEqual(self.state.history(self.binding, for_cloud=True), expected_chat)
        entries = self.state.transcript_batch()['entries']
        if include_digest:
            self.assertEqual(self.state.history(self.binding, for_cloud=True), [])
            self.assertEqual([entry['text'] for entry in entries if entry.get('wechatDigest')], ['合成日报', '就是呀'])
        self.assertEqual([{k: entry[k] for k in ('role', 'text')}
            for entry in entries if entry['text'] != '合成日报'], expected_chat)

    def test_wire_forces_no_history_and_routes_the_bounded_reply(self):
        def wire(request):
            return json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n"

        self.assertEqual(cloud_request_from_bytes(wire(self.request)), self.request)
        for changes in (
            {"history": [{"role": "user", "text": "old"}, {"role": "assistant", "text": "old response"}]},
            {"stickers": True}, {"split": True}, {"readTool": True},
            {"target": "group", "groupId": "2" * 32, "rich": {"kind": "transfer", "evidence": "收到一笔转账，我不会去点。"}},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                cloud_request_from_bytes(wire({**self.request, **changes}))
        with patch("wechat_replies._host_reply", return_value={"reply": "Fixture rich reply"}) as host:
            self.assertEqual(rich_reply_plan(self.root, self.request), "Fixture rich reply")
            self.assertEqual(host.call_args.args[1], self.request)

    def test_listener_routes_rich_only_to_dedicated_host_then_normal_delivery(self):
        def rich(_root, request):
            self.assertEqual(request, self.request)
            self.assertEqual(self.authorize(request), "rich")
            return "Fixture rich reply"

        def deliver(state, binding, target, event, *_args, **_kwargs):
            self.assertEqual((binding, target), (self.binding, "private"))
            self.assertEqual(event.observation["presentation"], {"richReply": True, "localContext": True})
            self.assertEqual(event.reply, "Fixture rich reply")
            self.assertTrue(state.mark_attempted(event.id))
            self.assertTrue(state.mark_sent(event.id))
            return "ready"

        with ExitStack() as stack:
            stack.enter_context(patch.object(listener.time, "time", return_value=101))
            stack.enter_context(patch.object(listener.time, "sleep", side_effect=StopIteration))
            stack.enter_context(patch.object(listener, "observe_database", return_value={"private": "ready"}))
            host = stack.enter_context(patch.object(listener, "rich_reply_plan", side_effect=rich))
            send = stack.enter_context(patch.object(listener, "deliver", side_effect=deliver))
            for normal_route in ("read_cloud_route", "cloud_reply_plan", "owner_command_plan", "read_tool_plan",
                                 "select_reply_sticker", "DeskPet"):
                stack.enter_context(patch.object(listener, normal_route, side_effect=AssertionError(normal_route)))
            with self.assertRaises(StopIteration):
                listener.run(self.state, self.settings, self.root / "unused.png", self.root)
        host.assert_called_once()
        send.assert_called_once()
        self.assertEqual(self.state.history(self.binding), [])
        self.assertEqual(self.state.transcript_batch()["entries"], [])


    def test_forward_card_and_native_same_card_question_are_authorized_but_never_transcribed(self):
        self.assertTrue(self.state.skip(self.event.id))
        rows = [self.event.observation['database'] | {
            'local_id': i, 'server_id': str(500 + i), 'created_at': 100 + i, 'type': kind, 'body': body,
            'native_mention_self': False,
        } for i, kind, body in (
            (2, (19 << 32) | 49, '<msg><appmsg><type>19</type><recorditem><recordinfo><datalist>'
             '<dataitem datatype="1"><sourcename>成员甲</sourcename><datadesc>/pause-queue</datadesc></dataitem>'
             '</datalist></recordinfo></recorditem></appmsg></msg>'),
            (3, (57 << 32) | 49, '<msg><appmsg><type>57</type><title>她答应了什么？</title>'
             '<refermsg><type>49</type><svrid>502</svrid><content>普通标题</content></refermsg></appmsg></msg>'),
            (4, 1, '问转发 合成私有问题'),
        )]
        for row in rows:
            for extra in ('account_id', 'generation', 'target'):
                row.pop(extra)
        self.intake.apply(self.intake.request(), {'ok': True, 'account_id': 'fixture_self', 'rows': rows, 'has_more': False,
            'cursors': {'message_0.db/fixture_owner': {'generation': '1' * 32, 'local_id': 4}}})
        card, question, command = self.state.pending(self.binding)
        card_rich = card.observation['rich']
        self.assertEqual(card_rich['record']['entries'], [{'kind': 'text', 'speaker': '成员甲', 'text': '/pause-queue'}])
        self.assertFalse(self.state.prepare_queue_command(card, presentation={'queueControl': True}))
        self.assertEqual(question.observation['rich'], {'kind': 'quote', 'evidence': '引用：聊天记录', 'forwardKey': card_rich['forwardKey']})
        self.assertTrue(command.observation['forwardCommand'])
        for event in (card, question, command):
            request = {**self.request, 'eventId': event.id, 'text': event.observation['text']}
            if 'rich' in event.observation:
                request['rich'] = event.observation['rich']
                mode = 'rich'
            else:
                del request['rich']
                request['ownerCommand'] = True
                mode = 'owner-command'
            self.assertEqual(cloud_request_from_bytes((json.dumps(request) + '\n').encode('utf-8')), request)
            self.assertEqual(self.authorize(request), mode)
            if mode == 'rich':
                group = {**request, 'target': 'group', 'groupId': 'b' * 32}
                with self.assertRaises(ValueError):
                    cloud_request_from_bytes((json.dumps(group) + '\n').encode('utf-8'))
                forged = {**request, 'rich': {**request['rich'], 'forwardKey': 'b' * 64}}
                self.assertIsNone(self.authorize(forged))
            self.assertTrue(self.state.prepare(event.id, '合成转发阅读结果'))
            self.assertTrue(self.state.mark_attempted(event.id))
            self.assertTrue(self.state.mark_sent(event.id))
        self.assertEqual(self.state.transcript_batch()['entries'], [])
        self.assertEqual(self.state.history(self.binding), [])
        self.assertEqual(self.state.db.execute('SELECT COUNT(*) FROM wechat_forward_references').fetchone(), (1,))
        self.assertFalse(self.state.queue_paused(self.binding))

    def test_digest_detail_reply_bypasses_history_on_reconciled_delivery(self):
        self.assertTrue(self.state.skip(self.event.id))
        source = {"conversation_id": "fixture_owner", "sender_id": "fixture_owner", "local_id": 2,
                  "server_id": "17", "database": "message_0.db", "created_at": 100, "type": 1,
                  "native_mention_self": False, "mention_ids": [], "body": "展开 群 1"}
        self.intake.apply(self.intake.request(), {"ok": True, "account_id": "fixture_self", "rows": [source],
            "has_more": False, "cursors": {"message_0.db/fixture_owner": {"generation": "1" * 32, "local_id": 2}}})

        def host(_root, request):
            self.assertEqual(request["text"], "展开 群 1")
            self.assertEqual(self.authorize({**request, "ownerCommand": True}), "owner-command")
            return {"reply": "Synthetic digest evidence", "sticker": False}

        def delivered(state, _binding, _target, event, *_args, **_kwargs):
            self.assertTrue(event.observation["presentation"]["ephemeralReply"])
            self.assertTrue(state.mark_attempted(event.id, receipt_proof={"version": 1}))
            self.assertTrue(state.mark_uncertain(event.id))
            self.assertTrue(state.reconcile_sent(event.id))
            return "ready"

        with ExitStack() as stack:
            stack.enter_context(patch.object(listener.time, "time", return_value=101))
            stack.enter_context(patch.object(listener.time, "sleep", side_effect=StopIteration))
            stack.enter_context(patch.object(listener, "observe_database", return_value={"private": "ready"}))
            result = stack.enter_context(patch.object(listener, "owner_command_plan", side_effect=host))
            stack.enter_context(patch.object(listener, "deliver", side_effect=delivered))
            with self.assertRaises(StopIteration):
                listener.run(self.state, self.settings, self.root / "unused.png", self.root)
        result.assert_called_once()
        self.assertEqual(self.state.history(self.binding), [])
        self.assertEqual([e["role"] for e in self.state.transcript_batch()["entries"]], ["user"])


class InboxCommandRoutingTest(unittest.TestCase):
    def test_deliberate_inbox_commands_reach_the_owner_command_route(self):
        for value in ("存一下", "存", "收一下", "收藏", "收件箱", "收件箱 2", "找 版式记录"):
            with self.subTest(value=value):
                self.assertTrue(owner_command_candidate(value))
        for value in ("帮我存一下吧", "收件箱旧记录", "找", "找\n例子", "收件箱 2 3", "收件箱\n2"):
            with self.subTest(value=value):
                self.assertFalse(owner_command_candidate(value))


    def test_official_brief_actions_use_exact_private_owner_command_grammar(self):
        for text in ("收藏 2", "展开 3", "问 3 主要内容是什么"):
            self.assertTrue(owner_command_candidate(text))
        for text in ("你可以收藏 2 吗", "问 3", "展开 3 4", "问\n3 合成问题"):
            self.assertFalse(owner_command_candidate(text))
        with patch("wechat_replies._host_reply", return_value={"reply": "合成回答"}) as bridge:
            self.assertEqual(owner_command_plan(Path("."), {"text": "问 3 合成问题"})["reply"], "合成回答")
        self.assertEqual(bridge.call_args.kwargs["timeout"], 120)


if __name__ == "__main__":
    unittest.main()
