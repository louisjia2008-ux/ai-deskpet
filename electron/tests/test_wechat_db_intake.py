"""Validate database intake using synthetic guest responses and a temporary ledger."""

from dataclasses import replace
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

from wechat_db_intake import DbIntake, DbScope
from wechat_group_policy import GroupPolicy
from wechat_state import StateConflict, WeChatState


OWNER = "a" * 64
ROOM = "b" * 64
OTHER_ROOM = "c" * 64
FINGERPRINT = "d" * 64
ACCOUNT = "bot_fixture"
CONTACT = "owner_fixture"
GROUP = "1234@chatroom"
OTHER_GROUP = "5678@chatroom"
SHARD = "message_0.db"
NEXT_SHARD = "message_2.db"
LAST_SHARD = "message_10.db"
GENERATION = "1" * 32
NEXT_GENERATION = "2" * 32
LAST_GENERATION = "3" * 32
MENTIONS = GroupPolicy("mentions", None, "1")
ALL = GroupPolicy("all", None, "2")
ARTICLE_TYPE = 21474836529
ARTICLE_URL = "https://mp.weixin.qq.com/s?__biz=fixture%3D%3D&mid=123&idx=1&sn=signed&chksm=checksum"
TRACKED_ARTICLE_URL = ARTICLE_URL.replace("https://", "http://") + "&srcid=owner&sharer_shareinfo=secret#rd"


def appmsg(url=TRACKED_ARTICLE_URL, *, subtype=5):
    return (f'<msg><appmsg><title>/queue &amp; 实验</title><type>{subtype}</type><url>{escape(url)}</url>'
            '<sourcedisplayname> 测试\n公众号 </sourcedisplayname></appmsg></msg>')


def row(conversation=CONTACT, *, sender=CONTACT, local=11, server="0", created=10, body="/ping",
        mentions=(), database=SHARD, message_type=1, **fields):
    return {
        "conversation_id": conversation, "sender_id": sender, "local_id": local, "server_id": server,
        "database": database, "created_at": created, "type": message_type, "body": body,
        "native_mention_self": ACCOUNT in mentions, "mention_ids": list(mentions), **fields,
    }


def poll(request, rows=(), *, baseline_at=10,
         shards=((SHARD, GENERATION),), initial=None, has_more=False):
    if request.get("baseline"):
        positions = {f"{shard}/{chat}": {"generation": generation,
                                       "local_id": (initial or {}).get(chat, baseline_at)}
                     for shard, generation in shards for chat in (request["owner_id"], *request["group_ids"])}
    else:
        positions = {key: value.copy() for key, value in request["cursors"].items()}
    for message in rows:
        key = f'{message["database"]}/{message["conversation_id"]}'
        positions[key]["local_id"] = max(positions[key]["local_id"], message["local_id"])
    return {"ok": True, "account_id": ACCOUNT, "rows": list(rows), "cursors": positions, "has_more": has_more}


class DbIntakeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name) / "ledger.db"
        self.state = WeChatState(self.path)
        self.addCleanup(self.state.db.close)
        self.owner = DbScope(OWNER, "private", CONTACT, display_name="测试主号")
        self.room = DbScope(ROOM, "group", GROUP, policy=MENTIONS)

    def intake(self, *groups, account=ACCOUNT, fingerprint=FINGERPRINT):
        return DbIntake(self.state, account, fingerprint, (self.owner, *groups))

    def baseline(self, *groups, **response):
        intake = self.intake(*groups)
        intake.enroll()
        request = intake.request()
        result = intake.apply(request, poll(request, **response))
        return intake, result

    def test_initial_baseline_is_atomic_preserves_history_and_refuses_old_active_queue(self):
        self.state.register_transcript_scopes({OWNER: ("private", "Owner"), ROOM: ("group", "Room")})
        sent, = self.state.intake(OWNER, None, {"messages": []}, [{"text": "old confirmed"}])
        self.assertTrue(self.state.prepare(sent.id, "saved"))
        self.assertTrue(self.state.mark_attempted(sent.id))
        self.assertTrue(self.state.mark_sent(sent.id))
        old, = self.state.intake(ROOM, None, {"messages": []}, [{"text": "never send old"}])
        intake = self.intake(self.room)
        self.assertEqual(DbIntake.pins(self.state), {})
        with self.assertRaises(StateConflict):
            intake.request()
        intake.enroll()
        request = intake.request()
        with self.assertRaises(StateConflict):
            intake.apply(request, poll(request))
        self.assertIsNone(self.state.database_cursor(OWNER))
        self.assertIsNone(self.state.database_cursor(ROOM))
        self.assertEqual(self.state.pending(ROOM)[0].id, old.id)
        self.assertTrue(self.state.skip(old.id))
        result = intake.apply(request, poll(request))
        self.assertEqual(result.baselined, (OWNER, ROOM))
        self.assertEqual(self.state.pending(OWNER), ())
        self.assertEqual(self.state.pending(ROOM), ())
        self.assertEqual(self.state.history(OWNER)[-1]["text"], "saved")
        self.assertEqual(len(self.state.transcript_batch()["entries"]), 3)
        with self.assertRaises(StateConflict):
            self.state.intake(OWNER, 1, {"messages": []}, [{"text": "also never replay"}])

    def test_native_mention_membership_exact_owner_and_persisted_authority(self):
        intake, _ = self.baseline(self.room)
        request = intake.request()
        rows = [
            row(sender=ACCOUNT),
            row(sender="not_owner", local=12),
            row(local=13, body="  ／cron once 45s -- 测试\n文本"),
            row(GROUP, body="@测试 /sticker", sender="member"),
            row(GROUP, local=12, body="@别人 /sticker", sender="member", mentions=("other",)),
            row(GROUP, local=13, body="@测试 /sticker", sender="member", mentions=(ACCOUNT,),
                sender_display_name="测试成员"),
            row(GROUP, local=14, body="别名", sender=ACCOUNT, mentions=(ACCOUNT,)),
        ]
        intake.apply(request, poll(request, rows))
        private, = self.state.pending(OWNER)
        group, = self.state.pending(ROOM)
        self.assertEqual(private.observation["text"], rows[2]["body"])
        self.assertEqual(group.observation["sender"], "测试成员")
        self.assertEqual(group.observation["database"]["mention_ids"], [ACCOUNT])
        self.assertTrue(intake.event_authorized(private))
        self.assertTrue(intake.event_authorized(group))
        self.assertFalse(intake.event_authorized(replace(group, observation={**group.observation, "text": "forged"})))
        changed = self.intake(replace(self.room, policy=ALL))
        self.assertFalse(changed.event_authorized(group))
        self.assertTrue(self.state.prepare(group.id, "reply"))
        self.assertTrue(self.state.mark_attempted(group.id))
        self.assertTrue(intake.event_authorized(group))
        self.assertTrue(self.state.mark_sent(group.id))
        self.assertFalse(intake.event_authorized(group))

    def test_ignored_owner_messages_end_moment_adjacency_without_entering_the_reply_queue(self):
        intake, _ = self.baseline(self.room)
        draft_id = "e" * 64
        cases = [
            ("owner unsupported sticker", {"message_type": 47}, 1, "later"),
            ("owner voice with input off", {"message_type": 34}, 1, "later"),
            ("oversize owner text", {"body": "长" * 501}, 1, "later"),
            ("unknown private sender", {"sender": "", "message_type": 3}, 1, "later"),
            ("owner unsupported sticker in preview's second", {"message_type": 47}, 0, "later"),
            ("owner unsupported sticker before preview", {"message_type": 47}, -1, "next"),
            ("group photo", {"conversation": GROUP, "sender": "member", "message_type": 3}, 1, "next"),
        ]
        for index, (name, fields, offset, expected) in enumerate(cases):
            with self.subTest(name=name):
                created = 20 + 10 * index
                local = 11 + 2 * index
                with self.state.db:
                    self.state.record_moment_preview(draft_id, OWNER, created + 0.5)
                request = intake.request()
                rows = [row(local=local, created=created + offset, **fields),
                        row(local=local + 1, created=created + 2, body="好")]
                intake.apply(request, poll(request, rows))
                answer, = self.state.pending(OWNER)
                self.assertTrue(intake.event_authorized(answer))
                self.assertEqual(answer.observation["text"], "好")
                self.assertEqual(self.state.moment_answer_context(OWNER, draft_id, answer), expected)
                self.assertTrue(self.state.skip(answer.id))

    def test_admitted_attachment_does_not_make_following_text_a_moment_confirmation(self):
        intake, _ = self.baseline()
        draft_id = "e" * 64
        with self.state.db:
            self.state.record_moment_preview(draft_id, OWNER, 21)
        request = intake.request()
        intake.apply(request, poll(request, [
            row(local=11, created=22, message_type=3, body=""),
            row(local=12, created=23, body="好"),
        ]))
        image, answer = self.state.pending(OWNER)
        self.assertTrue(intake.event_authorized(image))
        self.assertEqual(self.state.moment_answer_context(OWNER, draft_id, answer), "later")

    def test_owner_voice_is_admitted_only_as_its_private_transcript(self):
        intake, _ = self.baseline(replace(self.room, policy=ALL))
        request = intake.request()
        voice = '<msg><voicemsg voicelength="2100" /></msg>'
        rows = [
            # Heard, unheard, not transcribed (voice off), the bot's own voice, and a group voice.
            row(local=12, server="901", message_type=34, body=voice, transcript="今天好累呀"),
            row(local=13, server="902", message_type=34, body=voice, transcript=""),
            row(local=14, server="903", message_type=34, body=voice),
            row(local=15, server="904", sender=ACCOUNT, message_type=34, body=voice, transcript="伪造"),
            row(GROUP, local=12, server="905", sender="member", message_type=34, body=voice, transcript="群里的语音"),
        ]
        intake.apply(request, poll(request, rows))
        heard, unheard = self.state.pending(OWNER)
        self.assertEqual((heard.observation["text"], heard.observation["voice"]), ("今天好累呀", {"heard": True}))
        self.assertEqual((unheard.observation["text"], unheard.observation["voice"]), ("[没听清的语音]", {"heard": False}))
        self.assertEqual(self.state.pending(ROOM), ())
        self.assertTrue(intake.event_authorized(heard))
        self.assertFalse(intake.event_authorized(replace(heard, observation={k: v for k, v in heard.observation.items() if k != "voice"})))
        with self.assertRaises(ValueError):
            intake.apply(intake.request(), poll(intake.request(), [row(local=16, message_type=34, body=voice, transcript="x" * 501)]))

    def test_private_articles_keep_signed_links_and_identity_without_dispatching_the_title(self):
        intake, _ = self.baseline(replace(self.room, policy=ALL), baseline_at=20)
        self.assertEqual(self.state.pending(OWNER), ())
        request = intake.request()
        private_rows = [
            row(local=21, server="901", message_type=ARTICLE_TYPE, body=appmsg()),
            row(local=22, server="901", message_type=ARTICLE_TYPE, body=appmsg()),
            row(local=23, server="902", message_type=49, body=appmsg("https://mp.weixin.qq.com/s/0123456789ab?srcid=owner")),
            row(local=24, server="903", body=TRACKED_ARTICLE_URL),
            row(local=25, server="904", body=f"看看 {ARTICLE_URL}"),
        ]
        intake.apply(request, poll(request, private_rows + [row(GROUP, sender="member", local=21, message_type=ARTICLE_TYPE, body=appmsg()),
                                                        row(GROUP, sender="member", local=22, body=TRACKED_ARTICLE_URL)]))
        forwarded, legacy, pasted, ordinary = self.state.pending(OWNER)
        self.assertEqual(forwarded.observation["article"], {"url": ARTICLE_URL, "title": "/queue & 实验", "account": "测试 公众号"})
        self.assertEqual(forwarded.observation["text"], ARTICLE_URL)
        self.assertEqual(legacy.observation["text"], "https://mp.weixin.qq.com/s/0123456789ab")
        self.assertEqual(pasted.observation["article"], {"url": ARTICLE_URL, "title": "公众号文章", "account": ""})
        self.assertEqual(ordinary.observation["text"], private_rows[-1]["body"])
        self.assertNotIn("article", ordinary.observation)
        group_text, = self.state.pending(ROOM)
        self.assertEqual(group_text.observation["text"], TRACKED_ARTICLE_URL)
        self.assertNotIn("article", group_text.observation)
        self.assertTrue(all(intake.event_authorized(event) for event in (forwarded, legacy, pasted, ordinary, group_text)))
        for event in (forwarded, pasted):
            altered = {**event.observation, "article": {**event.observation["article"], "title": "冒充标题"}}
            self.assertFalse(intake.event_authorized(replace(event, observation=altered)))

    def test_quoted_replies_separate_typed_text_and_require_existing_group_mention(self):
        intake, _ = self.baseline(self.room, baseline_at=20)
        quote = ('<msg><appmsg><title>先放着吧</title><type>57</type><refermsg><type>49</type>'
                 '<content>&lt;msg&gt;引用的长文&lt;/msg&gt;</content></refermsg></appmsg></msg>')
        request = intake.request()
        intake.apply(request, poll(request, [
            row(local=21, message_type=(57 << 32) | 49, body=quote),
            row(local=22, message_type=49, body=quote.replace("先放着吧", "收藏")),
            row(local=23, message_type=(57 << 32) | 49, body=quote.replace("先放着吧", "")),
            row(GROUP, sender="member", local=21, message_type=(57 << 32) | 49, body=quote),
            row(GROUP, sender="member", local=22, message_type=(57 << 32) | 49, body=quote, mentions=(ACCOUNT,)),
        ]))
        current, saved = self.state.pending(OWNER)
        self.assertEqual((current.observation["text"], saved.observation["text"]), ("先放着吧", "收藏"))
        self.assertNotIn("article", current.observation)
        self.assertEqual(current.observation["quote"], "引用：一条带格式或附件的消息")
        self.assertNotIn("rich", current.observation)
        self.assertEqual(saved.observation["rich"], {"kind": "quote", "evidence": current.observation["quote"]})
        group, = self.state.pending(ROOM)
        self.assertEqual(group.observation["database"]["local_id"], 22)
        self.assertEqual(group.observation["quote"], current.observation["quote"])
        self.assertNotIn("rich", group.observation)
        self.assertTrue(all(intake.event_authorized(event) for event in (current, saved, group)))
        forged = {**current.observation, "article": {"url": ARTICLE_URL, "title": "x", "account": ""}}
        self.assertFalse(intake.event_authorized(replace(current, observation=forged)))

    def test_unanswerable_owner_messages_are_recorded_by_kind_only(self):
        intake, _ = self.baseline(replace(self.room, policy=ALL), baseline_at=20)
        request = intake.request()
        intake.apply(request, poll(request, [
            row(local=21, created=30, message_type=3, body="", body_available=False),
            row(local=22, created=31, message_type=(19 << 32) | 49, body="<msg>forwarded</msg>"),
            row(local=23, created=32, message_type=47, body="sticker"),
            row(local=24, created=33, sender=ACCOUNT, message_type=3, body="own image"),
            row(local=25, created=34, body="answered"),
            row(GROUP, sender="member", local=21, created=35, message_type=3, body="group image"),
        ]))
        self.assertEqual(self.state.skipped_since(0), [("sticker", 32), ("forward", 31)])
        opaque_image, text = self.state.pending(OWNER)
        self.assertEqual(opaque_image.observation["rich"], {"kind": "image", "evidence": "这张图我现在看不了。"})
        self.assertEqual(opaque_image.observation["text"], "[图片]")
        self.assertEqual(text.observation["text"], "answered")
        self.assertTrue(intake.event_authorized(opaque_image))

    def test_no_command_in_rich_evidence_and_money_notices_stay_private(self):
        intake, _ = self.baseline(self.room, baseline_at=20)
        request = intake.request()
        quote = '<msg><appmsg><title>看看</title><type>57</type><refermsg><content>/pause-queue</content></refermsg></appmsg></msg>'
        link = '<msg><appmsg><title>/queue</title><type>5</type><url>https://example.test/page</url></appmsg></msg>'
        transfer = '<msg><appmsg><title>/queue</title><type>2000</type><wcpayinfo/></appmsg></msg>'
        redpacket = transfer.replace('2000', '2001')
        intake.apply(request, poll(request, [
            row(local=21, message_type=(57 << 32) | 49, body=quote),
            row(local=22, message_type=ARTICLE_TYPE, body=link),
            row(local=23, message_type=(2000 << 32) | 49, body=transfer),
            row(local=24, message_type=(2001 << 32) | 49, body=redpacket),
            row(GROUP, sender="member", local=21, message_type=(2000 << 32) | 49, body=transfer, mentions=(ACCOUNT,)),
            row(GROUP, sender="member", local=22, message_type=(2001 << 32) | 49, body=redpacket, mentions=(ACCOUNT,)),
        ]))
        private = self.state.pending(OWNER)
        self.assertEqual([event.observation["text"] for event in private], ["看看", "[链接]", "[转账]", "[红包]"])
        self.assertEqual(private[0].observation["quote"], "引用：/pause-queue")
        self.assertEqual(private[1].observation["rich"]["title"], "/queue")
        self.assertTrue(all(intake.event_authorized(event) for event in private))
        self.assertEqual(self.state.pending(ROOM), ())
        self.assertFalse(self.state.queue_paused(OWNER))
        self.assertEqual(self.state.skipped_since(0), [])

    def test_forged_and_unrelated_rich_cards_advance_the_cursor_without_queueing(self):
        intake, _ = self.baseline()
        request = intake.request()
        cards = [
            row(local=11, message_type=ARTICLE_TYPE, body=appmsg("https://mp.weixin.qq.com.evil.example/s/0123456789ab")),
            row(local=12, message_type=ARTICLE_TYPE, body=appmsg("https://mp.weixin.qq.com@evil.example/s/0123456789ab")),
            row(local=13, message_type=ARTICLE_TYPE, body=appmsg(ARTICLE_URL + "&sn=duplicate")),
            row(local=14, message_type=ARTICLE_TYPE, body=appmsg(subtype=57)),
            row(local=15, message_type=(57 << 32) | 49, body=appmsg()),
            row(local=16, message_type=ARTICLE_TYPE, body='<!DOCTYPE msg [<!ENTITY item "bad">]>' + appmsg()),
            row(local=17, message_type=ARTICLE_TYPE, body=appmsg(), sender=ACCOUNT),
            row(local=18, message_type=ARTICLE_TYPE, body=appmsg(), body_available=False),
        ]
        intake.apply(request, poll(request, cards))
        self.assertEqual(self.state.pending(OWNER), ())
        self.assertEqual(intake.request()["cursors"][f"{SHARD}/{CONTACT}"]["local_id"], 18)

    def test_duplicate_server_ids_distinct_repeats_and_unsigned_sort(self):
        shards = ((SHARD, GENERATION), (NEXT_SHARD, NEXT_GENERATION), (LAST_SHARD, LAST_GENERATION))
        intake, _ = self.baseline(shards=shards)
        request = intake.request()
        server = str(2**64 - 1)
        rows = [
            row(database=LAST_SHARD, body="same", created=20, server=server),
            row(database=NEXT_SHARD, body="same", created=20),
            row(database=NEXT_SHARD, local=12, body="same", created=20),
            row(created=10, body="first"),
        ]
        intake.apply(request, poll(request, rows))
        self.assertEqual([item.observation["database"]["database"] for item in self.state.pending(OWNER)],
                         [SHARD, NEXT_SHARD, NEXT_SHARD, LAST_SHARD])
        with self.assertRaises(StateConflict):
            intake.apply(request, poll(request, rows))
        next_request = intake.request()
        intake.apply(next_request, poll(next_request, [row(local=12, server=server)]))
        self.assertEqual(len(self.state.pending(OWNER)), 4)

    def test_queue_limit_preserves_unconsumed_rows_and_isolates_scopes(self):
        intake, _ = self.baseline(self.room)
        request = intake.request()
        rows = [row(local=index, body=f"msg-{index}") for index in range(11, 20)]
        rows += [row(GROUP, sender="member", mentions=(ACCOUNT,))]
        result = intake.apply(request, poll(request, rows))
        self.assertEqual(result.statuses, {OWNER: "queue_full", ROOM: "ready"})
        self.assertTrue(result.has_more)
        self.assertEqual(len(self.state.pending(OWNER)), 6)
        self.assertEqual(len(self.state.pending(ROOM)), 1)
        next_request = intake.request()
        self.assertEqual(next_request["cursors"][f"{SHARD}/{CONTACT}"]["local_id"], 16)
        self.assertTrue(self.state.skip(self.state.pending(OWNER)[0].id))
        result = intake.apply(next_request, poll(next_request, rows[6:9]))
        self.assertEqual(result.statuses[OWNER], "queue_full")
        self.assertEqual(intake.request()["cursors"][f"{SHARD}/{CONTACT}"]["local_id"], 17)

    def test_full_private_queue_keeps_verified_resume_lane(self):
        intake, _ = self.baseline()
        request = intake.request()
        rows = [row(local=index, body=f"msg-{index}") for index in range(11, 20)]
        rows += [row(local=20, body="/resume-queue")]
        result = intake.apply(request, poll(request, rows))
        self.assertEqual(result.statuses[OWNER], "queue_full")
        self.assertEqual(intake.request()["cursors"][f"{SHARD}/{CONTACT}"]["local_id"], 16)
        resume = self.state.pending(OWNER)[-1]
        self.assertEqual(resume.observation["text"], "/resume-queue")
        self.assertTrue(intake.event_authorized(resume))
        request = intake.request()
        intake.apply(request, poll(request, rows[6:]))
        self.assertEqual(len(self.state.pending(OWNER)), 7)

    def test_owner_control_lookahead_cannot_advance_cursor_or_leak_other_commands(self):
        intake, _ = self.baseline(self.room)
        request = intake.request(limit=10)
        rows = [row(local=index, body=f"msg-{index}") for index in range(11, 21)]
        control = row(local=5000, body="/resume-queue")
        response = {**poll(request, rows), "controls": [control]}
        invalid = [
            row(GROUP, local=5000, body="/resume-queue", mentions=(ACCOUNT,)),
            row(local=5000, body="/cron list"),
            row(local=5000, body="/resume-queue", sender="other"),
            row(local=20, body="/resume-queue"),
        ]
        for candidate in invalid:
            with self.subTest(candidate=candidate):
                with self.assertRaises(ValueError):
                    intake.apply(request, {**response, "controls": [candidate]})
        intake.apply(request, response)
        self.assertEqual(intake.request(limit=10)["cursors"][f"{SHARD}/{CONTACT}"]["local_id"], 16)
        resume = self.state.pending(OWNER)[-1]
        self.assertEqual(resume.observation["database"]["local_id"], 5000)
        self.assertTrue(intake.event_authorized(resume))
        request = intake.request(limit=10)
        intake.apply(request, {**poll(request, rows[6:]), "controls": [control]})
        self.assertEqual(len(self.state.pending(OWNER)), 7)

    def test_queue_pressure_chooses_older_cross_shard_prefix(self):
        intake, _ = self.baseline(shards=((SHARD, GENERATION), (NEXT_SHARD, NEXT_GENERATION)))
        request = intake.request()
        rows = [row(local=index, created=50 + index, body=f"new-{index}") for index in range(11, 17)]
        rows += [row(local=index, created=index, database=NEXT_SHARD, body=f"old-{index}") for index in range(11, 17)]
        result = intake.apply(request, poll(request, rows))
        self.assertEqual(result.statuses[OWNER], "queue_full")
        self.assertEqual([event.observation["text"] for event in self.state.pending(OWNER)],
                         [f"old-{index}" for index in range(11, 17)])
        cursors = intake.request()["cursors"]
        self.assertEqual(cursors[f"{SHARD}/{CONTACT}"]["local_id"], 10)
        self.assertEqual(cursors[f"{NEXT_SHARD}/{CONTACT}"]["local_id"], 16)

    def test_sender_change_baselines_only_affected_group_and_keeps_uncertain(self):
        intake, _ = self.baseline(self.room)
        request = intake.request()
        intake.apply(request, poll(request, [
            row(GROUP, sender="member", mentions=(ACCOUNT,)),
            row(GROUP, local=12, sender="member", mentions=(ACCOUNT,)),
        ]))
        first, old = self.state.pending(ROOM)
        self.assertTrue(self.state.prepare(first.id, "maybe"))
        self.assertTrue(self.state.mark_attempted(first.id))
        self.assertTrue(self.state.mark_uncertain(first.id))
        mode = GroupPolicy("sender", "Mutable screen nickname", "2")
        unresolved = self.intake(replace(self.room, policy=mode))
        request = unresolved.request()
        self.assertEqual(request["group_ids"], [])
        self.assertFalse(unresolved.event_authorized(old))
        self.assertEqual(unresolved.apply(request, poll(request)).statuses[ROOM], "database_sender_unverified")
        current = self.intake(replace(self.room, policy=mode, sender_id="member"))
        current.enroll()
        request = current.request()
        self.assertEqual(request["group_ids"], [GROUP])
        owner_before = self.state.database_cursor(OWNER)
        self.assertEqual(current.apply(request, poll(request, baseline_at=20)).baselined, (ROOM,))
        self.assertEqual(self.state.database_cursor(OWNER), owner_before)
        self.assertEqual(self.state.pending(ROOM), ())
        self.assertEqual(self.state.uncertain(ROOM)[0].id, first.id)
        request = current.request()
        current.apply(request, poll(request, [
            row(GROUP, local=21, sender="other", mentions=(ACCOUNT,)),
            row(GROUP, local=22, sender="member", body="/search hello"),
        ]))
        event, = self.state.pending(ROOM)
        self.assertTrue(current.event_authorized(event))
        self.assertEqual(event.observation["database"]["sender_id"], "member")

    def test_new_pinned_group_can_baseline_without_resetting_private_or_other_group(self):
        first, _ = self.baseline(self.room)
        request = first.request()
        first.apply(request, poll(request, [row()]))
        prior = {binding: self.state.database_cursor(binding) for binding in (OWNER, ROOM)}
        unbound = self.intake(self.room, DbScope(OTHER_ROOM, "group", OTHER_GROUP, policy=MENTIONS))
        request = unbound.request()
        self.assertEqual(request["group_ids"], [GROUP])
        self.assertEqual(unbound.apply(request, poll(request)).statuses[OTHER_ROOM], "database_unbound")
        unbound.enroll()
        request = unbound.request()
        self.assertEqual(request["group_ids"], [OTHER_GROUP])
        self.assertEqual(unbound.apply(request, poll(request, baseline_at=28)).baselined, (OTHER_ROOM,))
        self.assertEqual(prior, {binding: self.state.database_cursor(binding) for binding in (OWNER, ROOM)})
        self.assertEqual(len(self.state.pending(OWNER)), 1)
        with self.assertRaises(StateConflict):
            self.intake(replace(self.room, conversation_id=OTHER_GROUP)).enroll()
        with self.assertRaises(StateConflict):
            self.intake(self.room, fingerprint="e" * 64).enroll()

    def test_off_group_has_baseline_but_does_not_poll_messages(self):
        room = replace(self.room, policy=GroupPolicy("off", None, "2"))
        intake, result = self.baseline(room)
        self.assertIn(ROOM, result.baselined)
        self.assertEqual(result.statuses[ROOM], "off")
        self.assertEqual(intake.request()["group_ids"], [])
        resumed = self.intake(replace(self.room, policy=GroupPolicy("mentions", None, "3")))
        request = resumed.request()
        self.assertEqual(request["group_ids"], [GROUP])
        self.assertEqual(resumed.apply(request, poll(request, baseline_at=30)).baselined, (ROOM,))
        self.assertEqual(resumed.request()["cursors"][f"{SHARD}/{GROUP}"]["local_id"], 30)

    def test_only_explicitly_removed_group_can_be_bound_again(self):
        old, _ = self.baseline(self.room)
        request = old.request()
        old.apply(request, poll(request, [row(GROUP, sender="member", mentions=(ACCOUNT,))]))
        event, = self.state.pending(ROOM)
        replacement = self.intake(replace(self.room, binding=OTHER_ROOM))
        with self.assertRaises(StateConflict):
            replacement.enroll()
        with self.assertRaises(ValueError):
            old.enroll(retired_bindings=(ROOM,))
        replacement.enroll(retired_bindings=(ROOM,))
        self.assertTrue(DbIntake.pins(self.state)[ROOM].retired)
        self.assertFalse(old.event_authorized(event))
        request = replacement.request()
        self.assertEqual(replacement.apply(request, poll(request, baseline_at=42)).baselined, (OTHER_ROOM,))
        self.assertEqual(self.state.pending(OTHER_ROOM), ())
        self.assertEqual(self.state.pending(ROOM)[0].id, event.id)
        self.assertIsNotNone(self.state.database_cursor(ROOM))

    def test_retired_group_unconfirmed_send_blocks_rebinding_baseline(self):
        old, _ = self.baseline(self.room)
        request = old.request()
        old.apply(request, poll(request, [row(GROUP, sender="member", mentions=(ACCOUNT,))]))
        event, = self.state.pending(ROOM)
        self.assertTrue(self.state.prepare(event.id, "maybe"))
        self.assertTrue(self.state.mark_attempted(event.id))
        replacement = self.intake(replace(self.room, binding=OTHER_ROOM))
        replacement.enroll(retired_bindings=(ROOM,))
        request = replacement.request()
        with self.assertRaises(StateConflict):
            replacement.apply(request, poll(request, baseline_at=42))
        self.assertEqual(self.state.uncertain(ROOM)[0].id, event.id)
        self.assertIsNone(self.state.database_cursor(OTHER_ROOM))

    def test_rejects_cursor_tampering_or_wrong_account_without_advancing(self):
        intake, _ = self.baseline(self.room)
        request = intake.request()
        response = poll(request, [row()])
        response["cursors"][f"{SHARD}/{CONTACT}"]["local_id"] += 1
        with self.assertRaises(ValueError):
            intake.apply(request, response)
        response = poll(request, [row()])
        for cursor in response["cursors"].values():
            cursor["generation"] = NEXT_GENERATION
        with self.assertRaises(StateConflict):
            intake.apply(request, response)
        with self.assertRaises(ValueError):
            intake.apply(request, {**poll(request, [row()]), "account_id": "other_account"})
        forged = {**row(GROUP, sender="member"), "native_mention_self": True}
        with self.assertRaises(ValueError):
            intake.apply(request, poll(request, [forged]))
        self.assertEqual(intake.request(), request)
        self.assertEqual(self.state.pending(OWNER), ())
        self.assertEqual(self.state.pending(ROOM), ())

    def test_read_only_pre_migration_database_supports_absent_pins(self):
        legacy = Path(self.root.name) / "legacy.db"
        with sqlite3.connect(legacy) as connection:
            connection.execute("CREATE TABLE legacy (marker TEXT)")
        with WeChatState(legacy, read_only=True) as state:
            self.assertEqual(DbIntake.pins(state), {})
            self.assertIsNone(state.database_cursor(OWNER))


if __name__ == "__main__":
    unittest.main()
