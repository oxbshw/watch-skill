"""Durable storage for actions and approvals.

Crash-safe and cross-process, because both properties are load-bearing rather
than nice to have: an approval that lives in one process's memory is an
approval that a restart silently grants or silently loses, and an action whose
state is not durable cannot be resumed honestly after a crash.

Approvals are append-only in the sense that matters — a decision is written
once and never edited, and the transition is guarded by the current status, so
two concurrent approvals of the same request cannot both win.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from watch_skill.actions.types import (
    Action,
    ActionState,
    Approval,
    ApprovalStatus,
)
from watch_skill.config import get_settings
from watch_skill.sqlite_util import apply_migrations, immediate

MIGRATIONS: list[str] = [
    # v1 — actions, approvals, and the transition log that explains both.
    """
    CREATE TABLE actions (
        action_id       TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        kind            TEXT NOT NULL,
        summary         TEXT NOT NULL DEFAULT '',
        state           TEXT NOT NULL DEFAULT 'proposed',
        proposed_by     TEXT NOT NULL DEFAULT '',
        requires_approval INTEGER NOT NULL DEFAULT 1,
        approval_id     TEXT,
        idempotency_key TEXT NOT NULL DEFAULT '',
        inputs_json     TEXT NOT NULL DEFAULT '{}',
        outputs_json    TEXT NOT NULL DEFAULT '{}',
        evidence_json   TEXT NOT NULL DEFAULT '[]',
        policy_json     TEXT NOT NULL DEFAULT '{}',
        retry_count     INTEGER NOT NULL DEFAULT 0,
        verification_run_id TEXT,
        verification_verdict TEXT,
        error_json      TEXT,
        created_at      REAL NOT NULL,
        updated_at      REAL NOT NULL,
        session_id      TEXT,
        loop_id         TEXT
    );
    -- The uniqueness that makes a retried proposal idempotent. Partial, so
    -- the many actions with no key do not collide with each other.
    CREATE UNIQUE INDEX idx_actions_idempotency
        ON actions(idempotency_key) WHERE idempotency_key <> '';
    CREATE INDEX idx_actions_state ON actions(state, created_at);
    CREATE INDEX idx_actions_loop ON actions(loop_id, created_at);

    CREATE TABLE approvals (
        approval_id     TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        action_id       TEXT NOT NULL DEFAULT '',
        effect_digest   TEXT NOT NULL,
        summary         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending',
        requested_at    REAL NOT NULL,
        decided_at      REAL,
        actor           TEXT NOT NULL DEFAULT '',
        reason          TEXT NOT NULL DEFAULT '',
        expires_at      REAL,
        used_at         REAL,
        CHECK (status IN ('pending','approved','rejected','expired'))
    );
    CREATE INDEX idx_approvals_status ON approvals(status, requested_at);

    -- Every state change, kept forever. The actions table says where an
    -- action is; this says how it got there, which is the part an auditor
    -- actually needs.
    CREATE TABLE action_transitions (
        action_id   TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        from_state  TEXT NOT NULL,
        to_state    TEXT NOT NULL,
        actor       TEXT NOT NULL DEFAULT '',
        reason      TEXT NOT NULL DEFAULT '',
        at          REAL NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (action_id, seq)
    );
    """,
]


def actions_path() -> Path:
    return get_settings().data_dir / "actions.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path if db_path is not None else actions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row["v"]) if row and row["v"] is not None else 0


def migrate(conn: sqlite3.Connection) -> int:
    """Bring this database up to date, safely under concurrency.

    Delegated so the write lock is taken before the version is read; doing it
    inline meant two processes both saw version 0 and the loser died with
    "table already exists".
    """
    return apply_migrations(conn, MIGRATIONS)


# --- actions ----------------------------------------------------------------


def _row_to_action(row: sqlite3.Row) -> Action:
    return Action(
        action_id=row["action_id"],
        schema_version=row["schema_version"],
        kind=row["kind"],
        summary=row["summary"],
        state=ActionState(row["state"]),
        proposed_by=row["proposed_by"],
        requires_approval=bool(row["requires_approval"]),
        approval_id=row["approval_id"],
        idempotency_key=row["idempotency_key"],
        inputs=json.loads(row["inputs_json"] or "{}"),
        outputs=json.loads(row["outputs_json"] or "{}"),
        evidence_refs=json.loads(row["evidence_json"] or "[]"),
        policy_decision=json.loads(row["policy_json"] or "{}"),
        retry_count=row["retry_count"],
        verification_run_id=row["verification_run_id"],
        verification_verdict=row["verification_verdict"],
        error=json.loads(row["error_json"]) if row["error_json"] else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        session_id=row["session_id"],
        loop_id=row["loop_id"],
    )


def insert_action(action: Action) -> Action:
    """Write a proposal, or return the one that already exists for its key.

    The idempotency key is enforced by the database, not by a read-then-write
    in Python: two processes proposing the same correction at the same instant
    must produce one action, and only a unique index can promise that.
    """
    conn = connect()
    try:
        with conn:
            try:
                conn.execute(
                    "INSERT INTO actions (action_id, kind, summary, state, "
                    "proposed_by, requires_approval, approval_id, idempotency_key, "
                    "inputs_json, outputs_json, evidence_json, policy_json, "
                    "created_at, updated_at, session_id, loop_id) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (action.action_id, action.kind, action.summary,
                     action.state.value, action.proposed_by,
                     int(action.requires_approval), action.approval_id,
                     action.idempotency_key,
                     json.dumps(action.inputs, default=str),
                     json.dumps(action.outputs, default=str),
                     json.dumps(action.evidence_refs, default=str),
                     json.dumps(action.policy_decision, default=str),
                     action.created_at, action.updated_at,
                     action.session_id, action.loop_id),
                )
            except sqlite3.IntegrityError:
                if not action.idempotency_key:
                    raise
                row = conn.execute(
                    "SELECT * FROM actions WHERE idempotency_key = ?",
                    (action.idempotency_key,),
                ).fetchone()
                if row is None:  # pragma: no cover - a genuine id collision
                    raise
                return _row_to_action(row)
            conn.execute(
                "INSERT INTO action_transitions (action_id, seq, from_state, "
                "to_state, actor, reason, at) VALUES (?,?,?,?,?,?,?)",
                (action.action_id, 1, "", action.state.value,
                 action.proposed_by, "proposed", action.created_at),
            )
        return action
    finally:
        conn.close()


def get_action(action_id: str) -> Action | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM actions WHERE action_id = ?",
                           (action_id,)).fetchone()
        return _row_to_action(row) if row else None
    finally:
        conn.close()


def find_by_idempotency_key(key: str) -> Action | None:
    if not key:
        return None
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM actions WHERE idempotency_key = ?",
                           (key,)).fetchone()
        return _row_to_action(row) if row else None
    finally:
        conn.close()


def transition(
    action_id: str,
    to_state: ActionState,
    *,
    expect: ActionState | None = None,
    actor: str = "",
    reason: str = "",
    outputs: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
    approval_id: str | None = None,
    verification_run_id: str | None = None,
    verification_verdict: str | None = None,
    bump_retry: bool = False,
) -> Action | None:
    """Move an action, conditionally on where it is now.

    ``expect`` makes this a compare-and-swap. Without it, two workers that
    both believed an action was ``approved`` could both start it, and the side
    effect would happen twice on one approval — which is precisely the failure
    the approval was there to prevent.
    """
    conn = connect()
    try:
        # Write-first: the compare-and-swap reads the current state and then
        # writes, and a deferred transaction cannot upgrade that read lock
        # once another worker has committed in between.
        with immediate(conn):
            row = conn.execute("SELECT * FROM actions WHERE action_id = ?",
                               (action_id,)).fetchone()
            if row is None:
                return None
            current = ActionState(row["state"])
            if expect is not None and current is not expect:
                return None
            now = time.time()
            sets = ["state = ?", "updated_at = ?"]
            params: list[Any] = [to_state.value, now]
            if outputs is not None:
                sets.append("outputs_json = ?")
                params.append(json.dumps(outputs, default=str))
            if error is not None:
                sets.append("error_json = ?")
                params.append(json.dumps(error, default=str))
            if approval_id is not None:
                sets.append("approval_id = ?")
                params.append(approval_id)
            if verification_run_id is not None:
                sets.append("verification_run_id = ?")
                params.append(verification_run_id)
            if verification_verdict is not None:
                sets.append("verification_verdict = ?")
                params.append(verification_verdict)
            if bump_retry:
                sets.append("retry_count = retry_count + 1")
            params.append(action_id)
            conn.execute(
                f"UPDATE actions SET {', '.join(sets)} WHERE action_id = ?",
                params)
            seq_row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM action_transitions "
                "WHERE action_id = ?", (action_id,)).fetchone()
            conn.execute(
                "INSERT INTO action_transitions (action_id, seq, from_state, "
                "to_state, actor, reason, at) VALUES (?,?,?,?,?,?,?)",
                (action_id, int(seq_row["n"]), current.value, to_state.value,
                 actor, reason, now))
            updated = conn.execute("SELECT * FROM actions WHERE action_id = ?",
                                   (action_id,)).fetchone()
            return _row_to_action(updated)
    finally:
        conn.close()


def transitions_for(action_id: str) -> list[dict[str, Any]]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM action_transitions WHERE action_id = ? ORDER BY seq",
            (action_id,)).fetchall()
        return [{"seq": r["seq"], "from": r["from_state"], "to": r["to_state"],
                 "actor": r["actor"], "reason": r["reason"], "at": r["at"]}
                for r in rows]
    finally:
        conn.close()


def list_actions(state: str | None = None, loop_id: str | None = None,
                 limit: int = 50) -> list[Action]:
    clauses, params = [], []
    if state:
        clauses.append("state = ?")
        params.append(state)
    if loop_id:
        clauses.append("loop_id = ?")
        params.append(loop_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(max(1, min(limit, 500)))
    conn = connect()
    try:
        rows = conn.execute(
            f"SELECT * FROM actions {where} ORDER BY created_at DESC LIMIT ?",
            params).fetchall()
        return [_row_to_action(row) for row in rows]
    finally:
        conn.close()


# --- approvals --------------------------------------------------------------


def _row_to_approval(row: sqlite3.Row) -> Approval:
    return Approval(
        approval_id=row["approval_id"],
        schema_version=row["schema_version"],
        action_id=row["action_id"],
        effect_digest=row["effect_digest"],
        summary=row["summary"],
        status=ApprovalStatus(row["status"]),
        requested_at=row["requested_at"],
        decided_at=row["decided_at"],
        actor=row["actor"],
        reason=row["reason"],
        expires_at=row["expires_at"],
        used_at=row["used_at"],
    )


def insert_approval(approval: Approval) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO approvals (approval_id, action_id, effect_digest, "
                "summary, status, requested_at, expires_at) VALUES (?,?,?,?,?,?,?)",
                (approval.approval_id, approval.action_id, approval.effect_digest,
                 approval.summary, approval.status.value, approval.requested_at,
                 approval.expires_at),
            )
    finally:
        conn.close()


def get_approval(approval_id: str) -> Approval | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM approvals WHERE approval_id = ?",
                           (approval_id,)).fetchone()
        return _row_to_approval(row) if row else None
    finally:
        conn.close()


def decide_approval(approval_id: str, status: ApprovalStatus, *, actor: str,
                    reason: str = "") -> Approval | None:
    """Record a decision, but only on a request that is still pending.

    Conditioning the write on ``status = 'pending'`` is what makes a second
    approval a no-op rather than a fresh grant — a resubmitted click, or a
    replayed request, must not produce two usable approvals.
    """
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE approvals SET status = ?, decided_at = ?, actor = ?, "
                "reason = ? WHERE approval_id = ? AND status = 'pending'",
                (status.value, time.time(), actor, reason, approval_id))
            if cursor.rowcount == 0:
                row = conn.execute(
                    "SELECT * FROM approvals WHERE approval_id = ?",
                    (approval_id,)).fetchone()
                return _row_to_approval(row) if row else None
            row = conn.execute("SELECT * FROM approvals WHERE approval_id = ?",
                               (approval_id,)).fetchone()
            return _row_to_approval(row)
    finally:
        conn.close()


def consume_approval(approval_id: str, effect_digest: str) -> Approval | None:
    """Spend an approval, once, for exactly the effect it was granted for.

    Three conditions in one statement, because checking them in Python and
    then writing would leave a window between them: the approval must be
    approved, unused, and for this exact effect. A caller that gets ``None``
    must not proceed.
    """
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE approvals SET used_at = ? WHERE approval_id = ? "
                "AND status = 'approved' AND used_at IS NULL "
                "AND effect_digest = ?",
                (time.time(), approval_id, effect_digest))
            if cursor.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM approvals WHERE approval_id = ?",
                               (approval_id,)).fetchone()
            return _row_to_approval(row)
    finally:
        conn.close()


def list_approvals(status: str | None = None, limit: int = 50) -> list[Approval]:
    conn = connect()
    try:
        if status:
            rows = conn.execute(
                "SELECT * FROM approvals WHERE status = ? "
                "ORDER BY requested_at DESC LIMIT ?", (status, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM approvals ORDER BY requested_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [_row_to_approval(row) for row in rows]
    finally:
        conn.close()
