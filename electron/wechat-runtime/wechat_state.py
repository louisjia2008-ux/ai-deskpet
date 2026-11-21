"""Durable checkpoints, send outcomes and local context for the WeChat watcher."""

from dataclasses import dataclass
from datetime import datetime, time as day_time, timedelta
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import unicodedata

from wechat_rich_message import chat_quote_excerpt


HISTORY_TURNS = 3
OWNER_HISTORY_TURNS = 8
OWNER_HISTORY_CHARACTERS = 6_000
DIGEST_KINDS = ('groups', 'official', 'moments')
DIGEST_BYTES_PER_KIND = 2_000
QUEUE_COMMANDS = frozenset(("/queue", "/pause-queue", "/resume-queue", "/cancel-queue"))
FRIEND_REPLIES_PER_MINUTE = 4
FRIEND_REPLIES_PER_DAY = 60
ALL_FRIEND_REPLIES_PER_HOUR = 120


class StateConflict(RuntimeError):
    """A newer observation replaced the checkpoint used for this operation."""


def digest_day_end(at):
    day = datetime.fromtimestamp(at).date()
    return int(datetime.combine(day + timedelta(days=1), day_time.min).timestamp())


@dataclass(frozen=True)
class Checkpoint:
    sequence: int
    observation: dict


@dataclass(frozen=True)
class Occurrence:
    id: str
    binding: str
    sequence: int
    observation: dict | None
    status: str
    reply: str | None


def binding_key(account: str, target: str, title: str, generation: str | int) -> str:
    if any(not isinstance(value, str) or not value for value in (account, target, title)):
        raise ValueError("A binding needs an account, target and title.")
    if type(generation) not in (str, int) or generation == "":
        raise ValueError("A binding needs a generation identifier.")
    identity = json.dumps([account, target, title, generation], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _encode_observation(observation: dict) -> str:
    if not isinstance(observation, dict):
        raise ValueError("The observation must be a JSON object.")
    return json.dumps(observation, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def database_queue_command(observation):
    message = observation.get("database") or {}
    text = observation.get("text")
    return (message.get("target") == "private" and message.get("type") == 1
            and "rich" not in observation and isinstance(text, str) and text.strip().lower() in QUEUE_COMMANDS)


def _occurrence(row) -> Occurrence:
    event_id, binding, sequence, observation, status, reply = row
    return Occurrence(event_id, binding, sequence, json.loads(observation) if observation else None, status, reply)


def _transcript_label(value, limit):
    return "".join(character for character in value
                   if unicodedata.category(character) != "Cc" and ord(character) not in (0x061C, 0x200E, 0x200F)
                   and not 0x202A <= ord(character) <= 0x202E and not 0x2066 <= ord(character) <= 0x2069).strip()[:limit]


def _database_event_order(candidate):
    event_id, observation = candidate
    source = observation["database"]
    return source["created_at"], int(source["database"][8:-3]), source["local_id"], event_id


def _database_cursor_order(candidates):
    """Merge shards by time while preserving each shard's local-ID prefix."""
    per_shard = sorted(candidates, key=lambda item: _database_event_order(item)[1:3])
    latest = {}
    ranked = []
    for candidate in per_shard:
        created, shard, local, event_id = _database_event_order(candidate)
        latest[shard] = max(created, latest.get(shard, created))
        ranked.append(((latest[shard], shard, local, event_id), candidate))
    return [candidate for _, candidate in sorted(ranked)]


class WeChatState:
    def __init__(self, path: Path, *, read_only: bool = False):
        path = Path(path)
        if read_only:
            self.db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            return
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(descriptor)
        self.db = sqlite3.connect(path)
        try:
            self.db.execute("PRAGMA secure_delete = ON")
            self.db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS deskpet_app_outages (
                    started_at INTEGER PRIMARY KEY,
                    notified_at INTEGER,
                    recovered_at INTEGER,
                    recovery_notified_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS wechat_checkpoints (
                    binding TEXT PRIMARY KEY,
                    sequence INTEGER NOT NULL,
                    occurrence_sequence INTEGER NOT NULL,
                    observation TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_mentions (
                    binding TEXT PRIMARY KEY,
                    observation TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_occurrences (
                    id TEXT PRIMARY KEY,
                    binding TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    observation TEXT,
                    status TEXT NOT NULL CHECK (status IN (
                        'pending', 'prepared', 'attempted', 'sent', 'uncertain', 'skipped'
                    )),
                    reply TEXT,
                    UNIQUE (binding, sequence)
                );
                CREATE TABLE IF NOT EXISTS wechat_moment_previews (
                    binding TEXT PRIMARY KEY,
                    id TEXT NOT NULL,
                    after_sequence INTEGER NOT NULL,
                    sent_at REAL NOT NULL,
                    interrupted INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS wechat_forward_references (
                    binding TEXT NOT NULL,
                    card_key TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    PRIMARY KEY (binding, card_key)
                );
                CREATE INDEX IF NOT EXISTS wechat_occurrence_queue
                    ON wechat_occurrences (binding, status, sequence);
                CREATE TABLE IF NOT EXISTS wechat_history (
                    binding TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    incoming TEXT NOT NULL,
                    reply TEXT NOT NULL,
                    PRIMARY KEY (binding, sequence)
                );
                CREATE TABLE IF NOT EXISTS wechat_transcript_scopes (
                    binding TEXT PRIMARY KEY,
                    scope TEXT NOT NULL CHECK (scope IN ('private', 'group')),
                    title TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_transcript (
                    position INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL,
                    binding TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    text TEXT NOT NULL,
                    sender TEXT,
                    at REAL,
                    UNIQUE(id, role)
                );
                CREATE TABLE IF NOT EXISTS wechat_transcript_migrated (binding TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS wechat_friend_transcript_scopes (
                    binding TEXT PRIMARY KEY,
                    title TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_friend_attempts (
                    id TEXT PRIMARY KEY,
                    friend TEXT NOT NULL,
                    at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS wechat_friend_attempts_by_friend ON wechat_friend_attempts(friend, at);
                CREATE INDEX IF NOT EXISTS wechat_friend_attempts_by_time ON wechat_friend_attempts(at);
                CREATE TABLE IF NOT EXISTS wechat_daily_digest (
                    position INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE,
                    binding TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    at REAL NOT NULL,
                    expires_at INTEGER NOT NULL,
                    transcript_pending INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS wechat_daily_digest_context
                    ON wechat_daily_digest (binding, expires_at, kind, position);
                CREATE TABLE IF NOT EXISTS wechat_digest_history (
                    binding TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    incoming TEXT NOT NULL,
                    reply TEXT NOT NULL,
                    PRIMARY KEY (binding, sequence)
                );
                CREATE TABLE IF NOT EXISTS wechat_local_context (
                    binding TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    PRIMARY KEY (binding, sequence)
                );
                CREATE TABLE IF NOT EXISTS wechat_queue_controls (
                    binding TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS wechat_db_pins (
                    binding TEXT PRIMARY KEY,
                    pin TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_db_cursors (
                    binding TEXT PRIMARY KEY,
                    revision TEXT NOT NULL,
                    cursors TEXT NOT NULL
                );
                -- Why a message was given up on. Its occurrence is plain 'skipped', which older builds know.
                CREATE TABLE IF NOT EXISTS wechat_dropped (
                    id TEXT PRIMARY KEY,
                    binding TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    at REAL NOT NULL
                );
                -- Owner messages of a kind the listener cannot answer: only the kind and when.
                CREATE TABLE IF NOT EXISTS wechat_skipped (
                    binding TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    at REAL NOT NULL
                );
                COMMIT;
            """)
        except BaseException:
            self.db.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.db.close()

    def checkpoint(self, binding: str) -> Checkpoint | None:
        row = self.db.execute(
            "SELECT sequence, observation FROM wechat_checkpoints WHERE binding = ?", (binding,)
        ).fetchone()
        return Checkpoint(row[0], json.loads(row[1])) if row is not None else None

    def is_latest_checkpoint_occurrence(self, event: Occurrence, revision: int) -> bool:
        return self.db.execute("""
            SELECT 1 FROM wechat_checkpoints c
            JOIN wechat_occurrences o ON o.binding = c.binding AND o.sequence = c.occurrence_sequence
            WHERE c.binding = ? AND c.sequence = ? AND o.id = ? AND o.sequence = ? AND o.status = 'prepared'
        """, (event.binding, revision, event.id, event.sequence)).fetchone() is not None

    def intake(self, binding: str, expected_sequence: int | None, observation: dict, pending=(), *,
               consume_mention: bool = False) -> tuple[Occurrence, ...]:
        """Save a new checkpoint and its newly proven events in one transaction."""
        checkpoint_json = _encode_observation(observation)
        encoded = []
        for candidate in pending:
            message_json = _encode_observation(candidate)
            if not isinstance(candidate.get("text"), str) or not candidate["text"].strip():
                raise ValueError("A pending occurrence needs its original text.")
            encoded.append(message_json)

        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if self.db.execute("SELECT 1 FROM wechat_db_cursors WHERE binding = ?", (binding,)).fetchone():
                raise StateConflict("The database owns intake for this binding.")
            current = self.db.execute(
                "SELECT sequence, occurrence_sequence FROM wechat_checkpoints WHERE binding = ?", (binding,)
            ).fetchone()
            if (current[0] if current else None) != expected_sequence:
                raise StateConflict("Checkpoint changed before intake.")
            if consume_mention and not self.db.execute(
                "DELETE FROM wechat_mentions WHERE binding = ?", (binding,)
            ).rowcount:
                raise StateConflict("The recorded mention is no longer available.")

            revision = current[0] + 1 if current else 1
            offset = current[1] if current else 0
            self.db.execute("""
                INSERT INTO wechat_checkpoints (binding, sequence, occurrence_sequence, observation)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (binding) DO UPDATE SET sequence = excluded.sequence,
                    occurrence_sequence = excluded.occurrence_sequence, observation = excluded.observation
            """, (binding, revision, offset + len(encoded), checkpoint_json))

            rows = []
            for sequence, message_json in enumerate(encoded, start=offset + 1):
                event_id = hashlib.sha256(f"{binding}:{sequence}".encode("utf-8")).hexdigest()
                rows.append((event_id, binding, sequence, message_json, "pending", None))
            self.db.executemany("""
                INSERT INTO wechat_occurrences (id, binding, sequence, observation, status, reply)
                VALUES (?, ?, ?, ?, ?, ?)
            """, rows)
            for event_id, _, _, message, _, _ in rows:
                incoming = json.loads(message)
                if "rich" not in incoming:
                    self._transcript_event(event_id, binding, "user", incoming["text"], incoming.get("sender"), time.time())
        return tuple(_occurrence(row) for row in rows)

    def database_pins(self):
        if not self._has_table("wechat_db_pins"):
            return {}
        return {binding: json.loads(pin) for binding, pin in self.db.execute("SELECT binding, pin FROM wechat_db_pins")}

    def _has_table(self, table):
        return self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None

    def pin_database_bindings(self, expected, updated):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if self.database_pins() != expected:
                raise StateConflict("Database binding authority changed.")
            self.db.executemany("""
                INSERT INTO wechat_db_pins(binding, pin) VALUES (?, ?)
                ON CONFLICT(binding) DO UPDATE SET pin = excluded.pin
            """, ((binding, _encode_observation(pin)) for binding, pin in updated.items()))

    def database_cursor(self, binding):
        if not self._has_table("wechat_db_cursors"):
            return None
        row = self.db.execute(
            "SELECT revision, cursors FROM wechat_db_cursors WHERE binding = ?", (binding,)
        ).fetchone()
        return (row[0], json.loads(row[1])) if row is not None else None

    def commit_database_batch(self, scopes, *, baseline, max_queue, ignored_owner_at, skipped=()):
        """Commit selected cursor changes, stable event IDs, and transcript rows as one unit."""
        full = set()
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            pins = self.database_pins()
            for binding, (expected, revision, cursors, pin, candidates) in scopes.items():
                if self.database_cursor(binding) != expected or pins.get(binding) != pin:
                    raise StateConflict("Database binding or cursor changed.")
                if baseline and expected is None and pin["target"] in ("group", "friend"):
                    # A re-bound chat must also have no unresolved send under
                    # the prior binding. A source cutover cannot acknowledge it.
                    previous = [other for other, saved in pins.items() if saved.get("retired")
                                and saved["account_id"] == pin["account_id"]
                                and saved["conversation_id"] == pin["conversation_id"]]
                    for other in previous:
                        if self.uncertain(other):
                            raise StateConflict("Resolve the previous chat's unconfirmed send before rebinding.")
                if baseline:
                    if expected is None and self.db.execute("""
                        SELECT 1 FROM wechat_occurrences WHERE binding = ?
                        AND status IN ('pending','prepared','attempted','uncertain')
                    """, (binding,)).fetchone():
                        raise StateConflict("Resolve the existing queue before switching message sources.")
                    if expected is not None:
                        self.db.execute("""
                            UPDATE wechat_occurrences SET status='skipped', observation=NULL, reply=NULL
                            WHERE binding=? AND status IN ('pending','prepared')
                            AND json_type(observation,'$.database')='object'
                        """, (binding,))
                    self.db.execute("DELETE FROM wechat_mentions WHERE binding = ?", (binding,))
                else:
                    if binding in ignored_owner_at:
                        # DB timestamps are seconds. An ignored row in the preview's second is ambiguous.
                        self.db.execute("""
                            UPDATE wechat_moment_previews SET interrupted=1
                            WHERE binding=? AND sent_at < ? + 1
                        """, (binding, ignored_owner_at[binding]))
                    blocked = self._append_database_events(binding, candidates, cursors, max_queue)
                    if blocked:
                        full.add(binding)
                        cursors = {
                            key: {**cursor, "local_id": min(cursor["local_id"], blocked.get(key, cursor["local_id"]))}
                            for key, cursor in cursors.items()
                        }
                self.db.execute("""
                    INSERT INTO wechat_db_cursors(binding, revision, cursors) VALUES (?, ?, ?)
                    ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,cursors=excluded.cursors
                """, (binding, revision, _encode_observation(cursors)))
            if not baseline and skipped:
                self.db.executemany("INSERT INTO wechat_skipped (binding, kind, at) VALUES (?, ?, ?)",
                                    [entry for entry in skipped if entry[0] in scopes])
                self.db.execute("DELETE FROM wechat_skipped WHERE at < (SELECT MAX(at) FROM wechat_skipped) - ?",
                                (7 * 24 * 60 * 60,))
        return full

    def _append_database_events(self, binding, candidates, cursors, max_queue):
        pending = self.pending(binding)
        controls = sum(database_queue_command(event.observation) for event in pending)
        ordinary = len(pending) - controls
        ready = {}
        blocked = {}
        for event_id, observation in _database_cursor_order(candidates):
            message = observation["database"]
            key = f'{message["database"]}/{message["conversation_id"]}'
            control = database_queue_command(observation)
            if event_id not in ready and not self.db.execute(
                "SELECT 1 FROM wechat_occurrences WHERE id = ?", (event_id,)
            ).fetchone():
                if control:
                    if controls >= len(QUEUE_COMMANDS):
                        if message["local_id"] <= cursors[key]["local_id"]:
                            blocked.setdefault(key, message["local_id"] - 1)
                        continue
                    controls += 1
                elif ordinary >= max_queue:
                    blocked.setdefault(key, message["local_id"] - 1)
                    continue
                else:
                    if key in blocked:
                        continue
                    ordinary += 1
                ready[event_id] = observation
        if not ready:
            return blocked
        offset = self.db.execute("""
            SELECT MAX(
                COALESCE((SELECT occurrence_sequence FROM wechat_checkpoints WHERE binding = ?), 0),
                COALESCE((SELECT MAX(sequence) FROM wechat_occurrences WHERE binding = ?), 0)
            )
        """, (binding, binding)).fetchone()[0]
        ordered = sorted(ready.items(), key=_database_event_order)
        for sequence, (event_id, incoming) in enumerate(ordered, start=offset + 1):
            reference = incoming.pop("forwardReference", None)
            rich = incoming.get("rich") or {}
            if incoming["database"]["target"] == "private":
                if rich.get("kind") == "forward" and "forwardKey" in rich:
                    self.db.execute("INSERT OR IGNORE INTO wechat_forward_references VALUES (?, ?, ?)",
                                    (binding, rich["forwardKey"], sequence))
                    self.db.execute("""
                        DELETE FROM wechat_forward_references WHERE binding = ? AND sequence < (
                            SELECT sequence FROM wechat_forward_references WHERE binding = ?
                            ORDER BY sequence DESC LIMIT 1 OFFSET 255
                        )
                    """, (binding, binding))
                if reference is not None and (reference["nativeForward"] or self.db.execute(
                    "SELECT 1 FROM wechat_forward_references WHERE binding = ? AND card_key = ?", (binding, reference["key"]),
                ).fetchone()):
                    incoming.pop("quote", None)
                    incoming["rich"] = {"kind": "quote", "evidence": "引用：聊天记录", "forwardKey": reference["key"]}
            self.db.execute("""
                INSERT INTO wechat_occurrences(id, binding, sequence, observation, status)
                VALUES (?, ?, ?, ?, 'pending')
            """, (event_id, binding, sequence, _encode_observation(incoming)))
            if "rich" not in incoming and not incoming.get("forwardCommand"):
                self._transcript_event(event_id, binding, "user", incoming["text"], incoming.get("sender"),
                                       incoming["database"]["created_at"])
        return blocked

    def database_event_is_current(self, binding, event_id, observation):
        row = self.db.execute("""
            SELECT observation FROM wechat_occurrences
            WHERE binding = ? AND id = ? AND status IN ('pending','prepared','attempted')
              AND json_type(observation,'$.database') = 'object'
        """, (binding, event_id)).fetchone()
        if row is None:
            return False
        saved = json.loads(row[0])
        return all(saved.get(key) == observation.get(key) for key in (
            "database", "direction", "text", "sender", "mentions_account", "group_policy_revision", "article", "rich", "quote", "forwardCommand",
        ))

    def _transcript_event(self, event_id, binding, role, text, sender, at):
        self.db.execute("""
            INSERT OR IGNORE INTO wechat_transcript (id, binding, role, text, sender, at)
            SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
                SELECT 1 FROM wechat_transcript_scopes WHERE binding = ?
                UNION ALL SELECT 1 FROM wechat_friend_transcript_scopes WHERE binding = ?
            )
        """, (event_id, binding, role, text, sender, at, binding, binding))

    def record_owner_notice(self, delivery_id, binding, text, at):
        """Record a confirmed notice inside the caller's delivery transaction."""
        self._transcript_event(delivery_id, binding, "assistant", text, None, at)

    def record_owner_digest(self, delivery_id, binding, kind, text, at):
        """Record an actually delivered digest inside the ledger transaction."""
        if kind not in DIGEST_KINDS:
            raise ValueError('Invalid digest kind.')
        self.db.execute("DELETE FROM wechat_daily_digest WHERE transcript_pending = 0 AND expires_at <= ?", (at,))
        self.db.execute("""
            INSERT OR IGNORE INTO wechat_daily_digest (id, binding, kind, text, at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (delivery_id, binding, kind, text, at, digest_day_end(at)))

    def daily_digest_context(self, binding, *, now=None):
        if not self._has_table('wechat_daily_digest'):
            return None
        at = time.time() if now is None else now
        expires_at = digest_day_end(at)
        selected = []
        for kind in DIGEST_KINDS:
            rows = self.db.execute("""
                SELECT position, text FROM wechat_daily_digest
                WHERE binding = ? AND expires_at = ? AND kind = ? AND at <= ?
                ORDER BY position DESC LIMIT 4
            """, (binding, expires_at, kind, at)).fetchall()
            remaining = DIGEST_BYTES_PER_KIND
            for position, text in reversed(rows):
                if remaining <= 0:
                    break
                excerpt = text.encode('utf-8')[:remaining].decode('utf-8', errors='ignore').rstrip()
                if excerpt:
                    selected.append((position, excerpt))
                    remaining -= len(excerpt.encode('utf-8'))
        if not selected:
            return None
        return {'items': [text for _, text in sorted(selected)], 'expiresAt': expires_at}

    def record_moment_preview(self, delivery_id, binding, at):
        """Keep the consent anchor after the transcript has been drained."""
        self.db.execute("""
            INSERT INTO wechat_moment_previews (binding, id, after_sequence, sent_at)
            SELECT ?, ?, COALESCE(MAX(sequence), 0), ? FROM wechat_occurrences WHERE binding = ?
            ON CONFLICT(binding) DO UPDATE SET id=excluded.id, after_sequence=excluded.after_sequence,
                sent_at=excluded.sent_at, interrupted=0
        """, (binding, delivery_id, at, binding))

    def moment_answer_context(self, binding, draft_id, event):
        if not self._has_table("wechat_moment_previews"):
            return "before-preview"
        preview = self.db.execute("""
            SELECT after_sequence, sent_at, interrupted
            FROM wechat_moment_previews WHERE binding=? AND id=?
        """, (binding, draft_id)).fetchone()
        if preview is None:
            return "before-preview"
        sequence, sent_at, interrupted = preview
        created_at = (event.observation.get("database") or {}).get("created_at")
        # DB intake can discover a message after the preview even if it was sent earlier.
        if event.sequence <= sequence or (type(created_at) is int and created_at <= sent_at):
            return "before-preview"
        return "next" if not interrupted and event.sequence == sequence + 1 else "later"

    def register_transcript_scopes(self, scopes):
        registered = self.db.execute(
            """SELECT s.binding, s.scope, s.title FROM wechat_transcript_scopes s JOIN wechat_transcript_migrated m USING(binding)
               UNION ALL SELECT binding, 'friend', title FROM wechat_friend_transcript_scopes"""
        ).fetchall()
        known = {binding: (scope, title) for binding, scope, title in registered}
        if all(known.get(binding) == value for binding, value in scopes.items()):
            return
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            for binding, (scope, title) in scopes.items():
                if scope == 'friend':
                    self.db.execute("""
                        INSERT INTO wechat_friend_transcript_scopes VALUES (?, ?)
                        ON CONFLICT(binding) DO UPDATE SET title = excluded.title
                    """, (binding, title))
                    continue
                self.db.execute("""
                    INSERT INTO wechat_transcript_scopes (binding, scope, title) VALUES (?, ?, ?)
                    ON CONFLICT(binding) DO UPDATE SET title = excluded.title
                """, (binding, scope, title))
                if not self.db.execute("INSERT OR IGNORE INTO wechat_transcript_migrated VALUES (?)", (binding,)).rowcount:
                    continue
                previous = self.db.execute("""
                    SELECT o.id, h.incoming, h.reply FROM wechat_history h
                    JOIN wechat_occurrences o USING (binding, sequence)
                    WHERE h.binding = ? AND o.status = 'sent' ORDER BY h.sequence
                """, (binding,)).fetchall()
                for event_id, incoming, reply in previous:
                    self._transcript_event(event_id, binding, "user", incoming, None, None)
                    self._transcript_event(event_id, binding, "assistant", reply, None, None)

    def transcript_batch(self, limit=50):
        scopes = 'SELECT binding, scope, title FROM wechat_transcript_scopes'
        if self._has_table('wechat_friend_transcript_scopes'):
            scopes += " UNION ALL SELECT binding, 'friend', title FROM wechat_friend_transcript_scopes"
        rows = self.db.execute(f"""
            SELECT t.id, t.binding, s.scope, s.title, t.role, t.text, t.at, t.sender
            FROM wechat_transcript t JOIN ({scopes}) s USING (binding)
            ORDER BY t.position LIMIT ?
        """, (limit + 1,)).fetchall()
        entries = []
        for event_id, binding, scope, title, role, text, at, sender in rows[:limit]:
            entry = {"id": event_id, "binding": binding, "scope": scope, "title": _transcript_label(title, 180) or "WeChat",
                     "role": role, "text": text, "at": at}
            if isinstance(sender, str) and (name := _transcript_label(sender, 80)):
                entry["sender"] = name
            if scope == 'friend':
                entry['wechatFriend'] = True
            entries.append(entry)
        more = len(rows) > limit
        if not more and self._has_table('wechat_daily_digest'):
            remaining = limit - len(entries)
            digests = self.db.execute("""
                SELECT d.id, d.binding, s.title, d.text, d.at
                FROM wechat_daily_digest d JOIN wechat_transcript_scopes s USING (binding)
                WHERE d.transcript_pending = 1 AND s.scope = 'private'
                ORDER BY d.position LIMIT ?
            """, (remaining + 1,)).fetchall()
            for event_id, binding, title, text, at in digests[:remaining]:
                entries.append({'id': event_id, 'binding': binding, 'scope': 'private', 'role': 'assistant',
                                'title': _transcript_label(title, 180) or 'WeChat', 'text': text, 'at': at,
                                'wechatDigest': True})
            more = len(digests) > remaining
        return {"version": 1, "entries": entries, "more": more}

    def acknowledge_transcript(self, identities):
        identities = tuple(identities)
        with self.db:
            self.db.executemany("DELETE FROM wechat_transcript WHERE id = ? AND role = ?", identities)
            self.db.executemany("UPDATE wechat_daily_digest SET transcript_pending = 0 WHERE id = ?",
                                [(event_id,) for event_id, role in identities if role == 'assistant'])
            self.db.execute("DELETE FROM wechat_daily_digest WHERE transcript_pending = 0 AND expires_at <= ?", (time.time(),))

    def note_mention(self, binding: str, observation: dict) -> bool:
        with self.db:
            return bool(self.db.execute("""
                INSERT OR IGNORE INTO wechat_mentions (binding, observation) VALUES (?, ?)
            """, (binding, _encode_observation(observation))).rowcount)

    def pending_mention(self, binding: str) -> dict | None:
        row = self.db.execute("SELECT observation FROM wechat_mentions WHERE binding = ?", (binding,)).fetchone()
        return json.loads(row[0]) if row is not None else None

    def clear_mention(self, binding: str) -> bool:
        with self.db:
            return bool(self.db.execute("DELETE FROM wechat_mentions WHERE binding = ?", (binding,)).rowcount)

    def pending(self, binding: str) -> tuple[Occurrence, ...]:
        return self._list(binding, ("pending", "prepared"))

    def pending_count(self, binding: str) -> int:
        return self.db.execute("""
            SELECT COUNT(*) FROM wechat_occurrences WHERE binding = ? AND status IN ('pending', 'prepared')
        """, (binding,)).fetchone()[0]

    def queue_paused(self, binding):
        return self.db.execute("SELECT 1 FROM wechat_queue_controls WHERE binding = ?", (binding,)).fetchone() is not None

    def prepare_queue_command(self, event, *, presentation):
        if not database_queue_command(event.observation or {}):
            return False
        command = event.observation["text"].strip().lower()
        binding = event.binding
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if not self.db.execute(
                "SELECT 1 FROM wechat_occurrences WHERE id=? AND binding=? AND status='pending'", (event.id, binding)
            ).fetchone():
                return False
            if command == "/pause-queue":
                self.db.execute("INSERT OR IGNORE INTO wechat_queue_controls VALUES (?)", (binding,))
                prefix = "已暂停普通私聊队列。"
            elif command == "/resume-queue":
                self.db.execute("DELETE FROM wechat_queue_controls WHERE binding = ?", (binding,))
                prefix = "已恢复普通私聊队列。"
            elif command == "/cancel-queue":
                placeholders = ", ".join("?" for _ in QUEUE_COMMANDS)
                changed = self.db.execute(f"""
                    UPDATE wechat_occurrences SET status='skipped', observation=NULL, reply=NULL
                    WHERE binding=? AND id<>? AND status IN ('pending','prepared')
                      AND (COALESCE(json_extract(observation,'$.database.type'), 0) <> 1
                           OR json_type(observation,'$.rich') IS NOT NULL
                           OR lower(trim(json_extract(observation,'$.text'))) NOT IN ({placeholders}))
                """, (binding, event.id, *sorted(QUEUE_COMMANDS))).rowcount
                prefix = f"已取消 {changed} 条尚未发送的私聊回复。"
            else:
                prefix = ""
            mode = "已暂停" if self.queue_paused(binding) else "运行中"
            pending = self.pending_count(binding) - 1
            uncertain = len(self.uncertain(binding))
            reply = f"{prefix}私聊队列{mode}，待处理 {pending} 条，发送待确认 {uncertain} 条。"
            changed = self.db.execute("""
                UPDATE wechat_occurrences SET status='prepared', reply=?,
                    observation=json_set(observation,'$.presentation',json(?))
                WHERE id=? AND status='pending'
            """, (reply, _encode_observation(presentation), event.id)).rowcount
            if changed != 1:
                raise StateConflict("Queue command changed during preparation.")
            return True

    def uncertain(self, binding: str) -> tuple[Occurrence, ...]:
        return self._list(binding, ("attempted", "uncertain"))

    def _list(self, binding: str, statuses: tuple[str, ...]) -> tuple[Occurrence, ...]:
        placeholders = ", ".join("?" for _ in statuses)
        rows = self.db.execute(f"""
            SELECT id, binding, sequence, observation, status, reply FROM wechat_occurrences
            WHERE binding = ? AND status IN ({placeholders}) ORDER BY sequence
        """, (binding, *statuses))
        return tuple(_occurrence(row) for row in rows)

    def prepare(self, event_id: str, reply: str, *, presentation: dict | None = None) -> bool:
        if not isinstance(reply, str) or not reply.strip():
            raise ValueError("A prepared occurrence needs reply text.")
        plan = _encode_observation(presentation) if presentation is not None else None
        with self.db:
            return bool(self.db.execute("""
                UPDATE wechat_occurrences SET status = 'prepared', reply = ?,
                    observation = CASE WHEN ? IS NULL THEN observation
                        ELSE json_set(observation, '$.presentation', json(?)) END
                WHERE id = ? AND status = 'pending'
            """, (reply, plan, plan, event_id)).rowcount)

    def mark_attempted(self, event_id: str, *, receipt_proof: dict | None = None) -> bool:
        proof = _encode_observation(receipt_proof) if receipt_proof is not None else None
        with self.db:
            row = self.db.execute("""
                UPDATE wechat_occurrences SET status = 'attempted',
                    observation = CASE WHEN ? IS NULL THEN observation
                        ELSE json_set(observation, '$.receipt_proof', json(?)) END
                WHERE id = ? AND status = 'prepared'
                RETURNING binding
            """, (proof, proof, event_id)).fetchone()
            if row is None:
                return False
            self.db.execute("UPDATE wechat_moment_previews SET interrupted=1 WHERE binding=?", (row[0],))
            return True

    def _friend_rate_allowed(self, friend, now):
        start_of_day = datetime.combine(datetime.fromtimestamp(now).date(), day_time.min).timestamp()
        minute, day = self.db.execute("""
            SELECT count(*) FILTER (WHERE at > ?), count(*) FILTER (WHERE at >= ?)
            FROM wechat_friend_attempts WHERE friend = ? AND at >= min(?, ?)
        """, (now - 60, start_of_day, friend, now - 60, start_of_day)).fetchone()
        total, = self.db.execute('SELECT count(*) FROM wechat_friend_attempts WHERE at > ?', (now - 3600,)).fetchone()
        return minute < FRIEND_REPLIES_PER_MINUTE and day < FRIEND_REPLIES_PER_DAY and total < ALL_FRIEND_REPLIES_PER_HOUR

    def skip_limited_friend(self, event_id, friend, *, now=None):
        """Discard over-limit requests before starting their model turn."""
        at = time.time() if now is None else now
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            if self._friend_rate_allowed(friend, at):
                return False
            return self._skip_limited_friend(event_id, friend, at)

    def _skip_limited_friend(self, event_id, friend, at):
        row = self.db.execute("""
            UPDATE wechat_occurrences SET status='skipped', observation=NULL, reply=NULL
            WHERE id=? AND status IN ('pending', 'prepared')
              AND json_extract(observation, '$.database.target')='friend'
              AND json_extract(observation, '$.database.conversation_id')=?
            RETURNING binding
        """, (event_id, friend)).fetchone()
        if row is not None:
            self.db.execute('INSERT INTO wechat_skipped (binding, kind, at) VALUES (?, ?, ?)', (row[0], 'friend_rate_limited', at))
        return row is not None

    def mark_friend_attempted(self, event_id, friend, receipt_proof, *, now=None):
        """Account for a possible click atomically, including uncertain delivery."""
        at = time.time() if now is None else now
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM wechat_friend_attempts WHERE at < ?', (at - 2 * 86400,))
            if not self._friend_rate_allowed(friend, at):
                return 'friend_rate_limited' if self._skip_limited_friend(event_id, friend, at) else 'friend_binding_invalid'
            row = self.db.execute("""
                UPDATE wechat_occurrences SET status='attempted', observation=json_set(observation, '$.receipt_proof', json(?))
                WHERE id=? AND status='prepared' AND json_extract(observation, '$.database.target')='friend'
                  AND json_extract(observation, '$.database.conversation_id')=?
                RETURNING id
            """, (_encode_observation(receipt_proof), event_id, friend)).fetchone()
            if row is None:
                return 'friend_binding_invalid'
            self.db.execute('INSERT INTO wechat_friend_attempts VALUES (?, ?, ?)', (event_id, friend, at))
            return 'attempted'

    def update_attempt_proof(self, event_id: str, proof: dict) -> bool:
        """Record the latest part before its click, retaining no replayable part index."""
        with self.db:
            return bool(self.db.execute("""
                UPDATE wechat_occurrences SET observation = json_set(observation, '$.receipt_proof', json(?))
                WHERE id = ? AND status = 'attempted' AND observation IS NOT NULL
            """, (_encode_observation(proof), event_id)).rowcount)

    def set_prepared_reply(self, event_id: str, reply: str) -> bool:
        if not isinstance(reply, str) or not reply.strip():
            raise ValueError("A prepared occurrence needs reply text.")
        with self.db:
            return bool(self.db.execute("UPDATE wechat_occurrences SET reply = ? WHERE id = ? AND status = 'prepared'",
                                        (reply, event_id)).rowcount)

    def reset_prepared(self, event_id: str) -> bool:
        """Discard a prepared reply after its model route changes, before any send attempt."""
        with self.db:
            return bool(self.db.execute("""
                UPDATE wechat_occurrences SET status = 'pending', reply = NULL,
                    observation = json_remove(observation, '$.presentation')
                WHERE id = ? AND status = 'prepared'
            """, (event_id,)).rowcount)

    def mark_sent(self, event_id: str) -> bool:
        return self._confirm_sent(event_id, "attempted")

    def reconcile_sent(self, event_id: str) -> bool:
        """Commit a receipt the listener independently verified after an uncertain send."""
        return self._confirm_sent(event_id, "uncertain")

    def _confirm_sent(self, event_id: str, expected_status: str) -> bool:
        with self.db:
            row = self.db.execute("""
                UPDATE wechat_occurrences SET status = 'sent'
                WHERE id = ? AND status = ? AND observation IS NOT NULL AND reply IS NOT NULL
                  AND (? = 'attempted' OR json_extract(observation, '$.receipt_proof.version') = 1)
                RETURNING binding, sequence, observation, reply
            """, (event_id, expected_status, expected_status)).fetchone()
            if row is None:
                return False
            binding, sequence, observation, reply = row
            decoded = json.loads(observation)
            legacy_chat_quote = "rich" in decoded and chat_quote_excerpt(decoded) is not None
            if ("rich" in decoded and not legacy_chat_quote) or decoded.get("forwardCommand") or (decoded.get("presentation") or {}).get("ephemeralReply") is True:
                self.db.execute("UPDATE wechat_occurrences SET observation = NULL, reply = NULL WHERE id = ?", (event_id,))
                return True
            if legacy_chat_quote:
                self._transcript_event(event_id, binding, "user", decoded["text"], decoded.get("sender"),
                                       decoded["database"]["created_at"])
            sent_at = time.time()
            digest_until = (decoded.get('presentation') or {}).get('dailyDigestUntil')
            if type(digest_until) is int:
                self.db.execute("""
                    INSERT OR IGNORE INTO wechat_daily_digest (id, binding, kind, text, at, expires_at)
                    VALUES (?, ?, 'reply', ?, ?, ?)
                """, (event_id, binding, reply, sent_at, digest_until))
                self.db.execute("INSERT OR IGNORE INTO wechat_digest_history VALUES (?, ?, ?, ?, ?)",
                                (binding, sequence, digest_until, decoded['text'], reply))
            else:
                self._transcript_event(event_id, binding, "assistant", reply, None, sent_at)
                self.db.execute("""
                    INSERT INTO wechat_history (binding, sequence, incoming, reply) VALUES (?, ?, ?, ?)
                """, (binding, sequence, decoded['text'], reply))
            if (decoded.get("presentation") or {}).get("localContext") is True:
                self.db.execute("INSERT OR IGNORE INTO wechat_local_context VALUES (?, ?)", (binding, sequence))
            history_turns = OWNER_HISTORY_TURNS if (decoded.get("database") or {}).get("target") == "private" else HISTORY_TURNS
            self.db.execute("""
                DELETE FROM wechat_history WHERE binding = ? AND sequence NOT IN (
                    SELECT sequence FROM wechat_history WHERE binding = ? ORDER BY sequence DESC LIMIT ?
                )
            """, (binding, binding, history_turns))
            self.db.execute("""
                DELETE FROM wechat_digest_history WHERE binding = ? AND (expires_at <= ? OR sequence NOT IN (
                    SELECT sequence FROM wechat_digest_history WHERE binding = ? ORDER BY sequence DESC LIMIT ?
                ))
            """, (binding, sent_at, binding, history_turns))
            self.db.execute("""
                DELETE FROM wechat_local_context WHERE binding = ? AND sequence NOT IN (
                    SELECT sequence FROM wechat_history WHERE binding = ?
                    UNION SELECT sequence FROM wechat_digest_history WHERE binding = ?
                )
            """, (binding, binding, binding))
            self.db.execute("UPDATE wechat_occurrences SET observation = NULL, reply = NULL WHERE id = ?", (event_id,))
            return True

    def mark_uncertain(self, event_id: str) -> bool:
        with self.db:
            return bool(self.db.execute("""
                UPDATE wechat_occurrences SET status = 'uncertain',
                    observation = CASE WHEN json_extract(observation, '$.receipt_proof.version') = 1 THEN observation END,
                    reply = CASE WHEN json_extract(observation, '$.receipt_proof.version') = 1 THEN reply END
                WHERE id = ? AND status = 'attempted'
            """, (event_id,)).rowcount)

    def recover_attempted(self, binding: str) -> int:
        with self.db:
            return self.db.execute("""
                UPDATE wechat_occurrences SET status = 'uncertain',
                    observation = CASE WHEN json_extract(observation, '$.receipt_proof.version') = 1 THEN observation END,
                    reply = CASE WHEN json_extract(observation, '$.receipt_proof.version') = 1 THEN reply END
                WHERE binding = ? AND status = 'attempted'
            """, (binding,)).rowcount

    def acknowledge_uncertain(self, binding: str) -> int:
        with self.db:
            return self.db.execute("""
                UPDATE wechat_occurrences SET status = 'skipped', observation = NULL, reply = NULL
                WHERE binding = ? AND status = 'uncertain'
            """, (binding,)).rowcount

    def rebaseline(self, binding: str, observation: dict):
        encoded = _encode_observation(observation)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            self.db.execute("""
                INSERT INTO wechat_checkpoints (binding, sequence, occurrence_sequence, observation)
                VALUES (?, 1, 0, ?)
                ON CONFLICT (binding) DO UPDATE SET sequence = sequence + 1, observation = excluded.observation
            """, (binding, encoded))
            self.db.execute("DELETE FROM wechat_mentions WHERE binding = ?", (binding,))
            self.db.execute("""
                UPDATE wechat_occurrences SET status = 'skipped', observation = NULL, reply = NULL
                WHERE binding = ? AND status IN ('pending', 'prepared')
            """, (binding,))

    def skip(self, event_id: str) -> bool:
        with self.db:
            return bool(self.db.execute("""
                UPDATE wechat_occurrences SET status = 'skipped', observation = NULL, reply = NULL
                WHERE id = ? AND status IN ('pending', 'prepared')
            """, (event_id,)).rowcount)

    def give_up(self, event_id: str, reason: str) -> bool:
        """Let the conversation move on past a message that cannot be answered, keeping only why.

        Never one that may be on screen half-sent: an attempted send stays for its receipt check."""
        with self.db:
            row = self.db.execute("""
                SELECT binding FROM wechat_occurrences WHERE id = ? AND status IN ('pending', 'prepared', 'uncertain')
            """, (event_id,)).fetchone()
            if row is None:
                return False
            self.db.execute("UPDATE wechat_occurrences SET status = 'skipped', observation = NULL, reply = NULL WHERE id = ?",
                            (event_id,))
            self.db.execute("INSERT OR REPLACE INTO wechat_dropped (id, binding, reason, at) VALUES (?, ?, ?, ?)",
                            (event_id, row[0], reason, time.time()))
            return True

    def skipped_since(self, since: float) -> list[tuple[str, float]]:
        """(kind, at) for each owner message the listener could not answer since then, newest first."""
        if not self._has_table("wechat_skipped"):
            return []
        return [tuple(row) for row in self.db.execute(
            "SELECT kind, at FROM wechat_skipped WHERE at >= ? ORDER BY at DESC LIMIT 100", (since,))]

    def dropped_since(self, since: float) -> list[tuple[str, str, float]]:
        """(binding, reason, at) for each message given up on since then, newest first."""
        if not self._has_table("wechat_dropped"):
            return []
        return [tuple(row) for row in self.db.execute(
            "SELECT binding, reason, at FROM wechat_dropped WHERE at >= ? ORDER BY at DESC LIMIT 100", (since,))]

    def history(self, binding: str, *, for_cloud: bool = False, owner: bool = False) -> list[dict[str, str]]:
        history = 'SELECT sequence, incoming, reply FROM wechat_history WHERE binding = ?'
        params = [binding]
        if self._has_table('wechat_digest_history'):
            history += ' UNION ALL SELECT sequence, incoming, reply FROM wechat_digest_history WHERE binding = ? AND expires_at = ?'
            params.extend((binding, digest_day_end(time.time())))
        rows = self.db.execute(f"""
            SELECT incoming, reply FROM (
                SELECT sequence, incoming, reply FROM ({history}) h
                WHERE NOT ? OR NOT EXISTS (
                    SELECT 1 FROM wechat_local_context p WHERE p.binding = ? AND p.sequence = h.sequence
                ) ORDER BY sequence DESC LIMIT ?
            ) ORDER BY sequence
        """, (*params, for_cloud, binding, OWNER_HISTORY_TURNS if owner else HISTORY_TURNS)).fetchall()
        if owner:
            while sum(len(incoming) + len(reply) for incoming, reply in rows) > OWNER_HISTORY_CHARACTERS:
                rows.pop(0)
        return [item for incoming, reply in rows for item in (
            {"role": "user", "text": incoming}, {"role": "assistant", "text": reply}
        )]
