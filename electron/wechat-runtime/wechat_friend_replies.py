"""Reply to authenticated friend messages through a separate read and delivery lane."""

from concurrent.futures import ThreadPoolExecutor
import hmac
import re
import sqlite3
import subprocess
import time
from unicodedata import normalize

import vm_console as ui
from wechat_db_channel import DatabaseUnavailable
from wechat_db_intake import DbIntake, DbScope
from wechat_friends import enrolled_friends, friend_binding_key, settings_for_friend, verify_friend
from wechat_replies import DeskPet, ReplyRejected, ReplyYielded, cloud_reply_plan, local_reply_context, log, owner_command_candidate
from wechat_reply_settings import read_cloud_route, read_reply_settings
from wechat_rich_message import chat_quote_excerpt
from wechat_service import is_paused
from wechat_state import StateConflict


FRIEND_DECLINE = '这个操作只能由主人在自己的私聊里发起。'
FRIEND_RICH_NOTICES = {
    'image': '这张图我现在看不了。', 'file': '我收到了文件，但现在打不开内容。',
    'link': '我收到了链接，但现在打不开内容。', 'forward': '我现在看不了转发的聊天记录。',
    'location': '我收到了位置卡片。', 'card': '我收到了名片。', 'miniprogram': '我现在打不开小程序。',
    'video': '我现在看不了视频。',
}
FRIEND_QUEUE_WAIT = 10 * 60
FRIEND_ERRORS = (ui.TestError, OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError, StateConflict)


def friend_owner_command(text):
    from wechat_replies import doctor_checkup_command
    if doctor_checkup_command(text):
        return False  # Ordinary friend text: never dispatch the owner's doctor command.
    text = normalize('NFKC', text).strip()
    return owner_command_candidate(text) or bool(re.fullmatch(
        r'(?:发|发吧|发了吧|发布|发出去|就发|发朋友圈|发布朋友圈|体检|检查一下)[。.!！]?', text))


def friend_intake(state, settings, runtime, friend):
    from wechat_listener import owner_record, private_binding_key

    owner = owner_record(settings, runtime)
    owner_binding = private_binding_key(settings, owner)
    binding = friend_binding_key(settings, owner, friend)
    pins = DbIntake.pins(state)
    primary = pins.get(owner_binding)
    pin = pins.get(binding)
    if (primary is None or primary.retired or primary.target != 'private' or pin is None or pin.retired
            or pin.target != 'friend' or pin.conversation_id != friend.conversation or pin.account_id != primary.account_id
            or primary.owner_fingerprint != owner['fingerprint'] or pin.owner_fingerprint != owner['fingerprint']):
        raise DatabaseUnavailable('friend_binding_invalid')
    scope = DbScope(binding, 'friend', friend.conversation, display_name=friend.title)
    owner_scope = DbScope(owner_binding, 'private', primary.conversation_id)
    return binding, primary, DbIntake(state, pin.account_id, pin.owner_fingerprint, (owner_scope, scope))


def authorize_friend(state, settings, runtime, request):
    if is_paused(runtime) or request.get('target') != 'friend' or request.get('groupId') is not None:
        return None
    local = request.get('contextOnly') is True
    allowed = {'target', 'groupId', 'friendId', 'binding', 'eventId', 'text', 'history', 'split', 'stickers', 'quote'}
    if local:
        allowed |= {'contextOnly', 'localModel'}
    if set(request) - allowed or request.get('split') is not False or request.get('stickers') is not False:
        return None
    try:
        friend = enrolled_friends(settings, runtime).get(request.get('friendId'))
        if friend is None:
            return None
        binding, _, intake = friend_intake(state, settings, runtime, friend)
        queue = state.pending(binding)
        if not queue or state.uncertain(binding) or not hmac.compare_digest(binding, request['binding']):
            return None
        event = queue[0]
        if (event.status != 'pending' or event.id != request['eventId'] or not intake.event_authorized(event)
                or event.observation.get('rich') or event.observation.get('article')
                or friend_owner_command(event.observation['text']) or event.observation['text'] != request['text']
                or request.get('quote') != chat_quote_excerpt(event.observation)
                or request['history'] != state.history(binding, for_cloud=not local)):
            return None
        route = read_cloud_route(runtime, 'friend', friend.id)
        if local:
            return 'local' if route is None and request['localModel'] == read_reply_settings(runtime)['model'] else None
        return route
    except FRIEND_ERRORS:
        return None


def friend_request(state, friend, binding, event, route):
    quote = chat_quote_excerpt(event.observation)
    return {'target': 'friend', 'groupId': None, 'friendId': friend.id, 'binding': binding, 'eventId': event.id,
            'text': event.observation['text'], 'history': state.history(binding, for_cloud=route is not None),
            'split': False, 'stickers': False, **({'quote': quote} if quote else {})}


def hear_friend_voices(request, response, reader, settings, priority):
    if request.get('baseline') or not isinstance(response.get('rows'), list):
        return
    friend = request['friend_id']
    rows = [row for row in response['rows'] if isinstance(row, dict) and row.get('conversation_id') == friend
            and row.get('sender_id') == friend and type(row.get('type')) is int and row['type'] & 0xffffffff == 34]
    if not rows:
        return
    from wechat_voice_transcribe import VoiceTranscriptionError, transcribe, voice_runtime

    for row in rows:
        row['transcript'] = ''
    try:
        if voice_runtime() is None:
            return
        for row in rows[:3]:
            priority()
            audio = reader.voice_audio(request['account_id'], request['owner_id'], row['server_id'], friend_id=friend)
            if audio is not None:
                row['transcript'] = transcribe(audio, [settings['account_name']])
    except (DatabaseUnavailable, VoiceTranscriptionError):
        return


def plan_reply(state, friend, binding, event, runtime, model, priority):
    from wechat_listener import PRIVATE_REPLY_REJECTED, VOICE_UNHEARD_REPLY

    text = event.observation['text']
    rich = event.observation.get('rich')
    voice = event.observation.get('voice')
    route = read_cloud_route(runtime, 'friend', friend.id)
    prefs = read_reply_settings(runtime)
    presentation = {'friendRoute': route, 'localModel': prefs['model']}
    if friend_owner_command(text):
        return FRIEND_DECLINE, presentation, model
    if rich is not None:
        return FRIEND_RICH_NOTICES.get(rich['kind']), presentation, model
    if voice is not None and not voice.get('heard'):
        return VOICE_UNHEARD_REPLY, presentation, model
    request = friend_request(state, friend, binding, event, route)
    try:
        if route is not None:
            planned = cloud_reply_plan(runtime, request, route, wait_hook=priority)
        else:
            previous = state.history(binding, for_cloud=True)
            context = local_reply_context(runtime, request, prefs['model'])
            if previous != request['history']:
                presentation['localContext'] = True
            if model is None:
                model = DeskPet(wait_hook=priority)
            options = {'model': prefs['model'], 'split': False, 'stickers': False}
            if context:
                presentation['localContext'] = True
                options['context'] = context
            if 'quote' in request:
                options['quote'] = request['quote']
            planned = model.reply_plan(event.id, 'friend', text, request['history'], options, wait_hook=priority)
    except ReplyRejected:
        return PRIVATE_REPLY_REJECTED, presentation, model
    except (ReplyYielded, *FRIEND_ERRORS):
        if route is None and model is not None:
            model.cancel()
        raise
    return planned['reply'], presentation, model


def deliver_friend(state, settings, path, runtime, friend, binding, event, priority):
    from wechat_listener import database_receipt

    active = settings_for_friend(settings, friend)
    presentation = event.observation.get('presentation', {})
    attempted = False
    outcome = 'friend_reply_unavailable'
    proof = {'version': 1, 'final': True}
    with ui.vm_operation():
        if is_paused(runtime) or enrolled_friends(settings, runtime).get(friend.id) != friend:
            return 'friend_binding_invalid'
        if (presentation.get('friendRoute') != read_cloud_route(runtime, 'friend', friend.id)
                or presentation.get('friendRoute') is None and presentation.get('localModel') != read_reply_settings(runtime)['model']):
            state.reset_prepared(event.id)
            return 'checking'
        current_binding, owner, intake = friend_intake(state, settings, runtime, friend)
        if current_binding != binding or not intake.event_authorized(event):
            return 'friend_binding_invalid'
        try:
            ui.open_target(active, path, 'private', search_only=True)
            window = verify_friend(active, path)

            def remember_database(request):
                proof['database_request'] = request

            def before_send():
                nonlocal attempted, outcome
                try:
                    priority(force=True)
                except ReplyYielded:
                    outcome = 'checking'
                    return False
                if (is_paused(runtime) or enrolled_friends(settings, runtime).get(friend.id) != friend
                        or verify_friend(active, path) != window or not intake.event_authorized(event)):
                    outcome = 'friend_binding_invalid'
                    return False
                if 'database_request' not in proof:
                    outcome = 'friend_database_unavailable'
                    return False
                if presentation.get('friendRoute') != read_cloud_route(runtime, 'friend', friend.id):
                    outcome = 'checking'
                    return False
                admission = state.mark_friend_attempted(event.id, friend.conversation, proof)
                attempted = admission == 'attempted'
                if not attempted:
                    outcome = admission
                return attempted

            ui.run_test('send', 'private', event.reply, active, path, before_send=before_send,
                        receipt=lambda: state.mark_sent(event.id), native_private_receipt=True,
                        database_receipt=database_receipt(event.observation['database'], on_prepare=remember_database,
                                                          friend_owner=owner.conversation_id),
                        remember_visual=lambda visual: proof.update(visual=visual))
            return 'ready' if attempted else outcome
        except FRIEND_ERRORS as error:
            if attempted:
                state.mark_uncertain(event.id)
                return 'friend_send_uncertain'
            if isinstance(error, ui.DiagnosticTestError) and ui.send_reason(error) in (
                    'title_mismatch', 'send_target_ambiguous', 'send_window_changed', 'send_group_binding_mismatch',
                    'send_owner_binding_mismatch', 'send_friend_binding_mismatch'):
                return 'friend_binding_invalid'
            return outcome


class FriendReplyLane:
    def __init__(self):
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='wechat-friend-read')
        self._read = None
        self._index = 0
        self._next = {}
        self._status = {}
        self._bindings = {}
        self._recovered = set()
        self._uncertain_since = {}
        self._turn = 0

    def close(self):
        self._worker.shutdown(wait=False, cancel_futures=True)

    def status(self, state, default='checking'):
        return [{'status': self._status.get(friend_id, default), 'pending': state.pending_count(binding),
                 'uncertain': len(state.uncertain(binding))} for friend_id, binding in self._bindings.items()]

    def step(self, state, settings, path, runtime, reader, model, priority):
        from wechat_listener import release_unconfirmed

        try:
            friends = enrolled_friends(settings, runtime)
            sources = {}
            for friend in friends.values():
                try:
                    binding, owner, intake = friend_intake(state, settings, runtime, friend)
                    sources[friend.id] = (friend, binding, owner, intake)
                except FRIEND_ERRORS:
                    self._status[friend.id] = 'friend_binding_invalid'
            from wechat_listener import owner_record
            principal = owner_record(settings, runtime)
            self._bindings = {friend.id: friend_binding_key(settings, principal, friend) for friend in friends.values()}
            self._status = {key: value for key, value in self._status.items() if key in self._bindings}
            self._next = {key: value for key, value in self._next.items() if key in self._bindings}
            self._recovered.intersection_update(self._bindings.values())
            for key in set(self._bindings.values()) - self._recovered:
                state.recover_attempted(key)
                self._recovered.add(key)
            state.register_transcript_scopes({binding: ('friend', friend.title) for friend, binding, _, _ in sources.values()})
            if self._read is not None and self._read[2].done():
                key, request, future = self._read
                if key in sources:
                    friend, binding, _, intake = sources[key]
                    try:
                        response = future.result()
                        hear_friend_voices(request, response, reader, settings, priority)
                        result = intake.apply(request, response)
                        if self._status.get(key) not in ('friend_rate_limited', 'friend_reply_unavailable'):
                            self._status[key] = 'ready' if result.statuses.get(binding) in ('ready', 'queue_full') else 'checking'
                    except ReplyYielded:
                        return model
                    except FRIEND_ERRORS as error:
                        self._status[key] = ('friend_binding_invalid' if getattr(error, 'code', '') in
                                             ('friend_binding_invalid', 'friend_binding_ambiguous') else 'friend_database_unavailable')
                self._read = None
            if self._read is None and sources:
                index = self._index % len(sources)
                key = list(sources)[index]
                self._index += 1
                _, binding, owner, intake = sources[key]
                request = intake.request_friend(binding, limit=12)
                self._read = (key, request, self._worker.submit(reader.read, request))
            if not sources:
                return model
            ordered = list(sources)
            for offset in range(len(ordered)):
                position = (self._turn + offset) % len(ordered)
                key = ordered[position]
                friend, binding, owner, intake = sources[key]
                view = self._status.get(key, 'checking')
                if view == 'friend_binding_invalid' or time.monotonic() < self._next.get(key, 0):
                    continue
                if state.uncertain(binding):
                    self._status[key] = 'friend_send_uncertain'
                    release_unconfirmed(state, binding, 'friend', self._uncertain_since)
                    if state.uncertain(binding):
                        reconcile_friend(state, settings, path, runtime, friend, binding, owner, reader)
                        self._next[key] = time.monotonic() + 12
                        break
                queue = state.pending(binding)
                if not queue:
                    continue
                self._turn = (position + 1) % len(ordered)
                event = queue[0]
                created = event.observation['database']['created_at']
                if time.time() - created > FRIEND_QUEUE_WAIT:
                    state.give_up(event.id, 'expired')
                    continue
                if state.skip_limited_friend(event.id, friend.conversation):
                    self._status[key] = 'friend_rate_limited'
                    continue
                try:
                    priority()
                    if not intake.event_authorized(event):
                        self._status[key] = 'friend_binding_invalid'
                        continue
                    if event.status == 'pending':
                        reply, presentation, model = plan_reply(state, friend, binding, event, runtime, model, priority)
                        if reply is None:
                            state.skip(event.id)
                            continue
                        if not state.prepare(event.id, reply, presentation=presentation):
                            continue
                        event = state.pending(binding)[0]
                    self._status[key] = deliver_friend(state, settings, path, runtime, friend, binding, event, priority)
                    self._next[key] = time.monotonic() + (0 if self._status[key] in ('ready', 'checking', 'friend_rate_limited') else 10)
                except ReplyYielded:
                    # The local helper has been shut down before the owner can use the model.
                    return None if model is not None and model.process.poll() is not None else model
                except FRIEND_ERRORS:
                    if model is not None and model.process.poll() is not None:
                        model = None
                    self._status[key] = 'friend_reply_unavailable'
                    self._next[key] = time.monotonic() + 10
                break
            return model
        except (ReplyYielded, *FRIEND_ERRORS):
            for key in self._bindings:
                self._status[key] = 'friend_binding_invalid'
            return model


def reconcile_friend(state, settings, path, runtime, friend, binding, owner, reader):
    for event in state.uncertain(binding):
        proof = (event.observation or {}).get('receipt_proof', {})
        if proof.get('version') != 1 or proof.get('final') is not True:
            continue
        confirmed = False
        if 'visual' in proof:
            try:
                with ui.vm_operation():
                    active = settings_for_friend(settings, friend)
                    ui.open_target(active, path, 'private')
                    window = verify_friend(active, path)
                    messages = ui.conversation_messages(active, path, 'private')
                    confirmed = ui.active_window_id() == window and ui.text_attempt_matches(proof['visual'], messages, settings['account_name'])
            except FRIEND_ERRORS:
                pass
        request = proof.get('database_request')
        if not confirmed and isinstance(request, dict) and all(request.get(key) == value for key, value in (
                ('op', 'send_receipt'), ('account_id', owner.account_id), ('owner_id', owner.conversation_id),
                ('friend_id', friend.conversation), ('kind', 'text'), ('text', event.reply))):
            try:
                receipt = reader.read(request)
                confirmed = receipt.get('account_id') == owner.account_id and receipt.get('status') == 'confirmed'
            except FRIEND_ERRORS:
                pass
        if confirmed and state.reconcile_sent(event.id):
            log('delivery', target='friend', outcome='receipt_reconciled')
