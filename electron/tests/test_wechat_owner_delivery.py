"""Real binding, ledger, reply-text and cloud-authority paths; only physical UI is stubbed."""
from contextlib import ExitStack, nullcontext, redirect_stdout
import fcntl
from hashlib import sha256
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'wechat-runtime'))
import wechat_listener as listener
import wechat_moments as moments
import wechat_owner_delivery as delivery
from wechat_db_intake import DbIntake, DbScope
from wechat_reply_settings import read_cloud_route
import wechat_voice_send
import wechat_voice_synthesis
from wechat_state import WeChatState, digest_day_end


class OwnerDeliveryTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.root.chmod(0o700)
        self.db = self.root / 'listener.db'
        self.settings = {'account_name': 'Companion', 'targets': {'private': {'title': 'Owner'}}}
        self.owner = {'account': 'Companion', 'title': 'Owner', 'fingerprint': 'f' * 64}
        self.write('owner.json', self.owner)
        self.write('groups.json', {'legacy_removed': True, 'groups': []})
        self.write('reply-settings.json', {'model': 'fixture', 'split': False, 'stickers': True})
        self.write('cloud-settings.json', {'private': {'providerId': 'fixture', 'model': 'fixture'},
                                         'groups': {}, 'destinations': {'private': 'd' * 64}})
        self.binding = listener.private_binding_key(self.settings, listener.owner_record(self.settings, self.root))
        self.request = {'id': 'e' * 64, 'binding': self.binding, 'text': '发好啦，朋友圈里能看到了。'}
        self.sent = []

    def intake(self, state):
        return DbIntake(state, 'fixture_bot', self.owner['fingerprint'],
                        (DbScope(self.binding, 'private', 'fixture_owner'),))

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def run_delivery(self, request=None, *, revoke=False, uncertain=False, enroll=True, real_lock=False,
                     preflight_error=None, report_preflight=None):
        if enroll:
            with WeChatState(self.db) as state:
                self.intake(state).enroll()

        def send(*args, before_send, receipt, **kwargs):
            if preflight_error is not None:
                raise preflight_error
            if revoke:
                self.write('owner.json', {**self.owner, 'fingerprint': 'a' * 64})
            if before_send():
                self.sent.append(args)
                if not uncertain:
                    receipt()

        with ExitStack() as stack:
            if not real_lock:
                stack.enter_context(patch.object(delivery.ui, 'vm_operation', side_effect=lambda *, wait: nullcontext()))
            stack.enter_context(patch.object(delivery.ui, 'open_target'))
            # Real verify_owner still compares the observed physical fingerprint to owner.json.
            stack.enter_context(patch.object(listener, 'owner_fingerprint', return_value=self.owner['fingerprint']))
            stack.enter_context(patch.object(delivery.ui, 'run_test', side_effect=send))
            stack.enter_context(patch.object(delivery.ui, 'run_sticker', side_effect=send))
            return delivery.owner_deliver(self.settings, self.root, self.db, request or self.request,
                                          report_preflight=report_preflight)

    def test_owner_delivery_waits_for_a_real_lock_and_times_out_before_a_send(self):
        lock_path = self.root / 'desktop.lock'
        lock_path.touch(mode=0o600)
        for release_after in (10, None):
            with self.subTest(release_after=release_after), lock_path.open('rb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                elapsed = 0

                def sleep(seconds):
                    nonlocal elapsed
                    elapsed += round(seconds * 1000)
                    if release_after is not None and elapsed >= release_after * 1000:
                        fcntl.flock(lock, fcntl.LOCK_UN)

                request = {**self.request, 'id': ('a' if release_after else 'b') * 64}
                with (patch.object(delivery.ui, 'VM_LOCK_PATH', lock_path),
                      patch.object(delivery.ui.time, 'monotonic', side_effect=lambda: elapsed / 1000),
                      patch.object(delivery.ui.time, 'sleep', side_effect=sleep)):
                    self.assertEqual(self.run_delivery(request, real_lock=True), 'sent' if release_after else 'busy')
                self.assertEqual(elapsed, (release_after or 30) * 1000)
                self.assertEqual(len(self.sent), 1)

    def test_notices_use_real_binding_and_ledger_and_never_duplicate(self):
        for text in ['我挑好配图啦，帮我看看。', '这就去发，发完告诉你。', '发好啦。',
                     '这次没发出去，草稿作废了。', '可能已经发了，请在手机上看一眼，别重复发。']:
            with self.subTest(text=text):
                request = {**self.request, 'id': sha256(text.encode()).hexdigest(), 'text': text}
                self.assertEqual(self.run_delivery(request), 'sent')
                self.assertEqual(self.run_delivery(request), 'sent')
        self.assertEqual(len(self.sent), 5)
        self.assertEqual(self.run_delivery({**self.request, 'binding': '0' * 64}), 'binding_invalid')

    def test_digest_is_once_only_and_does_not_enter_owner_transcript(self):
        request = {**self.request, 'recordTranscript': False}
        self.assertEqual(delivery.parse_delivery(json.dumps(request).encode()), request)
        with patch.object(WeChatState, 'record_owner_notice') as record:
            self.assertEqual(self.run_delivery(request), 'sent')
            self.assertEqual(self.run_delivery(request), 'sent')
            self.assertEqual(self.run_delivery({**self.request}), 'conflict')
            record.assert_not_called()
        self.assertEqual(len(self.sent), 1)
        with self.assertRaises(ValueError):
            delivery.parse_delivery(json.dumps({**request, 'voice': True}).encode())

    def test_confirmed_digests_enter_only_same_day_owner_context_and_tagged_transcript(self):
        end = digest_day_end(time.time())
        now = end - 60
        with WeChatState(self.db) as state:
            state.register_transcript_scopes({self.binding: ('private', 'Owner')})
        with patch.object(delivery.time, 'time', return_value=now):
            sent_items = []
            for digit, kind in zip('123', ('groups', 'official', 'moments'), strict=True):
                request = {**self.request, 'id': digit * 64, 'digestKind': kind, 'text': '合成摘要 ' + digit}
                self.assertEqual(delivery.parse_delivery(json.dumps(request).encode()), request)
                self.assertEqual(self.run_delivery(request), 'sent')
                self.assertEqual(self.run_delivery(request), 'sent')
                sent_items.append(request)
            self.assertEqual(self.run_delivery({**self.request, 'digestKind': 'groups'}, uncertain=True), 'uncertain')
            with WeChatState(self.db) as state:
                expected = {'items': [item['text'] for item in sent_items], 'expiresAt': end}
                self.assertEqual(state.daily_digest_context(self.binding), expected)
                self.assertIsNone(state.daily_digest_context('0' * 64))
                self.assertIsNone(state.daily_digest_context(self.binding, now=end))
                entries = state.transcript_batch()['entries']
                self.assertEqual([entry['id'] for entry in entries], [item['id'] for item in sent_items])
                self.assertTrue(all(entry['wechatDigest'] for entry in entries))
                state.acknowledge_transcript([(entry['id'], entry['role']) for entry in entries])
                self.assertEqual(state.transcript_batch()['entries'], [])
                self.assertEqual(state.daily_digest_context(self.binding), expected)

    def test_revocation_at_send_time_and_uncertainty_are_not_retried(self):
        self.assertEqual(self.run_delivery(revoke=True), 'binding_invalid')
        self.assertEqual(self.sent, [])
        self.write('owner.json', self.owner)
        self.assertEqual(self.run_delivery(uncertain=True), 'uncertain')
        self.assertEqual(self.run_delivery(), 'uncertain')
        self.assertEqual(len(self.sent), 1)

    def test_safe_retry_keeps_the_allowlisted_preflight_reason_without_reserving_a_send(self):
        reasons = []
        request = {**self.request, 'digestKind': 'groups'}
        failure = delivery.ui.TestError('private fixture detail', code='drawer_state_unknown')
        self.assertEqual(self.run_delivery(request, preflight_error=failure, report_preflight=reasons.append), 'retry')
        self.assertEqual(reasons, ['drawer_state_unknown'])
        self.assertEqual(self.sent, [])
        with WeChatState(self.db) as state:
            self.assertEqual(state.db.execute('SELECT count(*) FROM wechat_owner_deliveries').fetchone()[0], 0)

    def test_owner_delivery_control_reports_reasons_for_ordinary_sends_only_before_click(self):
        def result(status):
            def deliver(_settings, _runtime, _path, request, *, report_preflight):
                self.assertNotIn('digestKind', request)
                report_preflight('drawer_state_unknown')
                return status

            stdin = SimpleNamespace(buffer=BytesIO(json.dumps(self.request).encode()))
            stdout = StringIO()
            with (patch.object(delivery.sys, 'stdin', stdin),
                  patch.object(delivery, 'owner_deliver', side_effect=deliver), redirect_stdout(stdout)):
                delivery.owner_delivery_control(self.settings, self.root, self.db)
            return json.loads(stdout.getvalue())

        self.assertEqual(result('retry'), {'status': 'retry', 'reason': 'drawer_state_unknown'})
        self.assertEqual(result('uncertain'), {'status': 'uncertain'})
        self.assertEqual(result('sent'), {'status': 'sent'})

    def test_sticker_uses_real_private_spool_and_separate_once_only_ledger(self):
        image = b'\x89PNG\r\n\x1a\nfixture'
        digest = sha256(image).hexdigest()
        spool = self.root / 'sticker-spool'
        spool.mkdir(mode=0o700)
        path = spool / f"{self.request['id']}.{digest}.png"
        path.write_bytes(image)
        path.chmod(0o600)
        request = {**self.request, 'stickerAsset': digest}
        self.assertEqual(delivery.parse_delivery(json.dumps(request).encode()), request)
        self.assertEqual(self.run_delivery(request), 'sent')
        self.assertEqual(self.run_delivery(request), 'sent')
        self.assertEqual(len(self.sent), 2)

    def test_real_cloud_authority_accepts_only_exact_reply_texts_including_voice(self):
        with WeChatState(self.db) as state:
            # The queue and history are real SQLite, not a mocked authorizer.
            for index, observation in enumerate([{'text': '发吧'}, {'text': '/voice 早安'},
                                                  {'text': '今天好累', 'voice': {'heard': True}}], 1):
                event_id = sha256(str(index).encode()).hexdigest()
                state.db.execute('DELETE FROM wechat_occurrences')
                state.db.execute('INSERT INTO wechat_occurrences VALUES (?, ?, ?, ?, ?, NULL)',
                                 (event_id, self.binding, index, json.dumps(observation), 'pending'))
                state.db.commit()
                event = state.pending(self.binding)[0]
                asked, model_text, _ = listener.reply_texts(event, 'private')
                request = {'target': 'private', 'groupId': None, 'binding': self.binding, 'eventId': event_id,
                           'text': model_text, 'history': [], 'split': False, 'stickers': True}
                self.assertIsNotNone(listener.authorize_cloud_request(state, self.settings, self.root, request))
                self.assertIsNotNone(listener.authorize_cloud_request(state, self.settings, self.root, {**request, 'text': asked}))
                self.assertIsNone(listener.authorize_cloud_request(state, self.settings, self.root, {**request, 'text': model_text + 'extra'}))
                self.assertIsNone(listener.authorize_cloud_request(state, self.settings, self.root, {**request, 'binding': '0' * 64}))

    def test_long_owner_text_survives_intake_cloud_authority_transcript_and_next_turn(self):
        original = '𠀀' * 499 + '\n' + '𠀀' * 500
        followup = '请接着说'
        sender = 'fixture_owner'
        shard = 'message_0.db'
        with WeChatState(self.db) as state:
            intake = self.intake(state)
            intake.enroll()
            state.register_transcript_scopes({self.binding: ('private', 'Owner')})

            def poll(local_id, rows):
                intake.apply(intake.request(), {'ok': True, 'account_id': 'fixture_bot', 'rows': rows,
                    'cursors': {f'{shard}/{sender}': {'generation': 'a' * 32, 'local_id': local_id}}, 'has_more': False})

            def admit(text, local_id):
                poll(local_id, [{'conversation_id': sender, 'sender_id': sender, 'database': shard,
                    'local_id': local_id, 'server_id': str(local_id), 'created_at': local_id, 'type': 1,
                    'body': text, 'native_mention_self': False, 'mention_ids': []}])
                return state.pending(self.binding)[0]

            def authorize(event, text, history):
                request = {'target': 'private', 'groupId': None, 'binding': self.binding,
                    'eventId': event.id, 'text': text, 'history': history, 'split': False, 'stickers': True}
                wire = (json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8')
                checked = listener.cloud_request_from_bytes(wire)
                return listener.authorize_cloud_request(state, self.settings, self.root, checked)

            poll(10, [])
            first = admit(original, 11)
            route = read_cloud_route(self.root, 'private', None)
            self.assertIsNotNone(route)
            self.assertEqual(authorize(first, original, []), route)
            self.assertIsNone(authorize(first, original[:-1], []))
            self.assertEqual(state.transcript_batch()['entries'][0]['text'], original)
            self.assertTrue(state.prepare(first.id, '已读完整消息'))
            self.assertTrue(state.mark_attempted(first.id))
            self.assertTrue(state.mark_sent(first.id))

            second = admit(followup, 12)
            history = state.history(self.binding, for_cloud=True, owner=True)
            self.assertEqual(history, [{'role': 'user', 'text': original}, {'role': 'assistant', 'text': '已读完整消息'}])
            self.assertEqual(authorize(second, followup, history), route)

    def test_following_cloud_routes_keep_bound_fingerprints_for_all_scopes(self):
        pin = 'd' * 64
        group = 'a' * 32
        friend = 'b' * 32
        pinned = {'providerId': 'fixture', 'model': 'm1'}
        following = {**pinned, 'follow': True}

        def install(private):
            self.write('cloud-settings.json', {'private': private, 'groups': {group: following},
                                                 'destinations': {'private': pin, group: pin}})
            self.write('friend-cloud-settings.json', {'friends': {friend: following},
                                                        'destinations': {f'friend:{friend}': pin}})

        original = sha256(json.dumps(['fixture', 'm1', pin], separators=(',', ':')).encode()).hexdigest()
        updated = sha256(json.dumps(['fixture', 'm1', pin, True], separators=(',', ':')).encode()).hexdigest()
        install(pinned)
        self.assertEqual(read_cloud_route(self.root, 'private', None), original)
        install(following)
        self.assertEqual(read_cloud_route(self.root, 'private', None), updated)
        self.assertEqual(read_cloud_route(self.root, 'group', group), updated)
        self.assertEqual(read_cloud_route(self.root, 'friend', friend), updated)
        for invalid in (False, 1, None, 'true'):
            install({**pinned, 'follow': invalid})
            with self.assertRaises(ValueError):
                read_cloud_route(self.root, 'private', None)

    def test_article_authority_is_bound_to_the_persisted_private_card(self):
        url = 'https://mp.weixin.qq.com/s/0123456789ab'
        chat = 'fixture_owner'
        shard = 'message_0.db'
        with WeChatState(self.db) as state:
            intake = DbIntake(state, 'fixture_bot', self.owner['fingerprint'], (DbScope(self.binding, 'private', chat),))
            intake.enroll()
            result = {'ok': True, 'account_id': 'fixture_bot', 'rows': [], 'has_more': False,
                      'cursors': {f'{shard}/{chat}': {'generation': '1' * 32, 'local_id': 70}}}
            intake.apply(intake.request(), result)
            message = {'conversation_id': chat, 'sender_id': chat, 'local_id': 71, 'server_id': '123', 'database': shard,
                       'created_at': 120, 'type': 21474836529, 'native_mention_self': False, 'mention_ids': [],
                       'body': f'<msg><appmsg><title>实测</title><type>5</type><url>{url}</url></appmsg></msg>'}
            cursor = {f'{shard}/{chat}': {'generation': '1' * 32, 'local_id': 71}}
            intake.apply(intake.request(), {**result, 'rows': [message], 'cursors': cursor})
            event, = state.pending(self.binding)
            request = {'target': 'private', 'groupId': None, 'binding': self.binding, 'eventId': event.id,
                       'text': url, 'article': {'url': url, 'title': '实测', 'account': ''},
                       'history': [], 'split': False, 'stickers': True}
            authorize = lambda value: listener.authorize_cloud_request(state, self.settings, self.root, value)
            self.assertEqual(authorize(request), 'article')
            self.assertIsNone(authorize({key: value for key, value in request.items() if key != 'article'}))
            self.assertIsNone(authorize({**request, 'article': {**request['article'], 'title': '伪造'}}))
            self.assertIsNone(authorize({**request, 'text': '改过的网址'}))
            self.assertTrue(state.prepare(event.id, '准备发送'))
            self.assertIsNone(authorize(request))

    def test_moment_consent_uses_confirmed_preview_and_real_owner_queue(self):
        draft_id = 'a' * 64
        original = self.request.copy()
        self.request = {**original, 'id': draft_id, 'text': '我挑好配图啦，先给你看看。'}
        preview_request = {**self.request, 'image': b'fixture image'}

        def apply_messages(state, ids, at):
            intake = self.intake(state)
            rows = [{"conversation_id": "fixture_owner", "sender_id": "fixture_owner", "local_id": i,
                     "server_id": str(i), "database": "message_0.db", "created_at": at, "type": 1,
                     "native_mention_self": False, "mention_ids": [], "body": "好"} for i in ids]
            intake.apply(intake.request(), {"ok": True, "account_id": "fixture_bot", "rows": rows, "has_more": False,
                "cursors": {"message_0.db/fixture_owner": {"generation": "1" * 32, "local_id": max(ids, default=0)}}})
            return state.pending(self.binding)

        with WeChatState(self.db) as state:
            state.register_transcript_scopes({self.binding: ('private', 'Owner')})
            self.intake(state).enroll()
            apply_messages(state, [], 0)
            old, = apply_messages(state, [1], int(time.time()) - 10)

        def image(_target, _settings, _path, _png, *, before_send, receipt, database_receipt):
            self.assertTrue(callable(database_receipt))
            self.assertTrue(before_send())
            self.assertTrue(receipt())

        with (
            patch.object(moments.ui, 'vm_operation', side_effect=lambda **_: nullcontext()),
            patch.object(moments.ui, 'open_target'),
            patch.object(listener, 'owner_fingerprint', return_value=self.owner['fingerprint']),
            patch.object(moments.ui, 'run_test', side_effect=lambda *a, before_send, receipt, database_receipt: before_send() and receipt()),
            patch.object(moments.ui, 'run_sticker', side_effect=image),
        ):
            self.assertEqual(moments.send_preview(self.settings, self.root, self.db, preview_request), 'sent')

        def context(state, event, **changes):
            asked, text, _ = listener.reply_texts(event, 'private')
            self.assertEqual(asked, '好')
            request = {'target': 'private', 'groupId': None, 'binding': self.binding, 'eventId': event.id,
                       'text': text, 'history': [], 'split': False, 'stickers': True}
            return listener.authorize_moment_answer(state, self.settings, self.root, {**request, **changes}, draft_id)

        with WeChatState(self.db) as state:
            self.assertEqual(context(state, old), 'before-preview')
            self.assertTrue(state.skip(old.id))
            state.acknowledge_transcript([(draft_id, 'assistant')])
            first, second = apply_messages(state, [2, 3], int(time.time()) + 1)
            self.assertEqual(context(state, first), 'next')
            self.assertIsNone(context(state, first, text='发'))
            self.assertIsNone(context(state, first, binding='0' * 64))
            self.assertIsNone(context(state, second))

        self.assertEqual(self.run_delivery(original), 'sent')
        with WeChatState(self.db) as state:
            self.assertEqual(context(state, first), 'later')
            self.assertTrue(state.skip(first.id))
            self.assertEqual(context(state, second), 'later')

    def voice(self, *, fail_before=False, uncertain=False, revoke=False):
        with WeChatState(self.db) as state:
            DbIntake(state, 'fixture_bot', self.owner['fingerprint'],
                     (DbScope(self.binding, 'private', 'fixture_owner'),)).enroll()

        def synthesize(_text):
            if fail_before:
                raise wechat_voice_synthesis.VoiceSynthesisError('voice_fixture')
            return b'fixture wav'

        def record(_settings, _path, _runtime, _pin, _wav, *, before_send):
            if revoke:
                self.write('owner.json', {**self.owner, 'fingerprint': 'a' * 64})
            if before_send():
                self.sent.append('voice')
                return {'status': 'unconfirmed' if uncertain else 'confirmed'}
            return {'status': 'rejected'}

        with ExitStack() as stack:
            stack.enter_context(patch.object(wechat_voice_synthesis, 'synthesize_wav', side_effect=synthesize))
            stack.enter_context(patch.object(wechat_voice_send, 'record_voice', side_effect=record))
            return self.run_delivery({**self.request, 'voice': True})

    def test_voice_confirmed_uses_same_real_ledger_and_is_not_resent_as_text(self):
        self.assertEqual(self.voice(), 'sent')
        self.assertEqual(self.voice(), 'sent')
        self.assertEqual(self.run_delivery(), 'sent')
        self.assertEqual(self.sent, ['voice'])

    def test_voice_failure_before_attempt_falls_back_to_real_text_delivery(self):
        self.assertEqual(self.voice(fail_before=True), 'sent')
        self.assertEqual(len(self.sent), 1)
        self.assertNotEqual(self.sent[0], 'voice')

    def test_voice_without_a_pin_uses_verified_text_once(self):
        request = {**self.request, 'voice': True}
        with patch.object(wechat_voice_synthesis, 'synthesize_wav') as synthesize:
            self.assertEqual(self.run_delivery(request, enroll=False), 'sent')
            self.assertEqual(self.run_delivery(request, enroll=False), 'sent')
            synthesize.assert_not_called()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][:3], ('send', 'private', self.request['text']))

    def test_unpinned_voice_text_fallback_rechecks_owner_binding_at_send_time(self):
        self.assertEqual(self.run_delivery({**self.request, 'voice': True}, enroll=False, revoke=True), 'binding_invalid')
        self.assertEqual(self.sent, [])

    def test_voice_unknown_outcome_never_falls_back_or_retries_and_does_not_block_next_notice(self):
        self.assertEqual(self.voice(uncertain=True), 'uncertain')
        self.assertEqual(self.run_delivery(), 'uncertain')
        self.assertEqual(self.sent, ['voice'])
        self.assertEqual(self.run_delivery({**self.request, 'id': '9' * 64, 'text': '下一条通知'}), 'sent')
        self.assertEqual(len(self.sent), 2)

    def test_voice_rechecks_real_binding_before_attempt(self):
        self.assertEqual(self.voice(revoke=True), 'binding_invalid')
        self.assertEqual(self.sent, [])

    def test_new_context_name_is_forwarded_only_when_bounded_and_printable(self):
        import wechat_replies
        for name, accepted in [('星.芽+(1)', True), ('DeskPet', True), ('', False), ('x\n', False), ('x' * 41, False)]:
            with self.subTest(name=name), patch.object(wechat_replies, '_host_reply', return_value={'name': name, 'persona': None, 'memories': []}):
                context = wechat_replies.local_reply_context(self.root, {}, 'fixture')
                self.assertEqual(context is not None, accepted)


if __name__ == '__main__':
    unittest.main()
