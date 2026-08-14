"""The v9 migration against a real v8 database, not a fresh one.

Migrating from empty exercises the CREATE statements. It does not exercise the
part that can actually lose someone's data: rebuilding ``videos`` to drop the
UNIQUE constraint on ``source``, while ``segments``, ``scenes``, ``ocr_blocks``,
``embeddings`` and ``answers`` hold foreign keys into it with ON DELETE CASCADE.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from watch_skill.index.db import MIGRATIONS, connect, migrate, schema_version


def _build_v8(path: Path) -> None:
    """A database at exactly schema v8, populated the way a real one is."""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    for version, migration in enumerate(MIGRATIONS[:8], start=1):
        with conn:
            if callable(migration):
                migration(conn)
            else:
                conn.executescript(migration)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    with conn:
        conn.execute(
            "INSERT INTO videos (id, source, title, duration_seconds, frames_dir) "
            "VALUES ('aaaaaaaaaaaaaaaa', 'C:/clips/demo.mp4', 'Demo', 12.0, '/frames/a')"
        )
        conn.execute(
            "INSERT INTO videos (id, source, title, duration_seconds, frames_dir) "
            "VALUES ('bbbbbbbbbbbbbbbb', 'https://example.com/v?v=1&t=30', 'Talk', 60.0, '/frames/b')"
        )
        for video in ("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"):
            conn.execute(
                "INSERT INTO segments (video_id, start, end, text) VALUES (?, 1.0, 3.0, ?)",
                (video, f"transcript for {video}"),
            )
            cur = conn.execute(
                "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, phash, reason) "
                "VALUES (?, 0, 1.5, '/frames/x.jpg', '0000', 'scene-start')",
                (video,),
            )
            conn.execute(
                "INSERT INTO ocr_blocks (video_id, scene_row_id, timestamp, text, "
                "x1, y1, x2, y2, confidence) VALUES (?, ?, 1.5, 'TOTAL 29.00', "
                "0, 0, 1, 1, 0.9)",
                (video, cur.lastrowid),
            )
            conn.execute(
                "INSERT INTO embeddings (video_id, kind, ref_id, timestamp, text, "
                "vector, dim) VALUES (?, 'segment', 1, 1.0, 't', X'0000', 2)",
                (video,),
            )
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES (?, 'q', 'q', '{}')",
                (video,),
            )
            conn.execute(
                "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
                "VALUES ('total 29.00', 'total 29.00', ?, 'ocr', 1, 1.5)",
                (video,),
            )
    assert schema_version(conn) == 8
    conn.close()


def test_v8_to_v9_preserves_every_derived_row(tmp_path: Path) -> None:
    """The rebuild must not cascade away the rows it is meant to keep."""
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        assert schema_version(conn) == len(MIGRATIONS)
        counts = {
            table: conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
            for table in ("videos", "segments", "scenes", "ocr_blocks",
                          "embeddings", "answers", "fts")
        }
        assert counts == {
            "videos": 2, "segments": 2, "scenes": 2, "ocr_blocks": 2,
            "embeddings": 2, "answers": 2, "fts": 2,
        }, counts
    finally:
        conn.close()


def test_v8_rows_keep_their_ids_and_gain_a_legacy_revision(tmp_path: Path) -> None:
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        rows = {
            r["id"]: r for r in conn.execute(
                "SELECT id, source, revision_id, content_digest FROM videos"
            ).fetchall()
        }
        assert set(rows) == {"aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"}
        for row in rows.values():
            assert row["revision_id"], "every migrated row needs a revision"
            # No bytes were ever hashed for a v1 row, so it must NOT carry
            # something that looks like a content digest.
            assert row["content_digest"] is None
        digests = conn.execute(
            "SELECT digest_source FROM revisions"
        ).fetchall()
        assert {d["digest_source"] for d in digests} == {"legacy"}
    finally:
        conn.close()


def test_v8_sources_become_resolvable_aliases(tmp_path: Path) -> None:
    from watch_skill.index.revisions import get_alias_state

    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        state = get_alias_state(conn, "https://example.com/v?v=1&t=30")
        assert state is not None
        assert state.revision_id
        # the volatile ?t= is normalized away, so the same video without it
        # resolves to the same alias
        same = get_alias_state(conn, "https://example.com/v?v=1")
        assert same is not None and same.alias_id == state.alias_id
    finally:
        conn.close()


def test_the_unique_constraint_on_source_is_gone(tmp_path: Path) -> None:
    """Two revisions of one path must be representable at all."""
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, duration_seconds) "
                "VALUES ('cccccccccccccccc', 'C:/clips/demo.mp4', 20.0)"
            )
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM videos WHERE source = 'C:/clips/demo.mp4'"
        ).fetchone()["n"]
        assert n == 2
    finally:
        conn.close()


def test_foreign_keys_are_on_after_migrating(tmp_path: Path) -> None:
    """The migration turns them off; leaving them off would be the real bug."""
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def test_cascade_still_works_after_the_rebuild(tmp_path: Path) -> None:
    """Deleting a video must still take its derived rows with it."""
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        with conn:
            conn.execute("DELETE FROM videos WHERE id = 'aaaaaaaaaaaaaaaa'")
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM segments WHERE video_id = 'aaaaaaaaaaaaaaaa'"
        ).fetchone()["n"]
        assert remaining == 0, "the rebuilt table lost its cascade"
    finally:
        conn.close()


def test_migrating_twice_is_a_no_op(tmp_path: Path) -> None:
    path = tmp_path / "index.db"
    _build_v8(path)

    conn = connect(path)
    try:
        before = conn.execute("SELECT COUNT(*) AS n FROM revisions").fetchone()["n"]
        assert migrate(conn) == len(MIGRATIONS)
        after = conn.execute("SELECT COUNT(*) AS n FROM revisions").fetchone()["n"]
        assert before == after
    finally:
        conn.close()
