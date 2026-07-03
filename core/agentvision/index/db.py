"""SQLite index with a schema_version table and migration runner from day one."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from agentvision.config import get_settings

MIGRATIONS: list[str] = [
    # v1 — initial schema
    """
    CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        title TEXT,
        uploader TEXT,
        duration_seconds REAL NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        transcript_source TEXT,
        frames_dir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        start REAL NOT NULL,
        end REAL NOT NULL,
        text TEXT NOT NULL
    );
    CREATE INDEX idx_segments_video ON segments(video_id, start);

    CREATE TABLE scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        scene_id INTEGER NOT NULL,
        timestamp REAL NOT NULL,
        frame_path TEXT NOT NULL,
        phash TEXT,
        reason TEXT,
        description TEXT
    );
    CREATE INDEX idx_scenes_video ON scenes(video_id, timestamp);

    CREATE TABLE ocr_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        scene_row_id INTEGER REFERENCES scenes(id) ON DELETE CASCADE,
        timestamp REAL NOT NULL,
        text TEXT NOT NULL,
        x1 REAL, y1 REAL, x2 REAL, y2 REAL,
        confidence REAL
    );
    CREATE INDEX idx_ocr_video ON ocr_blocks(video_id, timestamp);

    CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,          -- segment | scene | ocr
        ref_id INTEGER NOT NULL,     -- row id in the kind's table
        timestamp REAL,
        text TEXT NOT NULL,
        vector BLOB NOT NULL,
        dim INTEGER NOT NULL
    );
    CREATE INDEX idx_embeddings_video ON embeddings(video_id);

    CREATE VIRTUAL TABLE fts USING fts5(
        text, video_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, timestamp UNINDEXED
    );
    """,
]


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    """Open (creating + migrating if needed) the index database."""
    path = db_path if db_path is not None else get_settings().index_path
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    migrate(conn)
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row["v"]) if row and row["v"] is not None else 0


def migrate(conn: sqlite3.Connection) -> int:
    """Apply pending migrations in order; returns the resulting version."""
    current = schema_version(conn)
    for version, script in enumerate(MIGRATIONS, start=1):
        if version <= current:
            continue
        with conn:
            conn.executescript(script)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    return schema_version(conn)
