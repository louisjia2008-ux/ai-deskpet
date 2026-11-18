"""Scope follow-up evidence to the owner's selected native groups."""

import json
import sys

from wechat_db_channel import DatabaseReader, DatabaseUnavailable
from wechat_db_guest import FOLLOWUP_WINDOW
from wechat_digest_groups import LOCK_WAIT, MAX_REQUEST, current_pins, valid_id, validate_selection
from wechat_group_policy import group_policy_lock, private_json
from wechat_service import _replace_private, is_paused, prepare_runtime
from wechat_state import WeChatState


SELECTION_FILE = 'group-followup-sources.json'


def read_request(value, *, selecting):
    if selecting:
        try:
            return validate_selection(value)
        except DatabaseUnavailable as error:
            raise DatabaseUnavailable('followup_scope_changed') from error
    if (not isinstance(value, dict) or set(value) != {'binding', 'id', 'since', 'until'}
            or not valid_id(value['binding']) or not valid_id(value['id'])
            or type(value['since']) is not int or type(value['until']) is not int
            or not 0 <= value['since'] < value['until'] or value['until'] - value['since'] > FOLLOWUP_WINDOW):
        raise DatabaseUnavailable('followup_scope_changed')
    return value


def followup_groups(action, settings, runtime, database, value, reader=None):
    if action not in ('followup-group-select', 'followup-group-read'):
        raise DatabaseUnavailable('followup_scope_changed')
    selecting = action == 'followup-group-select'
    value = read_request(value, selecting=selecting)
    with group_policy_lock(runtime, wait=LOCK_WAIT), WeChatState(database, read_only=True) as state:
        binding, private, reply_groups = current_pins(state, settings, runtime)
        if value['binding'] != binding:
            raise DatabaseUnavailable('followup_scope_changed')
        selection_path = prepare_runtime(runtime) / SELECTION_FILE
        scope = {'account_id': private.account_id, 'owner_id': private.conversation_id, 'group_ids': reply_groups}
        reader = reader or DatabaseReader()
        if selecting:
            if value['ids']:
                result = reader.read({'op': 'digest_group_list', **scope})
                if (result.get('account_id') != private.account_id
                        or not set(value['ids']) <= {group['id'] for group in result['groups']}):
                    raise DatabaseUnavailable('followup_scope_changed')
            _replace_private(selection_path, json.dumps(value, separators=(',', ':')).encode('ascii'), durable=True)
            return {'ok': True}
        selected = read_request(private_json(selection_path, MAX_REQUEST, None), selecting=True)
        if is_paused(runtime) or selected['binding'] != binding or value['id'] not in selected['ids']:
            raise DatabaseUnavailable('followup_scope_changed')
        result = reader.read({'op': 'followup_group_read', **scope, 'id': value['id'],
                              'since': value['since'], 'until': value['until']})
        if result.get('account_id') != private.account_id or is_paused(runtime):
            raise DatabaseUnavailable('followup_scope_changed')
        return {'rows': result['rows'], 'truncated': result['truncated']}


def followup_group_control(action, settings, runtime, database):
    source = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(source) > MAX_REQUEST:
        raise DatabaseUnavailable('followup_scope_changed')
    result = followup_groups(action, settings, runtime, database, json.loads(source))
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
