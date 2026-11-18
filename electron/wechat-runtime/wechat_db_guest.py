"""Read an authenticated snapshot of the running guest's official WeChat profile.

The account layout and SQLCipher/WAL routines are adapted from weSkill
(cc8c239e9d996f62c2063aff7bcd39b32ac1d7e2, MIT).
https://github.com/cyrus-xc/weskill

MIT License

Copyright (c) 2026 weskill contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

import base64
from contextlib import contextmanager
import ctypes
import heapq
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import resource
import sqlite3
import stat
import struct
import sys
import time
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import xml.etree.ElementTree as ET


EXPECTED_SHA = '71e22a172018bf250b7b70493382bf55024727144eb7f13cf9b312cdf02e5bbc'
EXE = '/opt/wechat/wechat'
PAGE_SIZE = 4096
RESERVE = 80
IV_OFFSET = PAGE_SIZE - RESERVE
MAC_OFFSET = IV_OFFSET + 16
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_REQUEST_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_GROUPS = 12
MAX_SHARDS = 64
MAX_ROWS = 100
MAX_CONTROLS = 32
CONTROL_RESERVE = 40 * 1024
CONTROL_LOOKAHEAD = 2048
QUEUE_COMMANDS = {'/queue', '/pause-queue', '/resume-queue', '/cancel-queue'}
MAX_TIMESTAMP = 2**53 - 1
ACCOUNT_DIRECTORY = re.compile(r'(wxid_[A-Za-z0-9_.-]{1,120})_[0-9a-fA-F]{4}')
WECHAT_ID = re.compile(r'[A-Za-z0-9_.-]{1,128}(?:@chatroom)?')
DATABASE_SHARD = re.compile(r'message_[0-9]{1,5}\.db')
GENERATION = re.compile(r'[0-9a-f]{32}')


class LocalDataError(RuntimeError):
    """Known failures carry public error codes only."""


def start_token(proc):
    return (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19]


def active_account(proc, root):
    accounts = set()
    for descriptor in (proc / 'fd').iterdir():
        try:
            relative = Path(os.readlink(descriptor)).relative_to(root)
        except (OSError, ValueError):
            continue
        if (len(relative.parts) >= 3 and relative.parts[1] == 'db_storage'
                and ACCOUNT_DIRECTORY.fullmatch(relative.parts[0])):
            accounts.add(relative.parts[0])
    if len(accounts) != 1:
        raise LocalDataError('account_unavailable')
    return accounts.pop()


def client_mask(proc):
    with (proc / 'exe').open('rb') as binary:
        if not hmac.compare_digest(hashlib.file_digest(binary, 'sha256').hexdigest(), EXPECTED_SHA):
            raise LocalDataError('unsupported_wechat_build')
        binary.seek(0)
        elf = binary.read(64)
        if elf[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', elf, 18)[0] != 183:
            raise LocalDataError('unsupported_wechat_build')
        binary.seek(struct.unpack_from('<Q', elf, 32)[0])
        size, count = struct.unpack_from('<HH', elf, 54)
        headers = [struct.unpack_from('<IIQQQQQQ', binary.read(size)) for _ in range(count)]
        mask = bytearray()
        for address in (0x1589fb0, 0x158c770):
            for kind, _, offset, virtual, _, length, _, _ in headers:
                if kind == 1 and virtual <= address and address + 16 <= virtual + length:
                    binary.seek(offset + address - virtual)
                    mask.extend(binary.read(16))
                    break
        if len(mask) != 32:
            raise LocalDataError('unsupported_wechat_build')
        return mask


def read_account_field(proc, mask):
    base = None
    regions = []
    for line in (proc / 'maps').read_text().splitlines():
        fields = line.split(maxsplit=5)
        low, high = (int(part, 16) for part in fields[0].split('-'))
        if fields[1].startswith('r'):
            regions.append((low, high))
        if len(fields) == 6 and fields[5] == EXE and int(fields[2], 16) == 0:
            base = low
    if base is None:
        raise LocalDataError('process_changed')

    memory = os.open(proc / 'mem', os.O_RDONLY | os.O_CLOEXEC)
    try:
        def read(address, length):
            if length > 32 or not any(lo <= address and address + length <= hi for lo, hi in regions):
                raise LocalDataError('unsupported_account_layout')
            data = os.pread(memory, length, address)
            if len(data) != length:
                raise LocalDataError('process_changed')
            return data

        def pointer(address):
            return struct.unpack('<Q', read(address, 8))[0]

        service = pointer(base + 0xa68fbc0)
        if pointer(service) != base + 0xa1db1c0:
            raise LocalDataError('unsupported_account_layout')
        account = pointer(service + 0x68)
        if pointer(account) != base + 0xa1e8d68:
            raise LocalDataError('unsupported_account_layout')
        field = account + 0x258
        header = read(field, 24)
        if not header[0] & 1 or struct.unpack_from('<Q', header, 8)[0] != 32:
            raise LocalDataError('account_unavailable')
        address = struct.unpack_from('<Q', header, 16)[0]
        masked = read(address, 32)
        if (read(field, 24) != header or read(address, 32) != masked
                or pointer(service + 0x68) != account or pointer(base + 0xa68fbc0) != service):
            raise LocalDataError('process_changed')
        return bytes(value ^ mask[index] for index, value in enumerate(masked))
    finally:
        os.close(memory)


def bootstrap():
    """Read one fixed-size account field and close /proc before dropping sudo."""
    if os.geteuid() != 0:
        raise LocalDataError('sudo_required')
    uid = int(os.environ.get('SUDO_UID', '0'))
    if uid <= 0 or sys.platform != 'linux' or os.uname().machine != 'aarch64':
        raise LocalDataError('unsupported_guest')
    user = pwd.getpwuid(uid)
    matches = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid == uid and os.readlink(entry / 'exe') == EXE:
                matches.append(entry)
        except OSError:
            continue
    if len(matches) != 1:
        raise LocalDataError('wechat_process_unavailable')
    proc, = matches
    root = Path(user.pw_dir) / 'xwechat_files'
    token = start_token(proc)
    directory = active_account(proc, root)
    password = read_account_field(proc, client_mask(proc))
    if (token != start_token(proc) or os.readlink(proc / 'exe') != EXE
            or active_account(proc, root) != directory):
        raise LocalDataError('process_changed')
    os.setgroups([])
    os.setresgid(user.pw_gid, user.pw_gid, user.pw_gid)
    os.setresuid(uid, uid, uid)
    if os.getresuid() != (uid,) * 3 or os.getresgid() != (user.pw_gid,) * 3:
        raise LocalDataError('privilege_drop_failed')

    storage = root / directory / 'db_storage'
    if storage.resolve(strict=True) != storage:
        raise LocalDataError('unexpected_database_path')
    account_id = ACCOUNT_DIRECTORY.fullmatch(directory).group(1)
    return storage, account_id, password


class Keys:
    def __init__(self, password):
        self.password = password
        self.by_salt = {}

    def for_salt(self, salt):
        if salt not in self.by_salt:
            key = hashlib.pbkdf2_hmac('sha512', self.password, salt, 256000, 32)
            mac_salt = bytes(value ^ 0x3a for value in salt)
            mac_key = hashlib.pbkdf2_hmac('sha512', key, mac_salt, 2, 32)
            self.by_salt[salt] = key, mac_key
        return self.by_salt[salt]


def signature(value):
    if not stat.S_ISREG(value.st_mode) or value.st_size > MAX_FILE_BYTES:
        raise LocalDataError('unsupported_database_file')
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def path_signature(path):
    try:
        return signature(path.lstat())
    except FileNotFoundError:
        return None


def read_frozen_file(path, expected):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC), 'rb') as stream:
        if signature(os.fstat(stream.fileno())) != expected:
            raise LocalDataError('snapshot_changed')
        content = stream.read(expected[2] + 1)
        if len(content) != expected[2] or signature(os.fstat(stream.fileno())) != expected:
            raise LocalDataError('snapshot_changed')
        return content


def read_snapshot(path):
    if path.parent.resolve(strict=True) != path.parent:
        raise LocalDataError('unexpected_database_path')
    wal = path.with_name(path.name + '-wal')
    database_sig, wal_sig = path_signature(path), path_signature(wal)
    if database_sig is None or database_sig[2] < PAGE_SIZE or database_sig[2] % PAGE_SIZE:
        raise LocalDataError('unsupported_database_file')
    database = read_frozen_file(path, database_sig)
    log = read_frozen_file(wal, wal_sig) if wal_sig is not None else b''
    if (database_sig, wal_sig) != (path_signature(path), path_signature(wal)):
        raise LocalDataError('snapshot_changed')
    return database, log


def wal_checksum(data, order, state=(0, 0)):
    low, high = state
    for a, b in struct.iter_unpack(order + 'II', data):
        low = (low + a + high) & 0xffffffff
        high = (high + b + low) & 0xffffffff
    return low, high


def committed_wal(log):
    if not log:
        return {}, None
    if len(log) < 32:
        raise LocalDataError('unsupported_wal')
    magic, version, page_size = struct.unpack_from('>III', log)
    if magic not in (0x377f0682, 0x377f0683) or version != 3007000 or page_size != PAGE_SIZE:
        raise LocalDataError('unsupported_wal')
    order = '<' if magic == 0x377f0682 else '>'
    state = wal_checksum(log[:24], order)
    if state != struct.unpack_from('>II', log, 24):
        raise LocalDataError('wal_header_authentication_failed')
    committed, pending = {}, {}
    database_size = None
    frame_size = 24 + PAGE_SIZE
    for offset in range(32, len(log) - frame_size + 1, frame_size):
        header = log[offset:offset + 24]
        number, size = struct.unpack_from('>II', header)
        if not number or header[8:16] != log[16:24]:
            break
        page = memoryview(log)[offset + 24:offset + frame_size]
        state = wal_checksum(page, order, wal_checksum(header[:8], order, state))
        if state != struct.unpack_from('>II', header, 16):
            break
        pending[number] = page
        if size:
            committed.update(pending)
            pending.clear()
            # A shrink discards older frames beyond the new physical size.
            committed = {number: page for number, page in committed.items() if number <= size}
            database_size = size
    return committed, database_size


def clear_page(page, number, key, mac_key):
    # Import cipher implementations only after dropping sudo.
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    if len(page) != PAGE_SIZE:
        raise LocalDataError('page_authentication_failed')
    start = 16 if number == 1 else 0
    digest = hmac.new(mac_key, page[start:MAC_OFFSET], hashlib.sha512)
    digest.update(struct.pack('<I', number))
    if not hmac.compare_digest(digest.digest(), page[MAC_OFFSET:]):
        raise LocalDataError('page_authentication_failed')
    aes = Cipher(algorithms.AES(key), modes.CBC(bytes(page[IV_OFFSET:MAC_OFFSET]))).decryptor()
    body = aes.update(page[start:IV_OFFSET]) + aes.finalize()
    prefix = b'SQLite format 3\0' if number == 1 else b''
    return prefix + body + bytes(RESERVE)


def logical_image(database, log, key, mac_key):
    pages, allocated = committed_wal(log)
    main = memoryview(database)
    first = clear_page(main[:PAGE_SIZE], 1, key, mac_key)
    if 1 in pages:
        if pages[1][:16] != main[:16]:
            raise LocalDataError('database_generation_changed')
        first = clear_page(pages[1], 1, key, mac_key)
    if first[16:18] != b'\x10\x00' or first[20] != RESERVE:
        raise LocalDataError('unsupported_database_format')
    main_count = len(main) // PAGE_SIZE
    allocated = main_count if allocated is None else allocated
    # WCDB can preallocate zero pages without increasing SQLite's logical size.
    # When the header change/version fields agree, the authenticated count is
    # authoritative. Otherwise SQLite uses the physical page count.
    count = struct.unpack_from('>I', first, 28)[0] if first[24:28] == first[92:96] else allocated
    if not 1 <= count <= allocated or count > min(MAX_FILE_BYTES // PAGE_SIZE, main_count + len(pages)):
        raise LocalDataError('unsupported_database_page_count')
    if allocated > count and (any(number > count for number in pages)
                             or any(main[count * PAGE_SIZE:])):
        raise LocalDataError('unexpected_preallocated_pages')
    image = bytearray(count * PAGE_SIZE)
    image[:PAGE_SIZE] = first
    for number in range(2, count + 1):
        encrypted = pages.get(number, main[(number - 1) * PAGE_SIZE:number * PAGE_SIZE])
        image[(number - 1) * PAGE_SIZE:number * PAGE_SIZE] = clear_page(encrypted, number, key, mac_key)
    # Only the RAM image is changed. Its WAL has already been replayed.
    image[18:20] = b'\x01\x01'
    return bytes(image)


@contextmanager
def open_logical(path, keys):
    database, log = read_snapshot(path)
    salt = database[:16]
    image = logical_image(database, log, *keys.for_salt(salt))
    del database, log
    db = sqlite3.connect(':memory:')
    try:
        db.deserialize(image)
        del image
        db.execute('PRAGMA temp_store=MEMORY')
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.row_factory = sqlite3.Row
        yield db, salt.hex()
    finally:
        db.close()


def valid_id(value):
    return isinstance(value, str) and WECHAT_ID.fullmatch(value) is not None


def require_id(value, *, group=False):
    if not valid_id(value) or value.endswith('@chatroom') != group:
        raise LocalDataError('invalid_request')
    return value


def safe_name(value):
    if isinstance(value, str) and 0 < len(value) <= 256 and value.isprintable():
        return value
    return None


def require_name(value):
    if not safe_name(value):
        raise LocalDataError('invalid_request')
    return value


def require_list(request, key, maximum):
    value = request.get(key)
    if not isinstance(value, list) or len(value) > maximum:
        raise LocalDataError('invalid_request')
    return value


def select_contact(db, binding, *, group=False):
    if not isinstance(binding, dict) or not binding or set(binding) - {'id', 'title', 'alias'}:
        raise LocalDataError('invalid_request')
    predicates, parameters = [], []
    if 'id' in binding:
        predicates.append('username COLLATE BINARY=?')
        parameters.append(require_id(binding['id'], group=group))
    if 'title' in binding:
        title = require_name(binding['title'])
        predicates.append('(nick_name COLLATE BINARY=? OR remark COLLATE BINARY=?)')
        parameters.extend((title, title))
    if 'alias' in binding:
        alias = require_name(binding['alias'])
        predicates.append('(alias COLLATE BINARY=? OR username COLLATE BINARY=?)')
        parameters.extend((alias, alias))
    predicates.append("username LIKE '%@chatroom'" if group else "username NOT LIKE '%@chatroom'")
    rows = db.execute(
        'SELECT username,nick_name,remark,alias FROM contact WHERE ' + ' AND '.join(predicates) + ' LIMIT 2',
        parameters,
    ).fetchall()
    if len(rows) != 1:
        raise LocalDataError('binding_not_found' if not rows else 'binding_ambiguous')
    row = rows[0]
    identifier = require_id(row['username'], group=group)
    result = {
        'id': identifier,
        'title': binding.get('title') or safe_name(row['remark']) or safe_name(row['nick_name']) or identifier,
    }
    if safe_name(row['alias']):
        result['alias'] = row['alias']
    return result


def validate_scopes(db, account_id, request):
    if request.get('account_id') != account_id:
        raise LocalDataError('account_binding_changed')
    owner = require_id(request.get('owner_id'))
    groups = [require_id(value, group=True) for value in require_list(request, 'group_ids', MAX_GROUPS)]
    if owner == account_id or len(groups) != len(set(groups)):
        raise LocalDataError('invalid_request')
    for identifier in (owner, *groups):
        found = db.execute('SELECT username FROM contact WHERE username COLLATE BINARY=? LIMIT 2', (identifier,)).fetchall()
        if len(found) != 1:
            raise LocalDataError('binding_not_found' if not found else 'binding_ambiguous')
    return owner, sorted(groups)


def protobuf_varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            break
        byte = data[offset]
        value |= (byte & 0x7f) << shift
        offset += 1
        if byte < 0x80:
            return value, offset
    raise ValueError('Invalid varint')


def protobuf_fields(data):
    offset = 0
    while offset < len(data):
        tag, offset = protobuf_varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError('Invalid protobuf field')
        if wire == 0:
            _, offset = protobuf_varint(data, offset)
            continue
        if wire == 2:
            size, offset = protobuf_varint(data, offset)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
        else:
            raise ValueError('Unsupported protobuf field')
        if size > len(data) - offset:
            raise ValueError('Invalid protobuf field length')
        if wire == 2:
            yield number, data[offset:offset + size]
        offset += size


def group_room_names(blob):
    if not blob:
        return {}
    if not isinstance(blob, bytes) or len(blob) > 1024 * 1024:
        raise ValueError('Invalid room metadata')
    names = {}
    # Chat-room data stores repeated member records in field 1. The first
    # string inside each record is the ID, followed by its optional room name.
    for number, member in protobuf_fields(blob):
        if number != 1:
            continue
        fields = {}
        for field, value in protobuf_fields(member):
            if field in (1, 2):
                if field in fields:
                    raise ValueError('Repeated member identity')
                fields[field] = value.decode('utf-8')
        sender = fields.get(1)
        if not valid_id(sender) or sender.endswith('@chatroom') or sender in names:
            raise ValueError('Invalid member identity')
        names[sender] = safe_name(fields.get(2))
    return names


def group_members(db, group_id):
    rooms = db.execute(
        'SELECT id, ext_buffer FROM chat_room WHERE username COLLATE BINARY=? LIMIT 2', (group_id,),
    ).fetchall()
    if len(rooms) != 1:
        return None
    try:
        aliases = group_room_names(rooms[0]['ext_buffer'])
    except ValueError:
        return None
    members = {}
    rows = db.execute(
        'SELECT c.username,c.remark,c.nick_name FROM chatroom_member m JOIN contact c ON c.id=m.member_id '
        'WHERE m.room_id=? LIMIT 10001', (rooms[0]['id'],),
    )
    for row in rows:
        sender = row['username']
        if len(members) >= 10000 or not valid_id(sender) or sender.endswith('@chatroom') or sender in members:
            return None
        members[sender] = tuple(filter(None, (
            aliases.get(sender), safe_name(row['remark']), safe_name(row['nick_name']),
        )))
    # Join aliases only to the room's SQL membership. If stores disagree,
    # name resolution is unavailable for this room; it cannot affect other rooms.
    if not members or (aliases and aliases.keys() != members.keys()):
        return None
    return members


def resolve_senders(db, groups, requests):
    if any(not isinstance(entry, dict) or set(entry) != {'group_id', 'name'} for entry in requests):
        raise LocalDataError('invalid_request')
    result, by_group = [], {}
    for entry in requests:
        group, name = entry['group_id'], require_name(entry['name'])
        if not isinstance(group, str) or group not in groups:
            raise LocalDataError('invalid_request')
        if group not in by_group:
            by_group[group] = group_members(db, group)
        members = by_group[group]
        item = {'group_id': group, 'name': name}
        if members is None:
            item['status'] = 'unavailable'
        else:
            ids = [sender for sender, names in members.items() if name in names]
            item['status'] = 'not_found' if not ids else 'resolved' if len(ids) == 1 else 'ambiguous'
            if len(ids) == 1:
                item['sender_id'] = ids[0]
        result.append(item)
    return result


_zstd = None


def decode_field(value):
    if value is None:
        return ''
    if isinstance(value, str):
        return value if len(value.encode('utf-8')) <= MAX_BODY_BYTES else None
    if not isinstance(value, bytes) or len(value) > MAX_BODY_BYTES:
        return None
    if value.startswith(b'\x28\xb5\x2f\xfd'):
        global _zstd
        if _zstd is None:
            _zstd = ctypes.CDLL('libzstd.so.1')
            _zstd.ZSTD_decompress.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t)
            _zstd.ZSTD_decompress.restype = ctypes.c_size_t
            _zstd.ZSTD_isError.argtypes = (ctypes.c_size_t,)
            _zstd.ZSTD_isError.restype = ctypes.c_uint
        out = ctypes.create_string_buffer(MAX_BODY_BYTES)
        written = _zstd.ZSTD_decompress(out, len(out), value, len(value))
        if _zstd.ZSTD_isError(written):
            return None
        value = out.raw[:written]
    try:
        return value.decode('utf-8')
    except UnicodeError:
        return None


def mention_ids(source):
    xml = decode_field(source)
    if not xml or not xml.lstrip().startswith('<') or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', xml, re.I):
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    # Use only the native msgsource field. Nested XML and message body are not authority.
    if root.tag != 'msgsource':
        return []
    elements = root.findall('atuserlist')
    if len(elements) != 1 or len(elements[0]):
        return []
    identifiers = set(identifier.strip() for identifier in (elements[0].text or '').split(','))
    if len(identifiers) > 1000:
        return []
    return sorted(identifier for identifier in identifiers
                  if identifier == 'notify@all' or (valid_id(identifier) and not identifier.endswith('@chatroom')))


def normalize_message(row, path, conversation, own_id):
    sender = row['sender']
    if not valid_id(sender) or sender.endswith('@chatroom'):
        sender = ''
    if (type(row['local_id']) is not int or not 1 <= row['local_id'] <= MAX_TIMESTAMP
            or type(row['create_time']) is not int or not 0 <= row['create_time'] <= MAX_TIMESTAMP
            or type(row['local_type']) is not int or not 0 <= row['local_type'] <= MAX_TIMESTAMP
            or (row['server_id'] is not None and type(row['server_id']) is not int)):
        raise LocalDataError('unsupported_message_identity')
    raw = decode_field(row['message_content'] or row['compress_content'])
    body = raw
    if body is not None and sender and conversation.endswith('@chatroom'):
        body = body.removeprefix(sender + ':\n')
    identifiers = mention_ids(row['source'])
    result = {
        'conversation_id': conversation,
        'sender_id': sender,
        'local_id': row['local_id'],
        'server_id': str((row['server_id'] or 0) & ((1 << 64) - 1)),
        'database': path.name,
        'created_at': row['create_time'],
        'type': row['local_type'],
        'body': body or '',
        'body_available': body is not None,
        'native_mention_self': own_id in identifiers,
        'mention_ids': identifiers,
    }
    if body != raw:
        result['raw_body'] = raw
    return result


def attach_sender_name(db, row, group_cache):
    sender = row['sender_id']
    if not sender:
        return
    conversation = row['conversation_id']
    if conversation.endswith('@chatroom'):
        if conversation not in group_cache:
            try:
                group_cache[conversation] = group_members(db, conversation)
            except sqlite3.Error:
                group_cache[conversation] = None
        members = group_cache[conversation]
        if members and members.get(sender):
            row['sender_display_name'] = members[sender][0]
            return
    contact = db.execute('SELECT remark,nick_name FROM contact WHERE username COLLATE BINARY=? LIMIT 2', (sender,)).fetchall()
    if len(contact) == 1:
        name = safe_name(contact[0]['remark']) or safe_name(contact[0]['nick_name'])
        if name:
            row['sender_display_name'] = name


def message_shards(storage):
    paths = sorted(path for path in (storage / 'message').glob('message_*.db')
                   if DATABASE_SHARD.fullmatch(path.name))
    if not paths or len(paths) > MAX_SHARDS:
        raise LocalDataError('unsupported_shard_count')
    return paths


def cursor_state(request, expected):
    baseline = request.get('baseline', False)
    limit = request.get('limit', MAX_ROWS)
    if type(baseline) is not bool or type(limit) is not int or not 1 <= limit <= MAX_ROWS:
        raise LocalDataError('invalid_request')
    prior = request.get('cursors', {})
    if not isinstance(prior, dict) or (baseline and prior):
        raise LocalDataError('invalid_request')
    if not baseline and set(prior) != expected:
        raise LocalDataError('cursor_scope_changed')
    for entry in prior.values():
        if (not isinstance(entry, dict) or set(entry) != {'generation', 'local_id'}
                or not isinstance(entry['generation'], str) or not GENERATION.fullmatch(entry['generation'])
                or type(entry['local_id']) is not int or not 0 <= entry['local_id'] <= MAX_TIMESTAMP):
            raise LocalDataError('invalid_request')
    return baseline, prior, limit


def table_for(conversation):
    return 'Msg_' + hashlib.md5(conversation.encode('utf-8'), usedforsecurity=False).hexdigest()


def table_exists(db, table):
    return db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone() is not None


def table_maximum(db, table):
    maximum = db.execute(f'SELECT MAX(local_id) FROM "{table}"').fetchone()[0] if table_exists(db, table) else None
    if maximum is None:
        return 0
    if type(maximum) is not int or not 0 <= maximum <= MAX_TIMESTAMP:
        raise LocalDataError('unsupported_message_identity')
    return maximum


def json_payload(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def row_order(row):
    return row['created_at'], row['database'], row['local_id'], row['conversation_id']


def queue_controls(db, table, path, owner, own_id, position):
    # A paused/full normal queue can hold the cursor. Search beyond it for
    # owner-only controls without declaring the ordinary messages observed.
    candidates = db.execute(
        f'SELECT m.local_id,m.server_id,n.user_name AS sender,m.local_type,m.create_time, '
        f'm.message_content,m.compress_content,NULL AS source '
        f'FROM "{table}" m JOIN Name2Id n ON m.real_sender_id=n.rowid '
        f'WHERE m.local_id>? AND n.user_name COLLATE BINARY=? AND m.local_type=1 '
        f'AND COALESCE(length(CAST(m.message_content AS BLOB)),0)<=? '
        f'AND COALESCE(length(CAST(m.compress_content AS BLOB)),0)<=? '
        f'ORDER BY m.local_id DESC LIMIT ?', (position, owner, 256, 256, CONTROL_LOOKAHEAD),
    )
    for item in candidates:
        raw = decode_field(item['message_content'] or item['compress_content'])
        if raw and len(raw) <= 80 and raw.strip().lower() in QUEUE_COMMANDS:
            yield normalize_message(item, path, owner, own_id)


def poll(storage, keys, contact_db, own_id, scopes, request, *, friend=None):
    paths = message_shards(storage)
    friend_key = request['friend_id'] if friend is not None else None
    expected = {f'{path.name}/{friend_key or scope}' for path in paths for scope in scopes}
    baseline, prior, limit = cursor_state(request, expected)
    rows, controls, cursors, group_cache, has_more = [], [], {}, {}, False
    cursor_bound = {identity: {'generation': '0' * 32, 'local_id': MAX_TIMESTAMP} for identity in expected}
    reserve = 1024 if baseline else CONTROL_RESERVE
    max_row_bytes = MAX_RESPONSE_BYTES - len(json_payload(cursor_bound)) - reserve
    remaining_bytes = max_row_bytes
    for path in paths:
        with open_logical(path, keys) as (db, generation):
            for conversation in scopes:
                identity = f'{path.name}/{friend_key or conversation}'
                table = table_for(conversation)
                maximum = table_maximum(db, table)
                position = maximum if baseline else prior[identity]['local_id']
                if not baseline and (prior[identity]['generation'] != generation or position > maximum):
                    raise LocalDataError('cursor_generation_changed')
                cursors[identity] = {'generation': generation, 'local_id': position}
                if position == maximum:
                    continue
                if friend is None and conversation == scopes[0]:
                    candidates = queue_controls(db, table, path, conversation, own_id, position)
                    controls = heapq.nlargest(MAX_CONTROLS, (*controls, *candidates), key=row_order)
                available = limit - len(rows)
                if not available:
                    has_more = True
                    continue
                result = db.execute(
                    f'SELECT m.local_id,m.server_id,n.user_name AS sender,m.local_type,m.create_time,'
                    f'CASE WHEN length(CAST(m.message_content AS BLOB)) <= ? THEN m.message_content END AS message_content,'
                    f'CASE WHEN length(CAST(m.compress_content AS BLOB)) <= ? THEN m.compress_content END AS compress_content,'
                    f'CASE WHEN length(CAST(m.source AS BLOB)) <= ? THEN m.source END AS source,'
                    f'MAX(COALESCE(length(CAST(m.message_content AS BLOB)),0), '
                    f'COALESCE(length(CAST(m.compress_content AS BLOB)),0)) AS payload_size '
                    f'FROM "{table}" m LEFT JOIN Name2Id n ON m.real_sender_id=n.rowid '
                    f'WHERE m.local_id>? ORDER BY m.local_id LIMIT ?',
                    (MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_BODY_BYTES, position, available),
                )
                for item in result:
                    if item['local_id'] <= cursors[identity]['local_id']:
                        raise LocalDataError('unsupported_message_identity')
                    row = normalize_message(item, path, conversation, own_id)
                    if item['payload_size'] > MAX_BODY_BYTES:
                        row.update(body='', body_available=False)
                        row.pop('raw_body', None)
                    if friend is None:
                        attach_sender_name(contact_db, row, group_cache)
                    else:
                        incoming = row['sender_id'] == friend
                        row['conversation_id'] = friend_key
                        row['sender_id'] = friend_key if incoming else own_id if row['sender_id'] == own_id else ''
                        row['mention_ids'] = []
                        row['native_mention_self'] = False
                        if not incoming:
                            row.update(body='', body_available=False)
                            row.pop('raw_body', None)
                    row_bytes = len(json_payload(row)) + 1
                    if row_bytes > max_row_bytes:
                        row.update(body='', body_available=False)
                        row.pop('raw_body', None)
                        row_bytes = len(json_payload(row)) + 1
                    if row_bytes > remaining_bytes:
                        break
                    rows.append(row)
                    remaining_bytes -= row_bytes
                    cursors[identity]['local_id'] = row['local_id']
                has_more |= cursors[identity]['local_id'] < maximum
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    rows.sort(key=row_order)
    result = {'rows': rows, 'cursors': cursors, 'has_more': has_more}
    ordinary = {(row['database'], row['local_id']) for row in rows if row['conversation_id'] == scopes[0]}
    lookahead = [row for row in sorted(controls, key=row_order)
                 if (row['database'], row['local_id']) not in ordinary]
    if lookahead:
        result['controls'] = lookahead
    return result


def attest(storage, keys, own_id, groups, witnesses):
    """Match a bounded set of exact, already visible group texts without exporting history."""
    unmatched = {}
    for witness in witnesses:
        if not isinstance(witness, dict) or set(witness) != {'group_id', 'bodies'}:
            raise LocalDataError('invalid_request')
        group, bodies = witness['group_id'], witness['bodies']
        if (not isinstance(group, str) or group not in groups or group in unmatched
                or not isinstance(bodies, list) or not 1 <= len(bodies) <= 8
                or any(not isinstance(body, str) or not 1 <= len(body) <= 2000 for body in bodies)
                or len(bodies) != len(set(bodies))):
            raise LocalDataError('invalid_request')
        unmatched[group] = set(bodies)
    paths = message_shards(storage)
    for path in paths:
        if not any(unmatched.values()):
            break
        with open_logical(path, keys) as (db, _):
            for group, bodies in unmatched.items():
                table = table_for(group)
                if not bodies or not table_exists(db, table):
                    continue
                result = db.execute(
                    f'SELECT m.message_content,m.compress_content,n.user_name AS sender '
                    f'FROM "{table}" m LEFT JOIN Name2Id n ON m.real_sender_id=n.rowid '
                    f'WHERE (m.local_type & 4294967295)=1 '
                    f'AND COALESCE(length(CAST(m.message_content AS BLOB)),0)<=? '
                    f'AND COALESCE(length(CAST(m.compress_content AS BLOB)),0)<=? '
                    f'ORDER BY m.local_id DESC LIMIT 50', (MAX_BODY_BYTES, MAX_BODY_BYTES),
                )
                for row in result:
                    sender = row['sender']
                    body = decode_field(row['message_content'] or row['compress_content'])
                    if valid_id(sender) and sender != own_id and body:
                        bodies.discard(body.removeprefix(sender + ':\n'))
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    return [{'group_id': group, 'matched': not missing} for group, missing in unmatched.items()]


OP_FIELDS = {
    'discover': {'op', 'owner', 'groups'},
    'poll': {'op', 'account_id', 'owner_id', 'group_ids', 'baseline', 'cursors', 'limit'},
    'friend_list': {'op', 'account_id', 'owner_id'},
    'friend_verify': {'op', 'account_id', 'owner_id', 'friend_id', 'title', 'alias'},
    'friend_poll': {'op', 'account_id', 'owner_id', 'friend_id', 'baseline', 'cursors', 'limit'},
    'resolve_senders': {'op', 'account_id', 'owner_id', 'group_ids', 'requests'},
    'attest': {'op', 'account_id', 'owner_id', 'group_ids', 'witnesses'},
    'own_moments': {'op', 'since'},
    'own_sent': {'op', 'conversation', 'since', 'text'},
    'send_baseline': {'op', 'account_id', 'conversation', 'owner_id', 'friend_id'},
    'send_receipt': {'op', 'account_id', 'conversation', 'owner_id', 'friend_id', 'cursors', 'since', 'kind', 'text', 'quoted_server_id'},
    'owner_activity': {'op', 'account_id', 'owner_id'},
    'voice_baseline': {'op', 'account_id', 'owner_id'},
    'voice_receipt': {'op', 'account_id', 'owner_id', 'since', 'cursors', 'expected_duration_ms'},
    'voice_audio': {'op', 'account_id', 'owner_id', 'server_id', 'friend_id'},
    'digest_group_list': {'op', 'account_id', 'owner_id', 'group_ids'},
    'digest_group_read': {'op', 'account_id', 'owner_id', 'group_ids', 'id', 'until'},
    'followup_group_read': {'op', 'account_id', 'owner_id', 'group_ids', 'id', 'since', 'until'},
    'official_list': {'op', 'account_id', 'owner_id'},
    'official_read': {'op', 'account_id', 'owner_id', 'ids', 'until'},
    'friends_moments_read': {'op', 'account_id', 'owner_id', 'until', 'days'},
}
MAX_SENT_LOOKUP = 20
MAX_VOICE_DURATION_MS = 61_000
VOICE_DURATION_TOLERANCE_MS = 2_000


def voice_duration_ms(value):
    raw = decode_field(value)
    if not raw or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', raw, re.I):
        return None
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None
    if root.tag not in ('msg', 'voicemsg'):
        return None
    voice = [root] if root.tag == 'voicemsg' else root.findall('voicemsg')
    if len(voice) != 1:
        return None
    duration = voice[0].get('voicelength', '')
    if not re.fullmatch(r'[0-9]{1,5}', duration):
        return None
    duration = int(duration)
    return duration if 0 < duration <= MAX_VOICE_DURATION_MS else None


def own_voice(storage, keys, account_id, owner_id, request):
    """Observe metadata only, confined to the bound private conversation."""
    paths = message_shards(storage)
    baseline = request['op'] == 'voice_baseline'
    if baseline:
        since = int(time.time())
        prior = {}
    else:
        since, expected_duration = request.get('since'), request.get('expected_duration_ms')
        if (type(since) is not int or not 0 <= since <= MAX_TIMESTAMP
                or type(expected_duration) is not int or not 0 < expected_duration <= MAX_VOICE_DURATION_MS):
            raise LocalDataError('invalid_request')
        _, prior, _ = cursor_state(request, {f'{path.name}/{owner_id}' for path in paths})
    cursors, candidates = {}, []
    table = table_for(owner_id)
    for path in paths:
        identity = f'{path.name}/{owner_id}'
        with open_logical(path, keys) as (db, generation):
            maximum = table_maximum(db, table)
            if baseline:
                cursors[identity] = {'generation': generation, 'local_id': maximum}
                continue
            previous = prior[identity]
            if previous['generation'] != generation or previous['local_id'] > maximum:
                raise LocalDataError('cursor_generation_changed')
            if previous['local_id'] == maximum or len(candidates) >= 2:
                continue
            candidates.extend(db.execute(
                f'SELECT m.server_id,'
                f'CASE WHEN length(CAST(m.message_content AS BLOB)) <= ? THEN m.message_content END AS body,'
                f'CASE WHEN length(CAST(m.compress_content AS BLOB)) <= ? THEN m.compress_content END AS compressed '
                f'FROM "{table}" m JOIN Name2Id n ON m.real_sender_id=n.rowid '
                f'WHERE m.local_id>? AND m.create_time>=? AND (m.local_type & 4294967295)=34 '
                f'AND n.user_name COLLATE BINARY=? ORDER BY m.local_id LIMIT ?',
                (MAX_BODY_BYTES, MAX_BODY_BYTES, previous['local_id'], since, account_id, 2 - len(candidates)),
            ).fetchall())
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    if baseline:
        return {'cursors': cursors, 'since': since}
    if not candidates:
        return {'status': 'pending'}
    if len(candidates) != 1:
        return {'status': 'ambiguous'}
    row, = candidates
    if row['server_id'] is None or row['server_id'] == 0:
        return {'status': 'pending'}
    if type(row['server_id']) is not int:
        raise LocalDataError('unsupported_message_identity')
    duration = voice_duration_ms(row['body']) or voice_duration_ms(row['compressed'])
    receipt = {'server_id': str(row['server_id'] & ((1 << 64) - 1)), 'duration_ms': duration}
    if duration is None:
        return receipt | {'status': 'duration_unavailable'}
    if abs(duration - expected_duration) > VOICE_DURATION_TOLERANCE_MS:
        return receipt | {'status': 'duration_mismatch'}
    return receipt | {'status': 'confirmed'}


MEDIA_SHARD = re.compile(r'media_[0-9]{1,5}\.db')
MAX_VOICE_BYTES = 512 * 1024
MAX_VOICE_PARTS = 16


def voice_audio(storage, keys, owner_id, server_id):
    """One voice message's stored audio, only from the bound private conversation."""
    if not isinstance(server_id, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', server_id) or int(server_id) >= 1 << 64:
        raise LocalDataError('invalid_request')
    unsigned = int(server_id)
    # SQLite keeps the 64-bit server id signed.
    signed = unsigned - (1 << 64) if unsigned >= 1 << 63 else unsigned
    paths = sorted(path for path in (storage / 'message').glob('media_*.db') if MEDIA_SHARD.fullmatch(path.name))
    if len(paths) > MAX_SHARDS:
        raise LocalDataError('unsupported_shard_count')
    for path in paths:
        with open_logical(path, keys) as (db, _):
            if not table_exists(db, 'VoiceInfo'):
                continue
            parts = db.execute(
                'SELECT v.data_index, CASE WHEN length(v.voice_data) <= ? THEN v.voice_data END AS data '
                'FROM VoiceInfo v JOIN Name2Id n ON v.chat_name_id = n.rowid '
                'WHERE v.svr_id = ? AND n.user_name COLLATE BINARY = ? ORDER BY v.data_index LIMIT ?',
                (MAX_VOICE_BYTES, signed, owner_id, MAX_VOICE_PARTS + 1),
            ).fetchall()
            if not parts:
                continue
            if len(parts) > MAX_VOICE_PARTS or any(type(part['data']) is not bytes for part in parts):
                raise LocalDataError('voice_too_large')
            audio = b''.join(part['data'] for part in parts)
            if len(audio) > MAX_VOICE_BYTES:
                raise LocalDataError('voice_too_large')
            return {'status': 'ready', 'audio': base64.b64encode(audio).decode('ascii')}
    # WeChat may still be downloading it.
    return {'status': 'pending'}


def owner_activity(storage, keys, owner):
    """Latest message time in the validated owner session, either direction; no content or IDs."""
    table = table_for(owner)
    paths = message_shards(storage)
    latest = None
    for path in paths:
        with open_logical(path, keys) as (db, _):
            if not table_exists(db, table):
                continue
            at = db.execute(f'SELECT MAX(create_time) FROM "{table}"').fetchone()[0]
            if at is None:
                continue
            if type(at) is not int or not 0 < at <= MAX_TIMESTAMP:
                raise LocalDataError('invalid_message_timestamp')
            latest = max(latest or 0, at)
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    return {'ok': True, 'at': latest}


def own_sent(storage, keys, account_id, conversation, since, text):
    """Whether this account sent exactly `text` in one conversation at or after `since`.
    Answers only yes or no; no history leaves the guest."""
    if (not valid_id(conversation) or type(since) is not int or not 0 <= since <= MAX_TIMESTAMP
            or not isinstance(text, str) or not 1 <= len(text.encode('utf-8')) <= MAX_BODY_BYTES):
        raise LocalDataError('invalid_request')
    table = table_for(conversation)
    paths = message_shards(storage)
    found = False
    for path in paths:
        if found:
            break
        with open_logical(path, keys) as (db, _):
            if not table_exists(db, table):
                continue
            rows = db.execute(
                f'SELECT m.message_content,m.compress_content,n.user_name AS sender '
                f'FROM "{table}" m LEFT JOIN Name2Id n ON m.real_sender_id=n.rowid '
                f'WHERE (m.local_type & 4294967295)=1 AND m.create_time>=? '
                f'AND COALESCE(length(CAST(m.message_content AS BLOB)),0)<=? '
                f'AND COALESCE(length(CAST(m.compress_content AS BLOB)),0)<=? '
                f'ORDER BY m.local_id DESC LIMIT ?', (since, MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_SENT_LOOKUP),
            )
            for row in rows:
                body = decode_field(row['message_content'] or row['compress_content'])
                if row['sender'] == account_id and body is not None and body.removeprefix(account_id + ':\n') == text:
                    found = True
                    break
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    return found


SEND_KINDS = {'text': (1,), 'quote': (49,), 'image': (3,), 'sticker': (47,)}


def send_quote_matches(body, text, source_id):
    if not body or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', body, re.I):
        return False
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, UnicodeError, ValueError):
        return False
    cards = root.findall('appmsg') if root.tag == 'msg' else []
    if len(cards) != 1:
        return False
    card, = cards
    for name, expected in (('type', '57'), ('title', text), ('refermsg/svrid', source_id)):
        fields = card.findall(name)
        if len(fields) != 1 or fields[0].text != expected:
            return False
    return True


def own_send_receipt(storage, keys, account_id, request, *, friend=None):
    """Pin each shard and require one additional outgoing row in the same session."""
    conversation = friend if friend is not None else request.get('conversation')
    cursor_scope = request['friend_id'] if friend is not None else conversation
    if request.get('account_id') != account_id or not valid_id(conversation) or conversation == account_id:
        raise LocalDataError('account_binding_changed')
    paths = message_shards(storage)
    baseline = request['op'] == 'send_baseline'
    if baseline:
        since, prior = int(time.time()), {}
    else:
        since = request.get('since')
        kind, text = request.get('kind'), request.get('text')
        source_id = request.get('quoted_server_id')
        if (type(since) is not int or not 0 <= since <= MAX_TIMESTAMP
                or not isinstance(kind, str) or kind not in SEND_KINDS
                or (kind in ('text', 'quote') and (
                    not isinstance(text, str) or not 1 <= len(text.encode('utf-8')) <= MAX_BODY_BYTES))
                or (kind == 'quote' and (not isinstance(source_id, str)
                    or not re.fullmatch(r'[1-9][0-9]{0,19}', source_id) or int(source_id) >= 1 << 64))
                or (kind != 'quote' and source_id is not None)):
            raise LocalDataError('invalid_request')
        _, prior, _ = cursor_state(request, {f'{path.name}/{cursor_scope}' for path in paths})
    cursors, rows = {}, []
    table = table_for(conversation)
    for path in paths:
        identity = f'{path.name}/{cursor_scope}'
        with open_logical(path, keys) as (db, generation):
            maximum = table_maximum(db, table)
            if baseline:
                cursors[identity] = {'generation': generation, 'local_id': maximum}
                continue
            previous = prior[identity]
            if previous['generation'] != generation or previous['local_id'] > maximum:
                raise LocalDataError('cursor_generation_changed')
            if previous['local_id'] == maximum or len(rows) >= 2:
                continue
            rows.extend(db.execute(
                f'SELECT m.server_id,m.local_type,'
                f'CASE WHEN length(CAST(m.message_content AS BLOB)) <= ? THEN m.message_content END AS body,'
                f'CASE WHEN length(CAST(m.compress_content AS BLOB)) <= ? THEN m.compress_content END AS compressed '
                f'FROM "{table}" m JOIN Name2Id n ON m.real_sender_id=n.rowid '
                f'WHERE m.local_id>? AND m.create_time>=? '
                f'AND (m.local_type & 4294967295)=? AND n.user_name COLLATE BINARY=? '
                f'ORDER BY m.local_id LIMIT ?',
                (MAX_BODY_BYTES, MAX_BODY_BYTES, previous['local_id'], max(0, since - 2), SEND_KINDS[kind][0],
                 account_id, 2 - len(rows)),
            ))
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    if baseline:
        return {'cursors': cursors, 'since': since}
    if not rows:
        return {'status': 'pending'}
    if len(rows) > 1:
        return {'status': 'ambiguous'}
    row, = rows
    if type(row['server_id']) is not int or row['server_id'] == 0:
        return {'status': 'pending'}
    if kind in ('text', 'quote'):
        body = (decode_field(row['body']) or decode_field(row['compressed']) or '').removeprefix(account_id + ':\n')
        if kind == 'text' and (row['local_type'] != 1 or body != text):
            return {'status': 'mismatch'}
        if kind == 'quote' and (row['local_type'] >> 32 not in (0, 57)
                                or not send_quote_matches(body, text, source_id)):
            return {'status': 'mismatch'}
    return {'status': 'confirmed'}


MAX_OWN_MOMENTS = 5


def own_moments(storage, keys, account_id, since):
    """This account's Moments at or after `since` (epoch seconds): the synced timeline and
    publish records that the server has already given an ID."""
    if type(since) is not int or not 0 <= since <= MAX_TIMESTAMP:
        raise LocalDataError('invalid_request')
    found = []

    def parse(raw):
        raw = decode_field(raw) if isinstance(raw, bytes) else raw
        if not isinstance(raw, str) or len(raw) > MAX_BODY_BYTES:
            return None
        try:
            return ET.fromstring(raw)
        except ET.ParseError:
            return None

    with open_logical(storage / 'sns/sns.db', keys) as (db, _):
        timeline = db.execute('SELECT content FROM SnsTimeLine WHERE user_name = ? ORDER BY tid DESC LIMIT ?',
                              (account_id, MAX_OWN_MOMENTS)).fetchall()
        published = db.execute('SELECT content, status, tid FROM SnsPendingDraftDeletionTable '
                               'WHERE create_time >= ? ORDER BY local_id DESC LIMIT ?', (since, MAX_OWN_MOMENTS)).fetchall()
    for (content,) in timeline:
        root = parse(content)
        item = root.find('TimelineObject') if root is not None else None
        if item is None or item.findtext('username') != account_id:
            continue
        created = item.findtext('createTime') or ''
        if created.isdigit() and int(created) >= since:
            found.append({'id': item.findtext('id') or '', 'created': int(created),
                          'text': item.findtext('contentDesc') or '', 'private': item.findtext('private') == '1'})
    for content, status, tid in published:
        root = parse(content)
        if root is None or root.tag != 'publish_data' or status != 3 or not str(tid or '').isdigit():
            continue
        media = root.findall('upload_media_list/upload_media')
        created = root.findtext('create_time') or ''
        if not created.isdigit() or any(entry.findtext('is_finished') != 'true' for entry in media):
            continue
        found.append({'id': str(tid), 'created': int(created), 'text': root.findtext('content_desc') or '',
                      'private': root.findtext('privacyType') == '2'})
    return found


def parse_request(line):
    def unique_fields(items):
        fields = dict(items)
        if len(fields) != len(items):
            raise LocalDataError('invalid_request')
        return fields

    if not line.endswith(b'\n') or len(line) > MAX_REQUEST_BYTES:
        raise LocalDataError('invalid_request')
    request = json.loads(line, object_pairs_hook=unique_fields)
    if not isinstance(request, dict):
        raise LocalDataError('invalid_request')
    operation = request.get('op')
    if not isinstance(operation, str) or operation not in OP_FIELDS or set(request) - OP_FIELDS[operation]:
        raise LocalDataError('invalid_request')
    return request


MAX_DIGEST_GROUPS = 250
MAX_DIGEST_ROWS = 80
MAX_DIGEST_ROW_CHARS = 500
MAX_DIGEST_CHARACTERS = 12_000
DIGEST_WINDOW = 24 * 60 * 60
OPAQUE_ID = re.compile(r'[a-f0-9]{64}\Z')
DIGEST_NATIVE_LABELS = {3: '[图片]', 34: '[语音]', 42: '[名片]', 43: '[视频]', 48: '[位置]'}
DIGEST_CARD_LABELS = {6: '[文件]', 19: '[合并转发]', 33: '[小程序]', 36: '[小程序]', 51: '[视频号]'}


def digest_group_id(account_id, conversation):
    identity = f'deskpet/wechat/digest-group/v1\0{account_id}\0{conversation}'
    return hashlib.sha256(identity.encode('ascii')).hexdigest()


def digest_group_roster(contact_db, account_id, reply_groups):
    # A contact with only a group-like name is insufficient; it must be a
    # native room known to this official account's contact database.
    rows = contact_db.execute(
        'SELECT c.username,c.nick_name,c.remark FROM contact c '
        'JOIN chat_room r ON r.username COLLATE BINARY=c.username '
        "WHERE c.username LIKE '%@chatroom' ORDER BY c.username LIMIT ?",
        (MAX_DIGEST_GROUPS + 1,),
    ).fetchall()
    if len(rows) > MAX_DIGEST_GROUPS:
        raise LocalDataError('digest_group_limit')
    groups = {}
    seen = set()
    for row in rows:
        conversation = row['username']
        if not valid_id(conversation) or not conversation.endswith('@chatroom') or conversation in seen:
            raise LocalDataError('digest_scope_unverified')
        seen.add(conversation)
        title = digest_text(safe_name(row['remark']) or safe_name(row['nick_name']), 160)
        if title:
            # A reply group may also be digested; its replies keep following its own rules.
            groups[digest_group_id(account_id, conversation)] = (conversation, title, conversation in reply_groups)
    return groups


def digest_text(value, maximum):
    if not isinstance(value, str):
        return ''
    bounded = ' '.join(''.join(char if char.isprintable() else ' ' for char in value).split())
    return bounded.encode('utf-16-le')[:maximum * 2].decode('utf-16-le', errors='ignore').rstrip()


def digest_message_body(item):
    if item['type'] == 1:
        return digest_text(item['body'], MAX_DIGEST_ROW_CHARS)
    if item['type'] in DIGEST_NATIVE_LABELS:
        return DIGEST_NATIVE_LABELS[item['type']]
    if item['type'] & 0xffffffff != 49:
        return ''
    raw = item['body'].lstrip()
    if not raw.startswith('<') or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', raw, re.I):
        return ''
    try:
        root = ET.fromstring(raw)
    except (ET.ParseError, ValueError):
        return ''
    cards = root.findall('appmsg') if root.tag == 'msg' else []
    if len(cards) != 1:
        return ''
    types, titles = cards[0].findall('type'), cards[0].findall('title')
    if len(types) != 1 or len(types[0]) or len(titles) > 1 or (titles and len(titles[0])):
        return ''
    subtype_text = types[0].text or ''
    if not re.fullmatch(r'[0-9]{1,5}', subtype_text):
        return ''
    subtype = int(subtype_text)
    if item['type'] >> 32 not in (0, subtype):
        return ''
    title = digest_text(titles[0].text, 160) if titles else ''
    if subtype == 57:
        return title
    if label := DIGEST_CARD_LABELS.get(subtype):
        return f'{label} {title}' if title else label
    if subtype != 5:
        return ''
    urls = cards[0].findall('url')
    url = urls[0].text if len(urls) == 1 and not len(urls[0]) else None
    if not url or len(url) > 470 or any(not char.isprintable() or char.isspace() for char in url):
        return title
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username is not None:
            return title
    except ValueError:
        return title
    remaining = MAX_DIGEST_ROW_CHARS - len(url.encode('utf-16-le')) // 2
    if remaining < 0:
        return title
    prefix = digest_text(title, max(0, remaining - 1))
    return f'{prefix} {url}' if prefix else url


def digest_group_rows(storage, keys, contact_db, account_id, owner_id, conversation, until):
    until = digest_end(until)
    paths = message_shards(storage)
    table = table_for(conversation)
    candidates = []
    reached_scan_limit = False
    limit = MAX_DIGEST_ROWS + 1
    group_cache = {}
    for path in paths:
        with open_logical(path, keys) as (db, _):
            if not table_exists(db, table):
                continue
            result = db.execute(
                f'SELECT m.local_id,m.server_id,n.user_name AS sender,m.local_type,m.create_time,'
                f'CASE WHEN length(CAST(m.message_content AS BLOB))<=? THEN m.message_content END AS message_content,'
                f'CASE WHEN length(CAST(m.compress_content AS BLOB))<=? THEN m.compress_content END AS compress_content,'
                f'CASE WHEN length(CAST(m.source AS BLOB))<=? THEN m.source END AS source '
                f'FROM "{table}" m LEFT JOIN Name2Id n ON m.real_sender_id=n.rowid '
                f'WHERE m.create_time>=? AND m.create_time<? AND (m.local_type & 4294967295) IN (1,3,34,42,43,48,49) '
                f'ORDER BY m.create_time DESC,m.local_id DESC LIMIT ?',
                (MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_BODY_BYTES, until - DIGEST_WINDOW, until, limit),
            )
            incoming = []
            scanned = result.fetchall()
            reached_scan_limit |= len(scanned) == limit
            for row in scanned:
                item = normalize_message(row, path, conversation, account_id)
                text = digest_message_body(item)
                if not text:
                    continue
                public = {'at': item['created_at'], 'text': text}
                if owner_id in item['mention_ids']:
                    public['mentionsOwner'] = True
                if item['sender_id'] == owner_id:
                    public['speaker'] = '主人'
                elif item['sender_id'] == account_id:
                    public['speaker'] = '桌宠'
                else:
                    attach_sender_name(contact_db, item, group_cache)
                    if speaker := digest_text(item.get('sender_display_name'), 80):
                        public['speaker'] = speaker
                incoming.append((row_order(item), public))
            candidates = heapq.nlargest(limit, (*candidates, *incoming), key=lambda entry: entry[0])
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    selected = []
    remaining = MAX_DIGEST_CHARACTERS
    for _, item in candidates[:MAX_DIGEST_ROWS]:
        length = sum(len(item.get(field, '').encode('utf-16-le')) // 2 for field in ('speaker', 'text'))
        if length > remaining:
            break
        selected.append(item)
        remaining -= length
    return {'rows': list(reversed(selected)), 'truncated': reached_scan_limit or len(selected) < len(candidates)}


def digest_end(until, *, window=DIGEST_WINDOW):
    now = int(time.time())
    if type(until) is not int or not max(window, now - DIGEST_WINDOW) <= until <= now + 5:
        raise LocalDataError('invalid_request')
    return until


FOLLOWUP_WINDOW = 7 * DIGEST_WINDOW
MAX_FOLLOWUP_ROWS = 256
MAX_FOLLOWUP_CHARS = 320


def followup_id(account, conversation, kind, value):
    identity = f'deskpet/wechat/followup/{kind}/v1\0{account}\0{conversation}\0{value}'
    return hashlib.sha256(identity.encode('ascii')).hexdigest()


def followup_quote_server_id(item):
    if item['type'] not in (49, (57 << 32) | 49):
        return None
    body = item['body']
    if not body or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', body, re.I):
        return None
    try:
        root = ET.fromstring(body.lstrip())
    except (ET.ParseError, UnicodeError, ValueError):
        return None
    cards = root.findall('appmsg') if root.tag == 'msg' else []
    if len(cards) != 1:
        return None
    types, quotes = cards[0].findall('type'), cards[0].findall('refermsg')
    if len(types) != 1 or types[0].text != '57' or len(types[0]) or len(quotes) != 1:
        return None
    ids = quotes[0].findall('svrid')
    if len(ids) != 1 or len(ids[0]) or not re.fullmatch(r'[1-9][0-9]{0,19}', ids[0].text or ''):
        return None
    return ids[0].text


def followup_window(since, until):
    now = int(time.time())
    if (type(since) is not int or type(until) is not int or not max(0, now - FOLLOWUP_WINDOW) <= since < until <= now + 5
            or until - since > FOLLOWUP_WINDOW):
        raise LocalDataError('invalid_request')


def followup_group_rows(storage, keys, account, owner, conversation, since, until):
    followup_window(since, until)
    paths = message_shards(storage)
    table = table_for(conversation)
    limit = MAX_FOLLOWUP_ROWS + 1
    candidates = []
    truncated = False
    seen_table = False
    for path in paths:
        with open_logical(path, keys) as (db, _):
            if not table_exists(db, table):
                continue
            seen_table = True
            db.create_function('mentions_pinned_owner', 1, lambda source: int(owner in mention_ids(source)), deterministic=True)
            rows = db.execute(
                f'SELECT m.local_id,m.server_id,n.user_name AS sender,m.local_type,m.create_time,'
                f'CASE WHEN length(CAST(m.message_content AS BLOB))<=? THEN m.message_content END AS message_content,'
                f'CASE WHEN length(CAST(m.compress_content AS BLOB))<=? THEN m.compress_content END AS compress_content,'
                f'CASE WHEN length(CAST(m.source AS BLOB))<=? THEN m.source END AS source '
                f'FROM "{table}" m LEFT JOIN Name2Id n ON m.real_sender_id=n.rowid '
                'WHERE m.create_time>=? AND m.create_time<? AND '
                '((n.user_name COLLATE BINARY=? AND (m.local_type & 4294967295) IN (1,49)) '
                'OR ((n.user_name IS NULL OR n.user_name COLLATE BINARY<>?) AND mentions_pinned_owner(m.source))) '
                'ORDER BY m.create_time DESC,m.local_id DESC LIMIT ?',
                (MAX_BODY_BYTES, MAX_BODY_BYTES, MAX_BODY_BYTES, since, until, owner, account, limit),
            ).fetchall()
            truncated |= len(rows) == limit
            relevant = []
            for row in rows:
                item = normalize_message(row, path, conversation, account)
                sender = item['sender_id']
                if not sender or item['server_id'] == '0':
                    truncated = True
                    continue
                owner_sent = sender == owner
                quote = followup_quote_server_id(item) if owner_sent else None
                # Exclude the owner's non-text cards unless they directly quote a message.
                if owner_sent and item['type'] != 1 and quote is None:
                    continue
                if not owner_sent and (sender == account or owner not in item['mention_ids']):
                    continue
                body = digest_message_body(item)
                text = digest_text(body, MAX_FOLLOWUP_CHARS)
                if not text and owner_sent and quote is None:
                    continue
                public = {'id': followup_id(account, conversation, 'message', item['server_id']),
                          'at': item['created_at'], 'role': 'owner' if owner_sent else 'member',
                          'text': text or '[文字不可读]'}
                if quote is not None:
                    public['quoteId'] = followup_id(account, conversation, 'message', quote)
                if not owner_sent:
                    public['mentionsOwner'] = True
                    public['author'] = followup_id(account, conversation, 'author', sender)
                relevant.append((row_order(item), public))
            candidates = heapq.nlargest(limit, (*candidates, *relevant), key=lambda entry: entry[0])
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    unique = {}
    conflicting = set()
    for _, row in reversed(candidates[:MAX_FOLLOWUP_ROWS]):
        previous = unique.get(row['id'])
        if previous is not None and previous != row:
            conflicting.add(row['id'])
        unique[row['id']] = row
    return {'rows': [row for identity, row in unique.items() if identity not in conflicting],
            'truncated': not seen_table or truncated or bool(conflicting) or len(candidates) == limit}


MAX_OFFICIAL_ACCOUNTS = 250
MAX_OFFICIAL_SESSION_ROWS = 16
MAX_OFFICIAL_ROWS = 100
MAX_OFFICIAL_ARTICLES = 80
MAX_OFFICIAL_CARD_ITEMS = 12
OFFICIAL_USER = re.compile(r'gh_[A-Za-z0-9_.-]{1,125}\Z')
ARTICLE_HOST = 'mp.weixin.qq.com'
ARTICLE_PATH = re.compile(r'/s/[A-Za-z0-9_-]{10,80}\Z')
ARTICLE_FIELDS = ('__biz', 'mid', 'idx', 'sn', 'chksm')
ARTICLE_ID_FIELDS = ('__biz', 'mid', 'idx')
ARTICLE_FIELD_VALUE = re.compile(r'[A-Za-z0-9_+/=\-]{1,160}\Z')


def official_account_id(account_id, conversation):
    identity = f'deskpet/wechat/official/v1\0{account_id}\0{conversation}'
    return hashlib.sha256(identity.encode('ascii')).hexdigest()


def official_roster(storage, keys, contact_db, account_id):
    with open_logical(storage / 'session/session.db', keys) as (sessions, _):
        found = sessions.execute("SELECT username FROM SessionTable WHERE substr(username,1,3)='gh_' LIMIT ?",
                                 (MAX_OFFICIAL_ACCOUNTS + 1,)).fetchall()
    if len(found) > MAX_OFFICIAL_ACCOUNTS:
        raise LocalDataError('official_scope_unverified')
    names = set()
    roster = {}
    for (name,) in found:
        if not isinstance(name, str) or not OFFICIAL_USER.fullmatch(name) or name in names:
            raise LocalDataError('official_scope_unverified')
        names.add(name)
        contacts = contact_db.execute('SELECT nick_name FROM contact WHERE username COLLATE BINARY=? LIMIT 2',
                                      (name,)).fetchall()
        if len(contacts) != 1:
            continue
        title = digest_text(safe_name(contacts[0]['nick_name']), 80)
        if title:
            roster[official_account_id(account_id, name)] = (name, title)
    return roster


def canonical_official_url(value):
    if (not isinstance(value, str) or not value or len(value) > 4_096
            or any(not char.isprintable() or char.isspace() or char == '\\' for char in value)):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() != ARTICLE_HOST:
            return None
        if ARTICLE_PATH.fullmatch(parsed.path):
            url = urlunsplit(('https', ARTICLE_HOST, parsed.path, '', ''))
            return url, (parsed.path,)
        if parsed.path not in ('/s', '/s/'):
            return None
        fields = {}
        for name, item in parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=80):
            if name not in ARTICLE_FIELDS:
                continue
            if name in fields or not ARTICLE_FIELD_VALUE.fullmatch(item):
                return None
            fields[name] = item
        if not all(name in fields for name in ARTICLE_FIELDS[:-1]):
            return None
        query = [(name, fields[name]) for name in ARTICLE_FIELDS if name in fields]
        url = urlunsplit(('https', ARTICLE_HOST, '/s', urlencode(query), ''))
        if len(url) <= 500:
            return url, tuple(fields[key] for key in ARTICLE_ID_FIELDS)
    except ValueError:
        return None
    return None


def unique_child_text(element, tag):
    direct = element.findall(tag)
    return (direct[0].text or '') if len(direct) == 1 and not len(direct[0]) else None


def official_card_articles(raw, conversation):
    body = decode_field(raw)
    if not body:
        return []
    body = body.removeprefix(conversation + ':\n').lstrip()
    if not body.startswith('<') or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', body, re.I):
        return []
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, ValueError):
        return []
    cards = root.findall('appmsg') if root.tag == 'msg' else []
    if len(cards) != 1 or unique_child_text(cards[0], 'type') != '5':
        return []
    card = cards[0]
    source = card.findall('sourceusername')
    if source and unique_child_text(card, 'sourceusername') != conversation:
        return []
    readers = card.findall('mmreader')
    if readers:
        # Synthetic coverage for this native-looking layout. A different wrapper
        # or oversized batch is ignored rather than searching arbitrary nested XML.
        categories = readers[0].findall('category') if len(readers) == 1 else []
        if len(categories) != 1:
            return []
        items = categories[0].findall('item')
        if not 1 <= len(items) <= MAX_OFFICIAL_CARD_ITEMS:
            return []
    else:
        items = [card]
    articles = []
    for item in items:
        if item is not card and item.findall('sourceusername') and unique_child_text(item, 'sourceusername') != conversation:
            continue
        article_title = digest_text(unique_child_text(item, 'title'), 160)
        url = canonical_official_url(unique_child_text(item, 'url'))
        if url and article_title:
            articles.append((url, article_title))
    return articles


def official_articles(storage, keys, roster, until):
    until = digest_end(until)
    sessions = {table_for(conversation): (conversation, title) for conversation, title in roster.values()}
    if not sessions:
        return {'articles': [], 'truncated': False}
    paths = message_shards(storage)
    candidates = []
    capped = False
    for path in paths:
        with open_logical(path, keys) as (db, _):
            for table, (conversation, title) in sessions.items():
                if not table_exists(db, table):
                    continue
                rows = db.execute(
                    f'SELECT m.local_id,m.create_time,'
                    f'CASE WHEN length(CAST(m.message_content AS BLOB))<=? THEN m.message_content END,'
                    f'CASE WHEN length(CAST(m.compress_content AS BLOB))<=? THEN m.compress_content END '
                    f'FROM "{table}" m JOIN Name2Id n ON m.real_sender_id=n.rowid '
                    f'WHERE n.user_name COLLATE BINARY=? AND m.create_time>=? AND m.create_time<? '
                    f'AND m.local_type IN (49,?) ORDER BY m.create_time DESC,m.local_id DESC LIMIT ?',
                    (MAX_BODY_BYTES, MAX_BODY_BYTES, conversation, until - DIGEST_WINDOW, until,
                     (5 << 32) | 49, MAX_OFFICIAL_SESSION_ROWS + 1),
                ).fetchall()
                capped |= len(rows) > MAX_OFFICIAL_SESSION_ROWS
                additional = []
                for local_id, created_at, raw, compressed in rows[:MAX_OFFICIAL_SESSION_ROWS]:
                    if type(local_id) is not int or type(created_at) is not int or not until - DIGEST_WINDOW <= created_at < until:
                        continue
                    order = (created_at, local_id, path.name, conversation)
                    additional.append((order, conversation, title, raw or compressed))
                capped |= len(candidates) + len(additional) > MAX_OFFICIAL_ROWS
                candidates = heapq.nlargest(MAX_OFFICIAL_ROWS, (*candidates, *additional), key=lambda item: item[0])
    if paths != message_shards(storage):
        raise LocalDataError('snapshot_changed')
    articles = {}
    for (created_at, _, _, _), conversation, title, raw in candidates:
        for (url, identity), article_title in official_card_articles(raw, conversation):
            if identity in articles:
                continue
            if len(articles) == MAX_OFFICIAL_ARTICLES:
                capped = True
                break
            articles[identity] = {'url': url, 'title': article_title, 'account': title, 'at': created_at}
        if len(articles) == MAX_OFFICIAL_ARTICLES and capped:
            break
    return {'articles': list(articles.values()), 'truncated': capped}


MAX_MOMENT_SCAN = 260
MAX_FRIEND_MOMENTS = 60
MAX_MOMENT_CHARACTERS = 18_000
MAX_MOMENT_TEXT = 600
MAX_MOMENT_IMAGES = 18


def moment_image_count(item):
    contents = item.findall('ContentObject')
    if len(contents) != 1:
        return 0
    content = contents[0]
    styles = [unique_child_text(content, name) for name in ('type', 'contentStyle') if content.findall(name)]
    if not styles or any(style != '1' for style in styles):
        return 0
    media_lists = content.findall('mediaList')
    if len(media_lists) != 1:
        return 0
    images = 0
    for media in media_lists[0].findall('media'):
        urls = media.findall('url')
        if (unique_child_text(media, 'type') == '2' and len(urls) == 1 and not len(urls[0])
                and urls[0].text and not urls[0].get('videomd5') and media.find('videoDuration') is None):
            images += 1
            if images == MAX_MOMENT_IMAGES:
                break
    return images


def friend_moment(raw, author, since, until):
    body = decode_field(raw)
    if not body or not body.lstrip().startswith('<') or re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', body, re.I):
        return None
    try:
        root = ET.fromstring(body.lstrip())
    except (ET.ParseError, ValueError):
        return None
    items = [root] if root.tag == 'TimelineObject' else root.findall('TimelineObject') if root.tag == 'SnsDataItem' else []
    if len(items) != 1 or unique_child_text(items[0], 'username') != author:
        return None
    item = items[0]
    created = unique_child_text(item, 'createTime')
    if not created or not re.fullmatch(r'[0-9]{1,12}', created) or not since <= int(created) < until:
        return None
    text = digest_text(unique_child_text(item, 'contentDesc'), MAX_MOMENT_TEXT)
    images = moment_image_count(item)
    if not text and not images:
        return None
    return {'text': text, 'images': images, 'at': int(created)}


def friend_label(db, username):
    if not valid_id(username) or username.endswith('@chatroom') or username.startswith('gh_'):
        return ''
    found = db.execute('SELECT nick_name FROM contact WHERE username COLLATE BINARY=? AND delete_flag=0 LIMIT 2',
                       (username,)).fetchall()
    return digest_text(safe_name(found[0]['nick_name']), 80) if len(found) == 1 else ''


MAX_REPLY_FRIEND_ROSTER = 250
SYSTEM_CONTACT_IDS = frozenset({
    'brandsessionholder', 'fmessage', 'feedsapp', 'filehelper', 'floatbottle', 'medianote',
    'newsapp', 'officialaccounts', 'qmessage', 'qqmail', 'tmessage', 'weibo', 'weixin', 'weixinreminder',
})


def reply_friend_id(account_id, conversation):
    identity = f'deskpet/wechat/reply-friend/v1\0{account_id}\0{conversation}'
    return hashlib.sha256(identity.encode('ascii')).hexdigest()


def reply_friend_roster(db, account_id, owner_id):
    # Only the live-schema tuple confirmed for sampled native friends qualifies.
    # The generic active-contact tuple also occurs outside the friend sample.
    contacts = db.execute(
        'SELECT username,nick_name,remark,alias FROM contact '
        'WHERE local_type=1 AND flag=3 AND delete_flag=0 AND verify_flag=0 '
        'AND username COLLATE BINARY<>? AND username COLLATE BINARY<>? '
        'ORDER BY username LIMIT ?', (account_id, owner_id, MAX_REPLY_FRIEND_ROSTER + 1),
    ).fetchall()
    if len(contacts) > MAX_REPLY_FRIEND_ROSTER:
        raise LocalDataError('friend_roster_limit')
    roster = {}
    for contact in contacts:
        native = contact['username']
        if (not valid_id(native) or native.endswith('@chatroom') or native.lower().startswith('gh_')
                or native.lower() in SYSTEM_CONTACT_IDS):
            continue
        title = digest_text(safe_name(contact['remark']) or safe_name(contact['nick_name']), 160)
        if not title:
            continue
        opaque = reply_friend_id(account_id, native)
        if opaque in roster:
            raise LocalDataError('friend_binding_ambiguous')
        roster[opaque] = (native, title, contact['alias'])
    return roster


def resolve_reply_friend(roster, friend_id):
    if not isinstance(friend_id, str) or not OPAQUE_ID.fullmatch(friend_id) or friend_id not in roster:
        raise LocalDataError('friend_binding_invalid')
    friend = roster[friend_id]
    # Match the same case and whitespace normalization used by native search.
    def search_title(title):
        return ''.join(unicodedata.normalize('NFKC', title).split()).casefold()

    if sum(search_title(row[1]) == search_title(friend[1]) for row in roster.values()) != 1:
        raise LocalDataError('friend_binding_ambiguous')
    return friend


def respond_to_reply_friend(request, storage, keys, contact_db, account_id, owner):
    op = request['op']
    roster = reply_friend_roster(contact_db, account_id, owner)
    if op == 'friend_list':
        return {'friends': [{'id': key, 'title': row[1]} for key, row in roster.items()]}
    friend_id = request.get('friend_id')
    native, title, alias = resolve_reply_friend(roster, friend_id)
    if op == 'friend_verify':
        identifier = request.get('alias')
        if (request.get('title') != title or not identifier or not valid_id(identifier)
                or identifier not in (native, alias)):
            raise LocalDataError('friend_binding_invalid')
        matches = contact_db.execute('SELECT username FROM contact WHERE username COLLATE BINARY=? '
                                     'OR alias COLLATE BINARY=? LIMIT 2', (identifier, identifier)).fetchall()
        if len(matches) != 1 or matches[0]['username'] != native:
            raise LocalDataError('friend_binding_ambiguous')
        return {'friend': {'id': friend_id, 'title': title}}
    if op == 'friend_poll':
        return poll(storage, keys, contact_db, account_id, (native,), request, friend=native)
    if op == 'voice_audio':
        return voice_audio(storage, keys, native, request.get('server_id'))
    if 'conversation' in request:
        raise LocalDataError('invalid_request')
    return own_send_receipt(storage, keys, account_id, request, friend=native)


def friends_moments(storage, keys, contact_db, account_id, days, until):
    if type(days) is not int or days not in (1, 7):
        raise LocalDataError('invalid_request')
    window = days * DIGEST_WINDOW
    until = digest_end(until, window=window)
    with open_logical(storage / 'sns/sns.db', keys) as (sns, _):
        rows = sns.execute('SELECT tid,user_name,CASE WHEN length(CAST(content AS BLOB))<=? THEN content END '
                           'FROM SnsTimeLine WHERE user_name COLLATE BINARY<>? ORDER BY tid DESC LIMIT ?',
                           (MAX_BODY_BYTES, account_id, MAX_MOMENT_SCAN + 1)).fetchall()
    candidates = []
    contacts = {}
    seen = set()
    for tid, username, content in rows[:MAX_MOMENT_SCAN]:
        if not isinstance(username, str) or username == account_id:
            continue
        if username not in contacts:
            contacts[username] = friend_label(contact_db, username)
        author = contacts[username]
        if not author or type(tid) not in (int, str):
            continue
        identity = (username, str(tid))
        post = friend_moment(content, username, until - window, until)
        if post is None or identity in seen:
            continue
        seen.add(identity)
        candidates.append({'author': author, **post})
    candidates.sort(key=lambda post: post['at'], reverse=True)
    selected = []
    remaining = MAX_MOMENT_CHARACTERS
    for post in candidates[:MAX_FRIEND_MOMENTS]:
        length = sum(len(post[field].encode('utf-16-le')) // 2 for field in ('author', 'text'))
        if length > remaining:
            break
        selected.append(post)
        remaining -= length
    return {'posts': selected, 'truncated': len(rows) > MAX_MOMENT_SCAN or len(selected) < len(candidates)}


def respond(request, storage, account_id, password):
    keys = Keys(password)
    operation = request['op']
    result = {'ok': True, 'account_id': account_id}
    if operation == 'own_moments':
        return result | {'moments': own_moments(storage, keys, account_id, request.get('since'))}
    if operation == 'own_sent':
        return result | {'found': own_sent(storage, keys, account_id, request.get('conversation'),
                                           request.get('since'), request.get('text'))}
    if operation in ('send_baseline', 'send_receipt') and 'friend_id' not in request:
        if 'owner_id' in request:
            raise LocalDataError('invalid_request')
        return result | own_send_receipt(storage, keys, account_id, request)
    if operation != 'discover' and request.get('account_id') != account_id:
        raise LocalDataError('account_binding_changed')
    with open_logical(storage / 'contact/contact.db', keys) as (contact_db, _):
        if operation == 'discover':
            owner = select_contact(contact_db, request.get('owner'))
            if owner['id'] == account_id:
                raise LocalDataError('invalid_request')
            groups = [select_contact(contact_db, item, group=True)
                      for item in require_list(request, 'groups', MAX_GROUPS)]
            if len({item['id'] for item in groups}) != len(groups):
                raise LocalDataError('binding_ambiguous')
            return result | {'owner': owner, 'groups': groups}
        if (operation in ('friend_list', 'friend_verify', 'friend_poll')
                or 'friend_id' in request and operation in ('voice_audio', 'send_baseline', 'send_receipt')):
            owner, _ = validate_scopes(contact_db, account_id, request | {'group_ids': []})
            return result | respond_to_reply_friend(request, storage, keys, contact_db, account_id, owner)
        if operation == 'owner_activity':
            owner, _ = validate_scopes(contact_db, account_id, request | {'group_ids': []})
            return owner_activity(storage, keys, owner)
        if operation in ('voice_baseline', 'voice_receipt', 'voice_audio'):
            owner, _ = validate_scopes(contact_db, account_id, request | {'group_ids': []})
            if operation == 'voice_audio':
                return result | voice_audio(storage, keys, owner, request.get('server_id'))
            return result | own_voice(storage, keys, account_id, owner, request)
        if operation in ('official_list', 'official_read'):
            validate_scopes(contact_db, account_id, request | {'group_ids': []})
            roster = official_roster(storage, keys, contact_db, account_id)
            if operation == 'official_list':
                return result | {'accounts': [{'id': key, 'title': item[1]} for key, item in roster.items()]}
            if 'ids' not in request:
                raise LocalDataError('invalid_request')
            selected = request['ids']
            if selected is not None:
                if (not isinstance(selected, list) or len(selected) > MAX_OFFICIAL_ACCOUNTS
                        or not all(isinstance(key, str) and OPAQUE_ID.fullmatch(key) for key in selected)
                        or len(set(selected)) != len(selected)):
                    raise LocalDataError('invalid_request')
                if not set(selected) <= roster.keys():
                    raise LocalDataError('official_scope_changed')
                roster = {key: roster[key] for key in selected}
            return result | official_articles(storage, keys, roster, request.get('until'))
        if operation == 'friends_moments_read':
            validate_scopes(contact_db, account_id, request | {'group_ids': []})
            return result | friends_moments(storage, keys, contact_db, account_id, request.get('days'), request.get('until'))
        owner, groups = validate_scopes(contact_db, account_id, request)
        if operation in ('digest_group_list', 'digest_group_read', 'followup_group_read'):
            roster = digest_group_roster(contact_db, account_id, groups)
            if operation == 'digest_group_list':
                return result | {'groups': [{'id': key, 'title': item[1], **({'replying': True} if item[2] else {})}
                                            for key, item in roster.items()]}
            group_id = request.get('id')
            if not isinstance(group_id, str) or not OPAQUE_ID.fullmatch(group_id):
                raise LocalDataError('invalid_request')
            if group_id not in roster:
                raise LocalDataError('followup_scope_changed' if operation == 'followup_group_read' else 'digest_scope_changed')
            if operation == 'followup_group_read':
                return result | followup_group_rows(storage, keys, account_id, owner, roster[group_id][0],
                                                   request.get('since'), request.get('until'))
            return result | digest_group_rows(storage, keys, contact_db, account_id, owner, roster[group_id][0], request.get('until'))
        if operation == 'resolve_senders':
            return result | {'results': resolve_senders(
                contact_db, groups, require_list(request, 'requests', MAX_GROUPS),
            )}
        if operation == 'attest':
            return result | {'results': attest(
                storage, keys, account_id, groups, require_list(request, 'witnesses', MAX_GROUPS),
            )}
        return result | poll(storage, keys, contact_db, account_id, [owner, *groups], request)


def main():
    try:
        request = parse_request(sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1))
    except (LocalDataError, ValueError, RecursionError):
        print('{"ok":false,"error":"invalid_request"}')
        return
    try:
        # Prevent credentials and decrypted messages from entering a crash dump.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        storage, account_id, password = bootstrap()
        response = respond(request, storage, account_id, password)
        payload = json_payload(response)
        if len(payload) + 1 > MAX_RESPONSE_BYTES:
            raise LocalDataError('response_too_large')
    except LocalDataError as error:
        payload = json.dumps({'ok': False, 'error': str(error)}).encode('ascii')
    except PermissionError:
        payload = b'{"ok":false,"error":"guest_permission_denied"}'
    except (ImportError, AttributeError):
        payload = b'{"ok":false,"error":"guest_dependency_unavailable"}'
    except MemoryError:
        payload = b'{"ok":false,"error":"guest_resource_limit"}'
    except (OSError, ValueError, IndexError, struct.error, sqlite3.Error):
        payload = b'{"ok":false,"error":"guest_read_failed"}'
    sys.stdout.buffer.write(payload + b'\n')


if __name__ == '__main__':
    main()
