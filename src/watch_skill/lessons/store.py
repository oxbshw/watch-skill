"""The lessons store: local, per-OS-user, never uploaded.

Its own SQLite file (``<data_dir>/lessons.db``) with the same
schema-versioned migration discipline as the index. One store per user,
shared across every agent — a mistake corrected in Claude Code teaches
Cursor too.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings

Migration = str | Callable[[sqlite3.Connection], None]

MIGRATIONS: list[Migration] = [
    # v1 — lessons + per-content-type profiles
    """
    CREATE TABLE lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        session_id TEXT,
        agent TEXT,
        video_id TEXT,
        content_type TEXT NOT NULL DEFAULT 'generic',
        question TEXT NOT NULL,
        wrong_answer TEXT NOT NULL,
        correction TEXT NOT NULL,
        error_class TEXT NOT NULL,
        guidance TEXT NOT NULL,
        embedding BLOB,
        dim INTEGER,
        validated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_lessons_session ON lessons(session_id);
    CREATE INDEX idx_lessons_content ON lessons(content_type);

    CREATE TABLE profiles (
        content_type TEXT PRIMARY KEY,
        overrides TEXT NOT NULL,      -- JSON
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    """,
]


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    """Open (creating + migrating if needed) the lessons database."""
    path = db_path if db_path is not None else get_settings().lessons_path
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
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


def add_lesson(
    *,
    question: str,
    wrong_answer: str,
    correction: str,
    error_class: str,
    guidance: str,
    content_type: str = "generic",
    video_id: str | None = None,
    agent: str | None = None,
    session_id: str | None = None,
    embedding: bytes | None = None,
    dim: int | None = None,
    validated: bool = False,
) -> int:
    """Insert one lesson; enforces the global LRU cap. Returns the lesson id."""
    conn = connect()
    try:
        with conn:
            cur = conn.execute(
                """INSERT INTO lessons
                   (session_id, agent, video_id, content_type, question, wrong_answer,
                    correction, error_class, guidance, embedding, dim, validated)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id, agent, video_id, content_type, question, wrong_answer,
                    correction, error_class, guidance, embedding, dim, int(validated),
                ),
            )
            _enforce_cap(conn)
            return int(cur.lastrowid)
    finally:
        conn.close()


def _enforce_cap(conn: sqlite3.Connection) -> None:
    cap = get_settings().lessons_max_count
    count = conn.execute("SELECT COUNT(*) AS n FROM lessons").fetchone()["n"]
    if count > cap:
        conn.execute(
            "DELETE FROM lessons WHERE id IN ("
            "  SELECT id FROM lessons ORDER BY last_used_at ASC LIMIT ?)",
            (count - cap,),
        )


def list_lessons(session_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    conn = connect()
    try:
        if session_id:
            rows = conn.execute(
                "SELECT * FROM lessons WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM lessons ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def remove_lessons(ids: list[int] | None = None, session_id: str | None = None) -> int:
    """Delete by id list or whole session; returns rows removed."""
    conn = connect()
    try:
        with conn:
            if ids:
                marks = ",".join("?" * len(ids))
                cur = conn.execute(f"DELETE FROM lessons WHERE id IN ({marks})", ids)
            elif session_id:
                cur = conn.execute("DELETE FROM lessons WHERE session_id = ?", (session_id,))
            else:
                return 0
            return cur.rowcount
    finally:
        conn.close()


def mark_used(ids: list[int]) -> None:
    if not ids:
        return
    conn = connect()
    try:
        with conn:
            marks = ",".join("?" * len(ids))
            conn.execute(
                f"UPDATE lessons SET last_used_at = datetime('now') WHERE id IN ({marks})",
                ids,
            )
    finally:
        conn.close()


def mark_validated(lesson_id: int) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute("UPDATE lessons SET validated = 1 WHERE id = ?", (lesson_id,))
    finally:
        conn.close()
