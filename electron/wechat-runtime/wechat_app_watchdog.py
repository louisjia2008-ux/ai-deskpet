"""Observe only the desktop app's heartbeat; never start, stop or repair it."""

from datetime import datetime
from hashlib import sha256
import json
import os
import time

from wechat_service import _open_private, is_paused
from wechat_state import WeChatState


STALE_SECONDS = 10 * 60
MAX_LOOP_GAP = 2 * 60
HEARTBEAT = 'app-heartbeat.json'
PRE_SEND = {'busy', 'paused', 'retry', 'binding_invalid'}


def read_heartbeat(runtime, now):
    try:
        with os.fdopen(_open_private(runtime / HEARTBEAT, os.O_RDONLY), 'rb') as handle:
            raw = handle.read(257)
        if len(raw) > 256:
            return None
        body = json.loads(raw)
    except (OSError, ValueError, RecursionError):
        return None
    if (not isinstance(body, dict) or set(body) != {'at', 'pid', 'state'}
            or type(body['at']) is not int or not 0 < body['at'] <= now
            or type(body['pid']) is not int or not 0 < body['pid'] <= 2**31 - 1
            or body['state'] not in ('running', 'stopped')):
        return None
    return body


def latest_outage(db):
    row = db.execute('''SELECT started_at, notified_at, recovered_at, recovery_notified_at
                        FROM deskpet_app_outages ORDER BY started_at DESC LIMIT 1''').fetchone()
    return row


def outage_status(path):
    """Read-only, including on older listener databases without the table."""
    if not path.is_file():
        return {'outage': None}
    with WeChatState(path, read_only=True) as state:
        exists = state.db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deskpet_app_outages'").fetchone()
        row = latest_outage(state.db) if exists else None
    keys = ('startedAt', 'notifiedAt', 'recoveredAt', 'recoveryNotifiedAt')
    return {'outage': dict(zip(keys, row, strict=True)) if row else None}


def quiet(now):
    hour = datetime.fromtimestamp(now).hour
    return hour >= 23 or hour < 8


class AppWatchdog:
    def __init__(self, db, runtime, send, *, clock=time.time, monotonic=time.monotonic, quiet_hours=quiet):
        self.db = db
        self.runtime = runtime
        self.send = send
        self.clock = clock
        self.monotonic = monotonic
        self.quiet = quiet_hours
        self.previous = None
        self.continuous_since = None

    def tick(self, *, paused):
        wall, mono = self.clock(), self.monotonic()
        previous = self.previous
        self.previous = (wall, mono)
        if paused:
            self.continuous_since = None
            return
        if (self.continuous_since is None or previous is None or not 0 <= wall - previous[0] < MAX_LOOP_GAP
                or not 0 <= mono - previous[1] < MAX_LOOP_GAP):
            self.continuous_since = mono
        now = int(wall)
        heartbeat = read_heartbeat(self.runtime, now)
        if heartbeat is None or heartbeat['state'] == 'stopped':
            return
        row = latest_outage(self.db)
        at = heartbeat['at']
        if now - at < STALE_SECONDS:
            if row and row[2] is None and at > row[0]:
                with self.db:
                    self.db.execute('UPDATE deskpet_app_outages SET recovered_at=? WHERE started_at=?', (at, row[0]))
                row = latest_outage(self.db)
            if row and row[1] is not None and row[2] is not None and row[3] is None and not self.quiet(now):
                self._notify(row[0], now, '【医生】桌宠恢复了。', recovering=True)
            return
        if mono - self.continuous_since < STALE_SECONDS:
            return
        if row is None or row[2] is not None:
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO deskpet_app_outages (started_at) VALUES (?)', (at,))
            row = latest_outage(self.db)
        if row and row[2] is None and row[1] is None and not self.quiet(now):
            minutes = (now - at) // 60
            self._notify(row[0], now, f'【医生】桌宠已经 {minutes} 分钟没有响应了，可能崩溃或卡住了。'
                         '微信消息暂时不会有人回，回到电脑前重新打开桌宠就好。', recovering=False)

    def _notify(self, started, now, text, *, recovering):
        column = 'recovery_notified_at' if recovering else 'notified_at'
        kind = 'recovery' if recovering else 'outage'
        identity = sha256(f'deskpet/app-watchdog/{kind}/{started}'.encode('ascii')).hexdigest()
        begin_wall, begin_mono = self.previous

        def still_current():
            wall = self.clock()
            current = int(wall)
            if (not 0 <= wall - begin_wall < MAX_LOOP_GAP or not 0 <= self.monotonic() - begin_mono < MAX_LOOP_GAP
                    or self.quiet(current) or is_paused(self.runtime)):
                return False
            heartbeat = read_heartbeat(self.runtime, current)
            if not heartbeat or heartbeat['state'] != 'running':
                return False
            fresh = current - heartbeat['at'] < STALE_SECONDS
            return fresh and heartbeat['at'] > started if recovering else not fresh

        # Reserve before crossing the UI boundary, including across listener restarts.
        # Only a proven pre-send result releases the reservation. An unconfirmed send
        # is never repeated, even if the listener was killed before receiving its result.
        with self.db:
            reserved = self.db.execute(f'UPDATE deskpet_app_outages SET {column}=? WHERE started_at=? AND {column} IS NULL',
                                       (now, started)).rowcount
        if reserved and self.send(identity, text, still_current) in PRE_SEND:
            with self.db:
                self.db.execute(f'UPDATE deskpet_app_outages SET {column}=NULL WHERE started_at=?', (started,))
