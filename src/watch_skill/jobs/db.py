"""The job queue's own SQLite database, with its own migration runner.

Deliberately not the video index. Jobs are operational state with a very
different write pattern — a heartbeat every few seconds per running job —
and putting them in ``index.db`` would make every progress tick contend with
the read path that answers questions. Separate files also mean losing the
queue never risks the video memory, and pruning one never touches the other.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.sqlite_util import enable_wal

Migration = str | Callable[[sqlite3.Connection], None]

MIGRATIONS: list[Migration] = [
    # v1 — durable jobs and their append-only event log.
    #
    # The state machine is enforced in SQL as well as in Python. A guarded
    # UPDATE would be enough while every writer goes through store.py, but a
    # terminal job silently returning to `running` is the kind of corruption
    # that only shows up as a duplicated artifact days later, so the database
    # refuses it too.
    """
    CREATE TABLE jobs (
        job_id           TEXT PRIMARY KEY,
        schema_version   INTEGER NOT NULL DEFAULT 1,
        kind             TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'queued',
        stage            TEXT NOT NULL DEFAULT 'queued',
        progress         REAL NOT NULL DEFAULT 0.0,
        payload_json     TEXT NOT NULL DEFAULT '{}',
        idempotency_key  TEXT,
        result_ref       TEXT,
        result_kind      TEXT,
        error_json       TEXT,
        attempt          INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL DEFAULT 3,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        lease_owner      TEXT,
        lease_expires_at REAL,
        heartbeat_at     REAL,
        created_at       REAL NOT NULL,
        started_at       REAL,
        finished_at      REAL,
        not_before       REAL NOT NULL DEFAULT 0,
        CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled')),
        CHECK (progress >= 0.0 AND progress <= 1.0)
    );
    CREATE UNIQUE INDEX idx_jobs_idempotency
        ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_jobs_claimable ON jobs(state, not_before);
    CREATE INDEX idx_jobs_lease ON jobs(state, lease_expires_at);

    CREATE TABLE job_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        at          REAL NOT NULL,
        kind        TEXT NOT NULL,
        stage       TEXT,
        progress    REAL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (job_id, seq)
    );
    CREATE INDEX idx_job_events_job ON job_events(job_id, seq);

    CREATE TRIGGER jobs_no_resurrection
    BEFORE UPDATE OF state ON jobs
    FOR EACH ROW
    WHEN OLD.state IN ('succeeded','failed','cancelled')
     AND NEW.state <> OLD.state
    BEGIN
        SELECT RAISE(ABORT, 'jobs.terminal_state_is_final');
    END;
    """,
]


def jobs_path() -> Path:
    return get_settings().data_dir / "jobs.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    """Open (creating + migrating if needed) the job database.

    WAL plus a generous busy timeout because several processes legitimately
    write here at once: an MCP server's worker, a CLI worker, and whatever
    submitted the job.
    """
    path = db_path if db_path is not None else jobs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    enable_wal(conn)
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
            if callable(migration):
                migration(conn)
            else:
                conn.executescript(migration)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    return schema_version(conn)
