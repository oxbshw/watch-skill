"""Durable job operations.

Every state transition is a guarded UPDATE with the expected state in the
WHERE clause, so two workers racing on the same row produce one winner and
one no-op rather than two workers believing they own it. Nothing here holds a
lock across a callback.
"""
from __future__ import annotations

import json
import os
import socket
import sqlite3
import time
import uuid
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.jobs.db import connect
from watch_skill.jobs.types import (
    TERMINAL_STATES,
    Job,
    JobEvent,
    JobStage,
    JobState,
)

DEFAULT_LEASE_SECONDS = 60.0
DEFAULT_MAX_ATTEMPTS = 3
_RETRY_BACKOFF = (2.0, 8.0, 30.0, 120.0)


class JobError(WatchSkillError):
    """A job could not be found or transitioned."""

    default_code = "jobs.failed"


def worker_identity() -> str:
    """Who holds a lease. Host and pid so a stale lease is traceable to a
    process someone can go and look for."""
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        schema_version=row["schema_version"],
        job_id=row["job_id"],
        kind=row["kind"],
        state=JobState(row["state"]),
        stage=JobStage(row["stage"]),
        progress=row["progress"],
        payload=json.loads(row["payload_json"] or "{}"),
        idempotency_key=row["idempotency_key"],
        result_ref=row["result_ref"],
        result_kind=row["result_kind"],
        error=json.loads(row["error_json"]) if row["error_json"] else None,
        attempt=row["attempt"],
        max_attempts=row["max_attempts"],
        cancel_requested=bool(row["cancel_requested"]),
        lease_owner=row["lease_owner"],
        lease_expires_at=row["lease_expires_at"],
        heartbeat_at=row["heartbeat_at"],
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        not_before=row["not_before"],
    )


def _append_event(
    conn: sqlite3.Connection,
    job_id: str,
    kind: str,
    *,
    stage: str | None = None,
    progress: float | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    row = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM job_events WHERE job_id = ?", (job_id,)
    ).fetchone()
    conn.execute(
        "INSERT INTO job_events (job_id, seq, at, kind, stage, progress, detail_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (job_id, row["s"] + 1, time.time(), kind, stage, progress,
         json.dumps(detail or {}, ensure_ascii=False, default=str)),
    )


# --- submission -------------------------------------------------------------


def submit(
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    idempotency_key: str | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> Job:
    """Enqueue durable work. Returns the EXISTING job for a repeated key.

    Idempotency is enforced by a unique index rather than a read-then-write,
    because the two submissions that matter are the ones that arrive at the
    same moment — a client retrying a timed-out request is precisely when the
    duplicate would be created.
    """
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    conn = connect()
    try:
        with conn:
            try:
                conn.execute(
                    "INSERT INTO jobs (job_id, kind, state, stage, payload_json, "
                    "idempotency_key, max_attempts, created_at) "
                    "VALUES (?, ?, 'queued', 'queued', ?, ?, ?, ?)",
                    (job_id, kind,
                     json.dumps(payload or {}, ensure_ascii=False, default=str),
                     idempotency_key, max_attempts, time.time()),
                )
            except sqlite3.IntegrityError:
                existing = conn.execute(
                    "SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
                ).fetchone()
                if existing is None:
                    raise
                return _row_to_job(existing)
            _append_event(conn, job_id, "submitted", stage="queued",
                          detail={"kind": kind})
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        return _row_to_job(row)
    finally:
        conn.close()


# --- reads ------------------------------------------------------------------


def get(job_id: str) -> Job:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobError(
                f"unknown job_id: {job_id}",
                code="jobs.not_found",
                fix="`watch-skill jobs list` shows jobs on this machine; ids "
                "survive a restart now, so a missing one was pruned or never created",
                details={"job_id": job_id},
            )
        return _row_to_job(row)
    finally:
        conn.close()


def events(job_id: str, after_seq: int = 0, limit: int = 200) -> list[JobEvent]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM job_events WHERE job_id = ? AND seq > ? "
            "ORDER BY seq LIMIT ?",
            (job_id, after_seq, limit),
        ).fetchall()
        return [
            JobEvent(
                job_id=row["job_id"], seq=row["seq"], at=row["at"], kind=row["kind"],
                stage=row["stage"], progress=row["progress"],
                detail=json.loads(row["detail_json"] or "{}"),
            )
            for row in rows
        ]
    finally:
        conn.close()


def list_jobs(state: str | None = None, limit: int = 50) -> list[Job]:
    conn = connect()
    try:
        if state:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?",
                (state, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row_to_job(row) for row in rows]
    finally:
        conn.close()


# --- the worker's side ------------------------------------------------------


def claim(
    owner: str,
    kinds: list[str] | None = None,
    lease_seconds: float = DEFAULT_LEASE_SECONDS,
) -> Job | None:
    """Take ownership of one queued job, or return None.

    The UPDATE carries `state = 'queued'` in its WHERE clause, so exactly one
    of N racing workers changes a row. `changes()` tells the loser it lost.
    """
    now = time.time()
    conn = connect()
    try:
        with conn:
            recover_stale_leases(conn)
            filters = "AND kind IN ({})".format(",".join("?" * len(kinds))) if kinds else ""
            row = conn.execute(
                f"SELECT job_id FROM jobs WHERE state = 'queued' AND not_before <= ? "
                f"{filters} ORDER BY created_at LIMIT 1",
                (now, *(kinds or [])),
            ).fetchone()
            if row is None:
                return None
            cursor = conn.execute(
                "UPDATE jobs SET state = 'running', attempt = attempt + 1, "
                "lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, "
                "started_at = COALESCE(started_at, ?) "
                "WHERE job_id = ? AND state = 'queued'",
                (owner, now + lease_seconds, now, now, row["job_id"]),
            )
            if cursor.rowcount != 1:
                return None  # another worker won the race
            _append_event(conn, row["job_id"], "claimed", stage="queued",
                          detail={"owner": owner})
            claimed = conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (row["job_id"],)
            ).fetchone()
            return _row_to_job(claimed)
    finally:
        conn.close()


def heartbeat(
    job_id: str,
    owner: str,
    *,
    stage: JobStage | None = None,
    progress: float | None = None,
    lease_seconds: float = DEFAULT_LEASE_SECONDS,
) -> bool:
    """Extend the lease and report progress. False when the lease was lost.

    A worker that gets False must stop: something else has taken the job, and
    two workers finishing the same job is how duplicate artifacts appear.
    """
    now = time.time()
    conn = connect()
    try:
        with conn:
            sets = ["heartbeat_at = ?", "lease_expires_at = ?"]
            params: list[Any] = [now, now + lease_seconds]
            if stage is not None:
                sets.append("stage = ?")
                params.append(stage.value)
            if progress is not None:
                sets.append("progress = ?")
                params.append(max(0.0, min(1.0, progress)))
            params += [job_id, owner]
            cursor = conn.execute(
                f"UPDATE jobs SET {', '.join(sets)} WHERE job_id = ? AND lease_owner = ? "
                "AND state IN ('running','cancelling')",
                params,
            )
            if cursor.rowcount == 1 and (stage is not None or progress is not None):
                _append_event(conn, job_id, "progress",
                              stage=stage.value if stage else None, progress=progress)
            return cursor.rowcount == 1
    finally:
        conn.close()


def is_cancel_requested(job_id: str) -> bool:
    """The flag a cooperative worker checks between bounded units of work."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT cancel_requested FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        return bool(row and row["cancel_requested"])
    finally:
        conn.close()


def request_cancel(job_id: str) -> Job:
    """Ask a job to stop. Queued jobs cancel immediately; running jobs are
    marked `cancelling` and stop at their next checkpoint.

    A terminal job is returned unchanged rather than erroring — cancelling
    something that already finished is a race, not a mistake.
    """
    conn = connect()
    try:
        with conn:
            row = conn.execute(
                "SELECT state FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise JobError(
                    f"unknown job_id: {job_id}", code="jobs.not_found",
                    fix="`watch-skill jobs list` shows what can be cancelled",
                    details={"job_id": job_id},
                )
            if JobState(row["state"]) in TERMINAL_STATES:
                return get(job_id)
            conn.execute(
                "UPDATE jobs SET cancel_requested = 1 WHERE job_id = ?", (job_id,)
            )
            if row["state"] == "queued":
                conn.execute(
                    "UPDATE jobs SET state = 'cancelled', finished_at = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL "
                    "WHERE job_id = ? AND state = 'queued'",
                    (time.time(), job_id),
                )
                _append_event(conn, job_id, "cancelled", detail={"while": "queued"})
            else:
                conn.execute(
                    "UPDATE jobs SET state = 'cancelling' WHERE job_id = ? "
                    "AND state = 'running'",
                    (job_id,),
                )
                _append_event(conn, job_id, "cancel_requested",
                              detail={"while": "running"})
    finally:
        conn.close()
    return get(job_id)


def succeed(
    job_id: str, owner: str, result_ref: str | None = None,
    result_kind: str | None = None,
) -> bool:
    now = time.time()
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE jobs SET state = 'succeeded', stage = 'done', progress = 1.0, "
                "result_ref = ?, result_kind = ?, finished_at = ?, "
                "lease_owner = NULL, lease_expires_at = NULL "
                "WHERE job_id = ? AND lease_owner = ? AND state IN ('running','cancelling')",
                (result_ref, result_kind, now, job_id, owner),
            )
            if cursor.rowcount == 1:
                _append_event(conn, job_id, "succeeded", stage="done", progress=1.0,
                              detail={"result_ref": result_ref})
            return cursor.rowcount == 1
    finally:
        conn.close()


def cancelled(job_id: str, owner: str) -> bool:
    """The worker acknowledging that it actually stopped."""
    now = time.time()
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE jobs SET state = 'cancelled', finished_at = ?, "
                "lease_owner = NULL, lease_expires_at = NULL "
                "WHERE job_id = ? AND lease_owner = ? AND state IN ('running','cancelling')",
                (now, job_id, owner),
            )
            if cursor.rowcount == 1:
                _append_event(conn, job_id, "cancelled", detail={"acknowledged": True})
            return cursor.rowcount == 1
    finally:
        conn.close()


def fail(job_id: str, owner: str, error: dict[str, Any], *, retry: bool = True) -> Job:
    """Record a failure, and re-queue with backoff if attempts remain."""
    now = time.time()
    conn = connect()
    try:
        with conn:
            row = conn.execute(
                "SELECT attempt, max_attempts, cancel_requested FROM jobs "
                "WHERE job_id = ? AND lease_owner = ?",
                (job_id, owner),
            ).fetchone()
            if row is None:
                return get(job_id)  # lease lost; the new owner decides
            exhausted = row["attempt"] >= row["max_attempts"]
            # A cancelled job that errors on the way out is cancelled, not
            # failed: reporting a failure someone asked for is noise.
            if row["cancel_requested"]:
                conn.execute(
                    "UPDATE jobs SET state = 'cancelled', finished_at = ?, "
                    "error_json = ?, lease_owner = NULL, lease_expires_at = NULL "
                    "WHERE job_id = ? AND state IN ('running','cancelling')",
                    (now, json.dumps(error, default=str), job_id),
                )
                _append_event(conn, job_id, "cancelled", detail=error)
            elif retry and not exhausted:
                delay = _RETRY_BACKOFF[min(row["attempt"] - 1, len(_RETRY_BACKOFF) - 1)]
                conn.execute(
                    "UPDATE jobs SET state = 'queued', error_json = ?, not_before = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL "
                    "WHERE job_id = ? AND state IN ('running','cancelling')",
                    (json.dumps(error, default=str), now + delay, job_id),
                )
                _append_event(conn, job_id, "retry_scheduled",
                              detail={"after_seconds": delay, "error": error})
            else:
                conn.execute(
                    "UPDATE jobs SET state = 'failed', error_json = ?, finished_at = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL "
                    "WHERE job_id = ? AND state IN ('running','cancelling')",
                    (json.dumps(error, default=str), now, job_id),
                )
                _append_event(conn, job_id, "failed", detail=error)
    finally:
        conn.close()
    return get(job_id)


def recover_stale_leases(conn: sqlite3.Connection | None = None) -> int:
    """Re-queue jobs whose worker died without releasing the lease.

    This is what makes a killed process recoverable: the row still says
    `running`, but its lease has expired and nothing is heartbeating, so the
    next worker takes it. Attempts already spent still count, so a job that
    kills its worker every time fails instead of looping forever.
    """
    own_connection = conn is None
    conn = conn or connect()
    now = time.time()
    try:
        rows = conn.execute(
            "SELECT job_id, attempt, max_attempts FROM jobs "
            "WHERE state IN ('running','cancelling') AND lease_expires_at IS NOT NULL "
            "AND lease_expires_at < ?",
            (now,),
        ).fetchall()
        recovered = 0
        for row in rows:
            if row["attempt"] >= row["max_attempts"]:
                conn.execute(
                    "UPDATE jobs SET state = 'failed', finished_at = ?, error_json = ?, "
                    "lease_owner = NULL WHERE job_id = ? AND state IN ('running','cancelling')",
                    (now, json.dumps({
                        "error": "jobs.attempts_exhausted",
                        "message": "the worker died on every attempt",
                        "fix": "run the operation in the foreground to see the "
                               "real failure, or raise max_attempts",
                    }), row["job_id"]),
                )
                _append_event(conn, row["job_id"], "abandoned",
                              detail={"attempts": row["attempt"]})
            else:
                conn.execute(
                    "UPDATE jobs SET state = 'queued', lease_owner = NULL, "
                    "lease_expires_at = NULL WHERE job_id = ? "
                    "AND state IN ('running','cancelling')",
                    (row["job_id"],),
                )
                _append_event(conn, row["job_id"], "lease_expired",
                              detail={"attempt": row["attempt"]})
            recovered += 1
        if own_connection and recovered:
            conn.commit()
        return recovered
    finally:
        if own_connection:
            conn.close()


def prune(keep_terminal: int = 200) -> int:
    """Drop the oldest terminal jobs beyond a cap. Events cascade."""
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "DELETE FROM jobs WHERE job_id IN ("
                "  SELECT job_id FROM jobs "
                "  WHERE state IN ('succeeded','failed','cancelled') "
                "  ORDER BY finished_at DESC LIMIT -1 OFFSET ?)",
                (keep_terminal,),
            )
            return cursor.rowcount
    finally:
        conn.close()
