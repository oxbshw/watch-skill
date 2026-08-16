"""Durable Observer Loop runs.

A loop that only exists in memory cannot survive the crash it is most likely
to cause, and "did the correction get applied before we died?" is exactly the
question a restart needs answered. So the run is a row, written after every
step, and resuming means reading it rather than guessing.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.observer.types import (
    Budgets,
    CorrectionSpec,
    ObserverRun,
    ObserverState,
    Spend,
    VerificationAttempt,
)

MIGRATIONS: list[str] = [
    """
    CREATE TABLE observer_runs (
        run_id          TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        contract_id     TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'created',
        iteration       INTEGER NOT NULL DEFAULT 0,
        budgets_json    TEXT NOT NULL DEFAULT '{}',
        spend_json      TEXT NOT NULL DEFAULT '{}',
        correction_json TEXT,
        attempts_json   TEXT NOT NULL DEFAULT '[]',
        action_id       TEXT,
        approval_id     TEXT,
        session_id      TEXT,
        working_dir     TEXT NOT NULL DEFAULT '',
        origins_json    TEXT NOT NULL DEFAULT '[]',
        roots_json      TEXT NOT NULL DEFAULT '[]',
        stop_reason     TEXT NOT NULL DEFAULT '',
        error_json      TEXT,
        created_at      REAL NOT NULL,
        updated_at      REAL NOT NULL,
        deadline_at     REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_observer_state ON observer_runs(state, created_at);
    """,
]


def observer_path() -> Path:
    return get_settings().data_dir / "observer.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path if db_path is not None else observer_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = FULL")
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    current = int(row["v"]) if row and row["v"] is not None else 0
    for version, migration in enumerate(MIGRATIONS, start=1):
        if version <= current:
            continue
        with conn:
            conn.executescript(migration)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    return len(MIGRATIONS)


def _row_to_run(row: sqlite3.Row) -> ObserverRun:
    return ObserverRun(
        run_id=row["run_id"],
        schema_version=row["schema_version"],
        contract_id=row["contract_id"],
        contract_digest=row["contract_digest"],
        state=ObserverState(row["state"]),
        iteration=row["iteration"],
        budgets=Budgets.model_validate_json(row["budgets_json"] or "{}"),
        spend=Spend.model_validate_json(row["spend_json"] or "{}"),
        correction=(CorrectionSpec.model_validate_json(row["correction_json"])
                    if row["correction_json"] else None),
        attempts=[VerificationAttempt.model_validate(a)
                  for a in json.loads(row["attempts_json"] or "[]")],
        action_id=row["action_id"],
        approval_id=row["approval_id"],
        session_id=row["session_id"],
        working_dir=row["working_dir"],
        allowed_origins=json.loads(row["origins_json"] or "[]"),
        allowed_roots=json.loads(row["roots_json"] or "[]"),
        stop_reason=row["stop_reason"],
        error=json.loads(row["error_json"]) if row["error_json"] else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deadline_at=row["deadline_at"],
    )


def insert_run(run: ObserverRun) -> ObserverRun:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO observer_runs (run_id, contract_id, contract_digest, "
                "state, iteration, budgets_json, spend_json, correction_json, "
                "attempts_json, action_id, approval_id, session_id, working_dir, "
                "origins_json, roots_json, stop_reason, created_at, updated_at, "
                "deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run.run_id, run.contract_id, run.contract_digest,
                 run.state.value, run.iteration, run.budgets.model_dump_json(),
                 run.spend.model_dump_json(),
                 run.correction.model_dump_json() if run.correction else None,
                 json.dumps([a.model_dump() for a in run.attempts]),
                 run.action_id, run.approval_id, run.session_id, run.working_dir,
                 json.dumps(run.allowed_origins), json.dumps(run.allowed_roots),
                 run.stop_reason, run.created_at, run.updated_at,
                 run.deadline_at),
            )
        return run
    finally:
        conn.close()


def save_run(run: ObserverRun) -> ObserverRun:
    run.updated_at = time.time()
    conn = connect()
    try:
        with conn:
            conn.execute(
                "UPDATE observer_runs SET state=?, iteration=?, spend_json=?, "
                "attempts_json=?, action_id=?, approval_id=?, stop_reason=?, "
                "error_json=?, updated_at=? WHERE run_id=?",
                (run.state.value, run.iteration, run.spend.model_dump_json(),
                 json.dumps([a.model_dump() for a in run.attempts]),
                 run.action_id, run.approval_id, run.stop_reason,
                 json.dumps(run.error, default=str) if run.error else None,
                 run.updated_at, run.run_id),
            )
        return run
    finally:
        conn.close()


def claim_state(run_id: str, expect: ObserverState,
                target: ObserverState) -> bool:
    """Move a run's state only if it is where the caller thinks it is.

    Two processes advancing one loop must not both perform the iteration.
    This is the compare-and-swap that makes ``advance`` safe to call from
    anywhere, including twice by accident.
    """
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE observer_runs SET state = ?, updated_at = ? "
                "WHERE run_id = ? AND state = ?",
                (target.value, time.time(), run_id, expect.value))
            return cursor.rowcount == 1
    finally:
        conn.close()


def get_run(run_id: str) -> ObserverRun | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM observer_runs WHERE run_id = ?",
                           (run_id,)).fetchone()
        return _row_to_run(row) if row else None
    finally:
        conn.close()


def list_runs(state: str | None = None, limit: int = 50) -> list[ObserverRun]:
    conn = connect()
    try:
        if state:
            rows = conn.execute(
                "SELECT * FROM observer_runs WHERE state = ? "
                "ORDER BY created_at DESC LIMIT ?", (state, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM observer_runs ORDER BY created_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [_row_to_run(row) for row in rows]
    finally:
        conn.close()
