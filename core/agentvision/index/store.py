"""Write path: persist a WatchResult so questions never re-burn analysis."""
from __future__ import annotations

import hashlib
import shutil
import sqlite3
from pathlib import Path
from typing import Any

from agentvision.config import get_settings
from agentvision.index import embeddings as emb
from agentvision.index.db import connect
from agentvision.watch import WatchResult


def video_id_for(source: str) -> str:
    """Stable short id for a source (matches cache keying philosophy)."""
    return hashlib.sha256(source.strip().encode("utf-8")).hexdigest()[:16]


def _persist_frames(result: WatchResult, video_id: str) -> Path:
    """Copy kept frames out of the throwaway work dir into managed storage."""
    dest = get_settings().data_dir / "frames" / video_id
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    if result.perception is not None:
        for frame in result.perception.frames:
            target = dest / frame.path.name
            shutil.copy2(frame.path, target)
            frame.path = target
    return dest


def _insert_video(conn: sqlite3.Connection, result: WatchResult, video_id: str, frames_dir: Path) -> None:
    info = result.acquisition.info
    conn.execute(
        """
        INSERT INTO videos (id, source, title, uploader, duration_seconds, width,
                            height, transcript_source, frames_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, uploader=excluded.uploader,
            duration_seconds=excluded.duration_seconds,
            transcript_source=excluded.transcript_source,
            frames_dir=excluded.frames_dir,
            last_analyzed_at=datetime('now')
        """,
        (
            video_id, result.acquisition.source, info.get("title"), info.get("uploader"),
            result.metadata.duration_seconds, result.metadata.width, result.metadata.height,
            result.transcript.source, str(frames_dir),
        ),
    )
    # re-analysis replaces derived rows
    for table in ("segments", "scenes", "ocr_blocks", "embeddings"):
        conn.execute(f"DELETE FROM {table} WHERE video_id = ?", (video_id,))
    conn.execute("DELETE FROM fts WHERE video_id = ?", (video_id,))


def _insert_derived(conn: sqlite3.Connection, result: WatchResult, video_id: str) -> list[tuple]:
    """Insert segments/scenes/ocr; return (kind, ref_id, timestamp, text) for embedding."""
    to_embed: list[tuple] = []
    for seg in result.transcript.segments:
        cur = conn.execute(
            "INSERT INTO segments (video_id, start, end, text) VALUES (?, ?, ?, ?)",
            (video_id, seg.start, seg.end, seg.text),
        )
        to_embed.append(("segment", cur.lastrowid, seg.start, seg.text))

    if result.perception is not None:
        for frame in result.perception.frames:
            cur = conn.execute(
                """INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, phash, reason)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    video_id, frame.scene_id, frame.timestamp_seconds,
                    str(frame.path), frame.phash, frame.reason,
                ),
            )
            scene_row = cur.lastrowid
            for block in frame.ocr_blocks:
                ocr_cur = conn.execute(
                    """INSERT INTO ocr_blocks
                       (video_id, scene_row_id, timestamp, text, x1, y1, x2, y2, confidence)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        video_id, scene_row, frame.timestamp_seconds, block.text,
                        *block.bbox, block.confidence,
                    ),
                )
                to_embed.append(("ocr", ocr_cur.lastrowid, frame.timestamp_seconds, block.text))
    return to_embed


def set_scene_description(conn: sqlite3.Connection, scene_row_id: int, description: str) -> None:
    """Attach a vision-generated one-line description to a scene frame row."""
    row = conn.execute(
        "SELECT video_id, timestamp FROM scenes WHERE id = ?", (scene_row_id,)
    ).fetchone()
    if row is None:
        return
    conn.execute("UPDATE scenes SET description = ? WHERE id = ?", (description, scene_row_id))
    _index_texts(conn, row["video_id"], [("scene", scene_row_id, row["timestamp"], description)])


def _index_texts(conn: sqlite3.Connection, video_id: str, items: list[tuple]) -> None:
    """Insert FTS rows and (when available) embedding rows for text items."""
    for kind, ref_id, timestamp, text in items:
        conn.execute(
            "INSERT INTO fts (text, video_id, kind, ref_id, timestamp) VALUES (?, ?, ?, ?, ?)",
            (text, video_id, kind, ref_id, timestamp),
        )
    vectors = emb.embed_texts([text for _, _, _, text in items])
    if vectors:
        for (kind, ref_id, timestamp, text), vector in zip(items, vectors):
            conn.execute(
                """INSERT INTO embeddings (video_id, kind, ref_id, timestamp, text, vector, dim)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (video_id, kind, ref_id, timestamp, text, emb.pack_vector(vector), len(vector)),
            )


def _maybe_describe_scenes(conn: sqlite3.Connection, video_id: str) -> None:
    """Attach one-line visual descriptions via the cheap vision tier.

    Opportunistic: silently skipped when no key is configured for the cheap
    provider or the call fails — the index works without descriptions, they
    just make retrieval smarter.
    """
    from agentvision.errors import VisionError
    from agentvision.vision import get_vision

    rows = conn.execute(
        "SELECT id, frame_path FROM scenes WHERE video_id = ? AND description IS NULL "
        "ORDER BY timestamp",
        (video_id,),
    ).fetchall()
    rows = [r for r in rows if Path(r["frame_path"]).is_file()][:24]
    if not rows:
        return
    try:
        model = get_vision("cheap")
        descriptions = model.describe_frames([Path(r["frame_path"]) for r in rows])
    except VisionError as exc:
        import sys

        print(f"[agentvision] scene descriptions skipped ({exc.code})", file=sys.stderr)
        return
    for row, description in zip(rows, descriptions):
        if description:
            set_scene_description(conn, row["id"], description)


def index_watch_result(result: WatchResult, describe_scenes: bool = True) -> str:
    """Persist everything a watch pass learned; returns the video_id."""
    video_id = video_id_for(result.acquisition.source)
    frames_dir = _persist_frames(result, video_id)
    conn = connect()
    try:
        with conn:
            _insert_video(conn, result, video_id, frames_dir)
            items = _insert_derived(conn, result, video_id)
            _index_texts(conn, video_id, items)
        if describe_scenes:
            with conn:
                _maybe_describe_scenes(conn, video_id)
    finally:
        conn.close()
    return video_id


def get_video(video_id_or_source: str) -> dict[str, Any] | None:
    """Look up a video row by id or by original source string."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM videos WHERE id = ? OR source = ? OR id = ?",
            (video_id_or_source, video_id_or_source, video_id_for(video_id_or_source)),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_videos() -> list[dict[str, Any]]:
    """All indexed videos, most recently analyzed first."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM videos ORDER BY last_analyzed_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
