"""Durable storage for live sessions and their event log.

Its own database for the same reason jobs have one: a live session writes
several rows a second, and that write rate has no business contending with
the index that answers questions.

Events are append-only and addressed by ``seq``. That is what makes
``observe_live`` idempotent — asking for everything after seq N twice returns
the same thing twice, so a client that retries a dropped response does not
lose or double-count anything.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.live.types import (
    LiveEvent,
    LiveEventType,
    LiveSession,
    LiveSourceSpec,
    LiveState,
    Provenance,
)

MIGRATIONS: list[str] = [
    # v1 — sessions and their append-only events.
    """
    CREATE TABLE live_sessions (
        session_id      TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        state           TEXT NOT NULL DEFAULT 'starting',
        spec_json       TEXT NOT NULL,
        budget_json     TEXT NOT NULL DEFAULT '{}',
        stats_json      TEXT NOT NULL DEFAULT '{}',
        policy_json     TEXT NOT NULL DEFAULT '{}',
        started_at      REAL NOT NULL,
        heartbeat_at    REAL NOT NULL,
        stopped_at      REAL,
        finalized_video_id TEXT,
        error_json      TEXT,
        last_seq        INTEGER NOT NULL DEFAULT 0,
        CHECK (state IN ('starting','running','paused','stopping','stopped',
                         'finalized','failed'))
    );
    CREATE INDEX idx_live_sessions_state ON live_sessions(state, started_at);

    CREATE TABLE live_events (
        session_id   TEXT NOT NULL REFERENCES live_sessions(session_id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        media_ts     REAL NOT NULL,
        wall_ts      REAL NOT NULL,
        type         TEXT NOT NULL,
        final        INTEGER NOT NULL DEFAULT 1,
        confidence   REAL NOT NULL DEFAULT 1.0,
        provenance   TEXT NOT NULL DEFAULT 'observation',
        summary      TEXT NOT NULL DEFAULT '',
        detector     TEXT NOT NULL DEFAULT '',
        trace_id     TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX idx_live_events_ts ON live_events(session_id, media_ts);
    CREATE INDEX idx_live_events_type ON live_events(session_id, type, seq);

    -- Rolling buffer segments. Rows outlive the files they point at, so a
    -- pinned segment can be proved missing rather than silently returning
    -- nothing.
    CREATE TABLE live_segments (
        session_id  TEXT NOT NULL REFERENCES live_sessions(session_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL,
        kind        TEXT NOT NULL,          -- frame | audio | clip
        path        TEXT NOT NULL,
        media_ts    REAL NOT NULL,
        end_media_ts REAL,
        bytes       INTEGER NOT NULL DEFAULT 0,
        pinned      INTEGER NOT NULL DEFAULT 0,
        expired     INTEGER NOT NULL DEFAULT 0,
        digest      TEXT,
        PRIMARY KEY (session_id, artifact_id)
    );
    CREATE INDEX idx_live_segments_ts ON live_segments(session_id, kind, media_ts);
    CREATE INDEX idx_live_segments_evict
        ON live_segments(session_id, pinned, expired, media_ts);
    """,
]


def live_path() -> Path:
    return get_settings().data_dir / "live.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path if db_path is not None else live_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row["v"]) if row and row["v"] is not None else 0


def migrate(conn: sqlite3.Connection) -> int:
    current = schema_version(conn)
    for version, migration in enumerate(MIGRATIONS, start=1):
        if version <= current:
            continue
        with conn:
            conn.executescript(migration)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    return schema_version(conn)


# --- sessions ---------------------------------------------------------------


def insert_session(session: LiveSession) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO live_sessions (session_id, state, spec_json, budget_json, "
                "stats_json, policy_json, started_at, heartbeat_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session.session_id, session.state.value,
                 session.spec.model_dump_json(), session.budget.model_dump_json(),
                 session.stats.model_dump_json(),
                 json.dumps(session.policy_snapshot, default=str),
                 session.started_at, session.heartbeat_at),
            )
    finally:
        conn.close()


def _row_to_session(row: sqlite3.Row) -> LiveSession:
    from watch_skill.live.types import LiveBudget, LiveStats

    return LiveSession(
        session_id=row["session_id"],
        schema_version=row["schema_version"],
        spec=LiveSourceSpec.model_validate_json(row["spec_json"]),
        state=LiveState(row["state"]),
        budget=LiveBudget.model_validate_json(row["budget_json"] or "{}"),
        stats=LiveStats.model_validate_json(row["stats_json"] or "{}"),
        policy_snapshot=json.loads(row["policy_json"] or "{}"),
        started_at=row["started_at"],
        heartbeat_at=row["heartbeat_at"],
        stopped_at=row["stopped_at"],
        finalized_video_id=row["finalized_video_id"],
        error=json.loads(row["error_json"]) if row["error_json"] else None,
        last_seq=row["last_seq"],
    )


def get_session(session_id: str) -> LiveSession | None:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM live_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        return _row_to_session(row) if row else None
    finally:
        conn.close()


def list_sessions(active_only: bool = False, limit: int = 50) -> list[LiveSession]:
    conn = connect()
    try:
        if active_only:
            rows = conn.execute(
                "SELECT * FROM live_sessions WHERE state IN "
                "('starting','running','paused','stopping') "
                "ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM live_sessions ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row_to_session(row) for row in rows]
    finally:
        conn.close()


def update_session(
    session_id: str,
    *,
    state: LiveState | None = None,
    stats: Any = None,
    stopped_at: float | None = None,
    finalized_video_id: str | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    sets = ["heartbeat_at = ?"]
    params: list[Any] = [time.time()]
    if state is not None:
        sets.append("state = ?")
        params.append(state.value)
    if stats is not None:
        sets.append("stats_json = ?")
        params.append(stats.model_dump_json())
    if stopped_at is not None:
        sets.append("stopped_at = ?")
        params.append(stopped_at)
    if finalized_video_id is not None:
        sets.append("finalized_video_id = ?")
        params.append(finalized_video_id)
    if error is not None:
        sets.append("error_json = ?")
        params.append(json.dumps(error, default=str))
    params.append(session_id)
    conn = connect()
    try:
        with conn:
            conn.execute(
                f"UPDATE live_sessions SET {', '.join(sets)} WHERE session_id = ?",
                params,
            )
    finally:
        conn.close()


def recover_orphaned_sessions(stale_after: float = 120.0) -> int:
    """Mark sessions whose process died as stopped.

    A live session cannot resume after its capture process is gone — the
    media it was watching moved on. So recovery means admitting it ended,
    not pretending it continues; the buffer and events it did produce stay
    queryable and finalizable.
    """
    cutoff = time.time() - stale_after
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE live_sessions SET state = 'stopped', stopped_at = ?, "
                "error_json = ? WHERE state IN ('starting','running','paused','stopping') "
                "AND heartbeat_at < ?",
                (time.time(), json.dumps({
                    "error": "live.session_orphaned",
                    "message": "the process running this session stopped heartbeating",
                    "fix": "the events and buffer it produced are still readable; "
                           "finalize it or start a new session",
                }), cutoff),
            )
            return cursor.rowcount
    finally:
        conn.close()


# --- events -----------------------------------------------------------------


def append_event(event: LiveEvent) -> int:
    """Append one event, allocating its sequence number atomically.

    The allocation and the insert are one transaction, so two detector
    threads emitting at the same instant get distinct, gapless sequence
    numbers — a duplicate seq would make cursors ambiguous.
    """
    conn = connect()
    try:
        with conn:
            row = conn.execute(
                "SELECT last_seq FROM live_sessions WHERE session_id = ?",
                (event.session_id,),
            ).fetchone()
            if row is None:
                return 0
            seq = row["last_seq"] + 1
            payload = {
                "evidence": [ref.model_dump() for ref in event.evidence],
                "entities": [e.model_dump() for e in event.entities],
                "state_changes": [c.model_dump() for c in event.state_changes],
                "detail": event.detail,
            }
            conn.execute(
                "INSERT INTO live_events (session_id, seq, media_ts, wall_ts, type, "
                "final, confidence, provenance, summary, detector, trace_id, payload_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (event.session_id, seq, event.media_ts, event.wall_ts,
                 event.type.value, int(event.final), event.confidence,
                 event.provenance.value, event.summary, event.detector,
                 event.trace_id, json.dumps(payload, default=str)),
            )
            conn.execute(
                "UPDATE live_sessions SET last_seq = ?, heartbeat_at = ? "
                "WHERE session_id = ?",
                (seq, time.time(), event.session_id),
            )
            return seq
    finally:
        conn.close()


def _row_to_event(row: sqlite3.Row) -> LiveEvent:
    from watch_skill.live.types import EvidenceReference, StateChange, TemporalEntity

    payload = json.loads(row["payload_json"] or "{}")
    return LiveEvent(
        session_id=row["session_id"],
        seq=row["seq"],
        media_ts=row["media_ts"],
        wall_ts=row["wall_ts"],
        type=LiveEventType(row["type"]),
        final=bool(row["final"]),
        confidence=row["confidence"],
        provenance=Provenance(row["provenance"]),
        summary=row["summary"],
        detector=row["detector"],
        trace_id=row["trace_id"],
        evidence=[EvidenceReference(**e) for e in payload.get("evidence", [])],
        entities=[TemporalEntity(**e) for e in payload.get("entities", [])],
        state_changes=[StateChange(**c) for c in payload.get("state_changes", [])],
        detail=payload.get("detail", {}),
    )


def read_events(
    session_id: str,
    after_seq: int = 0,
    limit: int = 100,
    types: list[str] | None = None,
    since_media_ts: float | None = None,
    until_media_ts: float | None = None,
) -> list[LiveEvent]:
    """Events after a cursor. Deterministic and repeatable for one cursor."""
    clauses = ["session_id = ?", "seq > ?"]
    params: list[Any] = [session_id, after_seq]
    if types:
        clauses.append("type IN ({})".format(",".join("?" * len(types))))
        params += types
    if since_media_ts is not None:
        clauses.append("media_ts >= ?")
        params.append(since_media_ts)
    if until_media_ts is not None:
        clauses.append("media_ts <= ?")
        params.append(until_media_ts)
    params.append(max(1, min(limit, 500)))
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT * FROM live_events WHERE {' AND '.join(clauses)} "
            "ORDER BY seq LIMIT ?",
            params,
        ).fetchall()
        return [_row_to_event(row) for row in rows]
    finally:
        conn.close()


def count_events(session_id: str) -> int:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM live_events WHERE session_id = ?", (session_id,)
        ).fetchone()
        return int(row["n"])
    finally:
        conn.close()
