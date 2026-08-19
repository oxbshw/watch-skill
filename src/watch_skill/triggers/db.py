"""Durable triggers, their cursors, and every firing they produced.

The cursor is the whole replay story. Evaluation reads events strictly after
a stored sequence number and advances it in the same transaction that records
what fired, so redelivering events, restarting mid-stream, or running two
evaluators at once all converge on the same firings rather than duplicating
them.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.sqlite_util import apply_migrations, enable_wal
from watch_skill.triggers.types import (
    Firing,
    Trigger,
    TriggerAction,
    TriggerCondition,
    TriggerState,
)

MIGRATIONS: list[str] = [
    """
    CREATE TABLE triggers (
        trigger_id      TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        session_id      TEXT NOT NULL,
        name            TEXT NOT NULL DEFAULT '',
        condition_json  TEXT NOT NULL,
        action_json     TEXT,
        state           TEXT NOT NULL DEFAULT 'enabled',
        dry_run         INTEGER NOT NULL DEFAULT 0,
        once            INTEGER NOT NULL DEFAULT 0,
        debounce_seconds REAL NOT NULL DEFAULT 0,
        cooldown_seconds REAL NOT NULL DEFAULT 0,
        max_firings_per_window INTEGER NOT NULL DEFAULT 0,
        firing_window_seconds REAL NOT NULL DEFAULT 60,
        max_firings_total INTEGER NOT NULL DEFAULT 0,
        expires_at      REAL,
        idempotency_prefix TEXT NOT NULL DEFAULT '',
        created_at      REAL NOT NULL,
        -- evaluation state, updated in the same transaction as a firing
        cursor_seq      INTEGER NOT NULL DEFAULT 0,
        fire_count      INTEGER NOT NULL DEFAULT 0,
        last_fired_at   REAL,
        last_matched_at REAL,
        armed_media_ts  REAL NOT NULL DEFAULT 0,
        window_json     TEXT NOT NULL DEFAULT '[]',
        step_index      INTEGER NOT NULL DEFAULT 0,
        step_started_ts REAL,
        failures        INTEGER NOT NULL DEFAULT 0,
        dead_letter_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_triggers_session ON triggers(session_id, state);

    CREATE TABLE trigger_firings (
        trigger_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        cause_seq   INTEGER NOT NULL,
        media_ts    REAL NOT NULL,
        wall_ts     REAL NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        trace_json  TEXT NOT NULL DEFAULT '{}',
        action_id   TEXT,
        suppressed  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (trigger_id, seq)
    );
    -- One firing per (trigger, causing event), enforced by the database.
    -- This is what makes an action proposal exactly-once under redelivery
    -- rather than merely usually-once.
    CREATE UNIQUE INDEX idx_firings_cause
        ON trigger_firings(trigger_id, cause_seq);
    CREATE INDEX idx_firings_session ON trigger_firings(session_id, wall_ts);
    """,
]


def triggers_path() -> Path:
    return get_settings().data_dir / "triggers.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path if db_path is not None else triggers_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    enable_wal(conn)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = FULL")
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    """Bring this database up to date, safely under concurrency.

    Delegated so the write lock is taken before the version is read; doing it
    inline meant two processes both saw version 0 and the loser died with
    "table already exists".
    """
    return apply_migrations(conn, MIGRATIONS)


def _row_to_trigger(row: sqlite3.Row) -> Trigger:
    return Trigger(
        trigger_id=row["trigger_id"],
        schema_version=row["schema_version"],
        session_id=row["session_id"],
        name=row["name"],
        condition=TriggerCondition.model_validate_json(row["condition_json"]),
        action=(TriggerAction.model_validate_json(row["action_json"])
                if row["action_json"] else None),
        state=TriggerState(row["state"]),
        dry_run=bool(row["dry_run"]),
        once=bool(row["once"]),
        debounce_seconds=row["debounce_seconds"],
        cooldown_seconds=row["cooldown_seconds"],
        max_firings_per_window=row["max_firings_per_window"],
        firing_window_seconds=row["firing_window_seconds"],
        max_firings_total=row["max_firings_total"],
        expires_at=row["expires_at"],
        idempotency_prefix=row["idempotency_prefix"],
        created_at=row["created_at"],
    )


def insert_trigger(trigger: Trigger) -> Trigger:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO triggers (trigger_id, session_id, name, "
                "condition_json, action_json, state, dry_run, once, "
                "debounce_seconds, cooldown_seconds, max_firings_per_window, "
                "firing_window_seconds, max_firings_total, expires_at, "
                "idempotency_prefix, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (trigger.trigger_id, trigger.session_id, trigger.name,
                 trigger.condition.model_dump_json(),
                 trigger.action.model_dump_json() if trigger.action else None,
                 trigger.state.value, int(trigger.dry_run), int(trigger.once),
                 trigger.debounce_seconds, trigger.cooldown_seconds,
                 trigger.max_firings_per_window, trigger.firing_window_seconds,
                 trigger.max_firings_total, trigger.expires_at,
                 trigger.idempotency_prefix, trigger.created_at),
            )
        return trigger
    finally:
        conn.close()


def get_trigger(trigger_id: str) -> Trigger | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM triggers WHERE trigger_id = ?",
                           (trigger_id,)).fetchone()
        return _row_to_trigger(row) if row else None
    finally:
        conn.close()


def evaluation_state(trigger_id: str) -> dict[str, Any] | None:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT cursor_seq, fire_count, last_fired_at, last_matched_at, "
            "armed_media_ts, window_json, step_index, step_started_ts, failures, "
            "dead_letter_reason FROM triggers WHERE trigger_id = ?",
            (trigger_id,)).fetchone()
        if row is None:
            return None
        return {
            "cursor_seq": row["cursor_seq"],
            "fire_count": row["fire_count"],
            "last_fired_at": row["last_fired_at"],
            "last_matched_at": row["last_matched_at"],
            "armed_media_ts": row["armed_media_ts"],
            "window": json.loads(row["window_json"] or "[]"),
            "step_index": row["step_index"],
            "step_started_ts": row["step_started_ts"],
            "failures": row["failures"],
            "dead_letter_reason": row["dead_letter_reason"],
        }
    finally:
        conn.close()


def save_evaluation_state(trigger_id: str, state: dict[str, Any]) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "UPDATE triggers SET cursor_seq=?, fire_count=?, last_fired_at=?, "
                "last_matched_at=?, armed_media_ts=?, window_json=?, step_index=?, "
                "step_started_ts=?, failures=?, dead_letter_reason=? "
                "WHERE trigger_id=?",
                (state["cursor_seq"], state["fire_count"], state["last_fired_at"],
                 state["last_matched_at"], state["armed_media_ts"],
                 json.dumps(state["window"]), state["step_index"],
                 state["step_started_ts"], state["failures"],
                 state["dead_letter_reason"], trigger_id),
            )
    finally:
        conn.close()


def set_state(trigger_id: str, state: TriggerState, reason: str = "") -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "UPDATE triggers SET state = ?, dead_letter_reason = ? "
                "WHERE trigger_id = ?", (state.value, reason, trigger_id))
    finally:
        conn.close()


def list_triggers(session_id: str | None = None, state: str | None = None,
                  limit: int = 100) -> list[Trigger]:
    clauses, params = [], []
    if session_id:
        clauses.append("session_id = ?")
        params.append(session_id)
    if state:
        clauses.append("state = ?")
        params.append(state)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT * FROM triggers {where} ORDER BY created_at DESC LIMIT ?",
            params).fetchall()
        return [_row_to_trigger(row) for row in rows]
    finally:
        conn.close()


def record_firing(firing: Firing) -> Firing | None:
    """Write a firing, or return None because this cause already fired.

    The uniqueness is the database's, not the caller's. A caller that checked
    first and then inserted would still double-propose under concurrency, and
    concurrency here is ordinary: two processes may evaluate the same session.
    """
    conn = connect()
    try:
        with conn:
            # The sequence is allocated by a subquery *inside* the INSERT, not
            # by a SELECT before it. Python's sqlite3 opens the IMMEDIATE
            # transaction on the first DML statement, so a preceding SELECT
            # would run outside the write lock — two processes would then read
            # the same MAX(seq), and the loser's IntegrityError is
            # indistinguishable from the cause_seq clash below. It would be
            # reported as "this cause already fired" and the firing would
            # vanish. Allocating inside the statement serializes on the lock,
            # which leaves the cause_seq index as the only way to fail here.
            try:
                conn.execute(
                    "INSERT INTO trigger_firings (trigger_id, seq, session_id, "
                    "cause_seq, media_ts, wall_ts, reason, trace_json, action_id, "
                    "suppressed) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 "
                    "FROM trigger_firings WHERE trigger_id = ?), ?,?,?,?,?,?,?,?)",
                    (firing.trigger_id, firing.trigger_id, firing.session_id,
                     firing.cause_seq, firing.media_ts, firing.wall_ts,
                     firing.reason, json.dumps(firing.trace, default=str),
                     firing.action_id, firing.suppressed),
                )
            except sqlite3.IntegrityError:
                return None  # this cause already fired; redelivery must not duplicate
            seq = int(conn.execute(
                "SELECT seq FROM trigger_firings WHERE trigger_id = ? "
                "AND cause_seq = ?",
                (firing.trigger_id, firing.cause_seq)).fetchone()["seq"])
            if not firing.suppressed:
                conn.execute(
                    "UPDATE triggers SET fire_count = fire_count + 1, "
                    "last_fired_at = ? WHERE trigger_id = ?",
                    (time.time(), firing.trigger_id))
            firing.seq = seq
            return firing
    finally:
        conn.close()


def attach_action(trigger_id: str, seq: int, action_id: str) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "UPDATE trigger_firings SET action_id = ? "
                "WHERE trigger_id = ? AND seq = ?", (action_id, trigger_id, seq))
    finally:
        conn.close()


def list_firings(trigger_id: str, limit: int = 100,
                 include_suppressed: bool = True) -> list[Firing]:
    conn = connect()
    try:
        query = "SELECT * FROM trigger_firings WHERE trigger_id = ?"
        if not include_suppressed:
            query += " AND suppressed = ''"
        query += " ORDER BY seq LIMIT ?"
        rows = conn.execute(query, (trigger_id, limit)).fetchall()
        return [
            Firing(trigger_id=r["trigger_id"], seq=r["seq"],
                   session_id=r["session_id"], cause_seq=r["cause_seq"],
                   media_ts=r["media_ts"], wall_ts=r["wall_ts"],
                   reason=r["reason"], trace=json.loads(r["trace_json"] or "{}"),
                   action_id=r["action_id"], suppressed=r["suppressed"])
            for r in rows
        ]
    finally:
        conn.close()


def firings_since(trigger_id: str, since_wall: float) -> int:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM trigger_firings WHERE trigger_id = ? "
            "AND wall_ts >= ? AND suppressed = ''", (trigger_id, since_wall)
        ).fetchone()
        return int(row["n"])
    finally:
        conn.close()
