"""SQLite index with a schema_version table and migration runner from day one.

Migrations are SQL scripts or Python callables (for data transforms SQL
cannot express, e.g. re-normalizing text through Python).
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

from watch_skill.config import get_settings

Migration = str | Callable[[sqlite3.Connection], None]


def _migration_v2_fts_norm(conn: sqlite3.Connection) -> None:
    """v2 — add a normalized shadow column to FTS for Arabic-aware search.

    Rebuilds the fts virtual table with ``text_norm`` and repopulates it from
    the existing rows, folding each one through normalize_for_search.
    """
    from watch_skill.index.textnorm import normalize_for_search

    rows = conn.execute(
        "SELECT text, video_id, kind, ref_id, timestamp FROM fts"
    ).fetchall()
    conn.executescript(
        """
        DROP TABLE fts;
        CREATE VIRTUAL TABLE fts USING fts5(
            text UNINDEXED, text_norm,
            video_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, timestamp UNINDEXED
        );
        """
    )
    for row in rows:
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (row["text"], normalize_for_search(row["text"]),
             row["video_id"], row["kind"], row["ref_id"], row["timestamp"]),
        )


def _migration_v4_fts_multilingual(conn: sqlite3.Connection) -> None:
    """v4 — rebuild FTS for non-Latin scripts beyond Arabic.

    Two fixes in one rebuild:
    - tokenizer: default unicode61 excludes combining marks (M*) from
      tokens, so Devanagari matras SPLIT words ('बारिश' became unfindable);
      the rebuilt table keeps Mn/Mc inside tokens and folds diacritics at
      match time (remove_diacritics 2 — query 'video' finds 'vidéo').
    - text_norm re-fold: normalize_for_search now segments CJK runs into
      per-character tokens (unicode61 treats an unspaced run as ONE token,
      so no substring query could match).
    Display text is untouched.
    """
    from watch_skill.index.textnorm import normalize_for_search

    rows = conn.execute(
        "SELECT text, video_id, kind, ref_id, timestamp FROM fts"
    ).fetchall()
    conn.executescript(
        """
        DROP TABLE fts;
        CREATE VIRTUAL TABLE fts USING fts5(
            text UNINDEXED, text_norm,
            video_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, timestamp UNINDEXED,
            tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'"
        );
        """
    )
    for row in rows:
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (row["text"], normalize_for_search(row["text"]),
             row["video_id"], row["kind"], row["ref_id"], row["timestamp"]),
        )


def _migration_v6_fts_refold(conn: sqlite3.Connection) -> None:
    """v6 — re-fold text_norm + answer-cache question_norm through the
    extended normalizer.

    normalize_for_search now segments the scriptless SEA scripts
    (Thai/Lao/Khmer/Myanmar/Tibetan), unifies Persian/Urdu letter variants
    with Arabic, folds cross-script digits to ASCII, and folds Hebrew/Greek/
    German/Cyrillic/Vietnamese forms. Existing rows carry the *old* folding,
    so we recompute the shadow keys in place from the untouched display text.
    Forward-only; display text and vectors are not touched.
    """
    from watch_skill.index.textnorm import normalize_for_search

    for row in conn.execute("SELECT rowid, text FROM fts").fetchall():
        conn.execute(
            "UPDATE fts SET text_norm = ? WHERE rowid = ?",
            (normalize_for_search(row["text"]), row["rowid"]),
        )
    for row in conn.execute("SELECT id, question FROM answers").fetchall():
        conn.execute(
            "UPDATE answers SET question_norm = ? WHERE id = ?",
            (normalize_for_search(row["question"]), row["id"]),
        )


def _migration_v3_meta(conn: sqlite3.Connection) -> None:
    """v3 — key/value meta table; pin the embedding model per index.

    Vectors are only comparable when queries embed with the same model that
    wrote them. Pre-v3 indexes were all built with the original English-only
    default, so existing embeddings get pinned to it here; the multilingual
    default applies to indexes created from now on.
    """
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    row = conn.execute("SELECT COUNT(*) AS n FROM embeddings").fetchone()
    if row["n"]:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('embedding_model', ?)",
            ("sentence-transformers/all-MiniLM-L6-v2",),
        )


MIGRATIONS: list[Migration] = [
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
    # v2 — Arabic-aware normalized FTS column (Python data transform)
    _migration_v2_fts_norm,
    # v3 — meta table; embedding-model pinning
    _migration_v3_meta,
    # v4 — multilingual FTS rebuild (combining marks + CJK segmentation)
    _migration_v4_fts_multilingual,
    # v5 — semantic answer cache (token economy: repeat questions are free)
    """
    CREATE TABLE answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        question_norm TEXT NOT NULL,
        embedding BLOB,
        dim INTEGER,
        answer_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_answers_video ON answers(video_id);
    """,
    # v6 — re-fold text_norm + question_norm for the extended normalizer
    _migration_v6_fts_refold,
    # v7 — library notes layer (new tables only; nothing existing is touched).
    # notes: distilled per-video items (entity | claim | chapter) with
    # (video_id, timestamp) provenance, re-derived per video — video N never
    # reprocesses 1..N-1. Their FTS + vectors live in their OWN tables so the
    # main fts/embeddings read paths (search_videos, ask_video) are unchanged.
    # library_answers: the cross-video synthesis cache; library_stamp records
    # the note-set state an answer was computed against, so growing the
    # library invalidates stale syntheses instead of serving them.
    """
    CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp REAL,
        end_timestamp REAL,
        weight REAL NOT NULL DEFAULT 1.0,
        vector BLOB,
        dim INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_notes_video ON notes(video_id, kind);

    CREATE VIRTUAL TABLE notes_fts USING fts5(
        text UNINDEXED, text_norm,
        video_id UNINDEXED, note_id UNINDEXED, kind UNINDEXED, timestamp UNINDEXED,
        tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'"
    );

    CREATE TABLE library_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        question_norm TEXT NOT NULL,
        embedding BLOB,
        dim INTEGER,
        answer_json TEXT NOT NULL,
        library_stamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_library_answers_norm ON library_answers(question_norm);
    """,
]


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


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
