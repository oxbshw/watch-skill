"""The rolling media buffer: keep the recent past, pin what matters.

A live session cannot keep everything, and cannot keep only the present
either — the interesting thing is usually already a few seconds old by the
time anything decides it was interesting. So the buffer retains a configurable
recent window and lets a detector *pin* the intervals around an event, which
exempts them from eviction and makes them finalizable.

Rows outlive files on purpose. An expired segment leaves a row marked
``expired``, so asking for evidence that has aged out gets an honest "that has
been evicted" instead of silence.
"""
from __future__ import annotations

import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.live.db import connect


def session_dir(session_id: str) -> Path:
    return get_settings().data_dir / "live" / session_id


@dataclass
class Segment:
    """One retained piece of media."""

    artifact_id: str
    kind: str
    path: Path
    media_ts: float
    end_media_ts: float | None = None
    bytes: int = 0
    pinned: bool = False
    expired: bool = False


def new_artifact_id(kind: str) -> str:
    return f"{kind}_{uuid.uuid4().hex[:12]}"


def record(
    session_id: str,
    kind: str,
    path: Path,
    media_ts: float,
    end_media_ts: float | None = None,
    *,
    pinned: bool = False,
) -> Segment:
    """Register a file as part of the session's buffer."""
    artifact_id = new_artifact_id(kind)
    size = path.stat().st_size if path.is_file() else 0
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO live_segments (session_id, artifact_id, kind, path, "
                "media_ts, end_media_ts, bytes, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session_id, artifact_id, kind, str(path), media_ts, end_media_ts,
                 size, int(pinned)),
            )
    finally:
        conn.close()
    return Segment(artifact_id, kind, path, media_ts, end_media_ts, size, pinned)


def pin_window(session_id: str, media_ts: float, before: float = 5.0,
               after: float = 5.0) -> int:
    """Protect everything around a moment from eviction.

    Called when something interesting is detected, with a window on both
    sides: the cause of an event is usually visible before the event itself.
    """
    conn = connect()
    try:
        with conn:
            cursor = conn.execute(
                "UPDATE live_segments SET pinned = 1 WHERE session_id = ? "
                "AND expired = 0 AND media_ts BETWEEN ? AND ?",
                (session_id, media_ts - before, media_ts + after),
            )
            return cursor.rowcount
    finally:
        conn.close()


def resolve(session_id: str, artifact_id: str) -> Segment | None:
    """Turn a public artifact id back into a local file.

    The only place that mapping happens. Tool output carries ids, so a model
    (or anything reading its output) never receives a filesystem path it could
    use to go looking around.
    """
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM live_segments WHERE session_id = ? AND artifact_id = ?",
            (session_id, artifact_id),
        ).fetchone()
        if row is None:
            return None
        return Segment(
            artifact_id=row["artifact_id"], kind=row["kind"], path=Path(row["path"]),
            media_ts=row["media_ts"], end_media_ts=row["end_media_ts"],
            bytes=row["bytes"], pinned=bool(row["pinned"]),
            expired=bool(row["expired"]),
        )
    finally:
        conn.close()


def frames_between(
    session_id: str, start: float, end: float, limit: int = 12
) -> list[Segment]:
    """Live frames in a window, oldest first, excluding evicted ones."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM live_segments WHERE session_id = ? AND kind = 'frame' "
            "AND expired = 0 AND media_ts BETWEEN ? AND ? ORDER BY media_ts LIMIT ?",
            (session_id, start, end, limit),
        ).fetchall()
        return [
            Segment(row["artifact_id"], row["kind"], Path(row["path"]),
                    row["media_ts"], row["end_media_ts"], row["bytes"],
                    bool(row["pinned"]), bool(row["expired"]))
            for row in rows
        ]
    finally:
        conn.close()


def evict(session_id: str, keep_seconds: float, now_media_ts: float) -> int:
    """Delete unpinned segments older than the retention window.

    Returns how many files were removed. The row stays, marked expired: a
    later request for that evidence deserves "it aged out", not a blank.
    """
    cutoff = now_media_ts - keep_seconds
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT artifact_id, path FROM live_segments WHERE session_id = ? "
            "AND pinned = 0 AND expired = 0 AND media_ts < ?",
            (session_id, cutoff),
        ).fetchall()
        removed = 0
        for row in rows:
            path = Path(row["path"])
            try:
                if path.is_file():
                    path.unlink()
                    removed += 1
            except OSError:
                continue  # a file still open elsewhere is retried next sweep
            with conn:
                conn.execute(
                    "UPDATE live_segments SET expired = 1 WHERE session_id = ? "
                    "AND artifact_id = ?",
                    (session_id, row["artifact_id"]),
                )
        return removed
    finally:
        conn.close()


def buffer_bytes(session_id: str) -> int:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(bytes), 0) AS n FROM live_segments "
            "WHERE session_id = ? AND expired = 0",
            (session_id,),
        ).fetchone()
        return int(row["n"])
    finally:
        conn.close()


def pinned_frames(session_id: str, limit: int = 400) -> list[Segment]:
    """Everything kept for the permanent record, oldest first."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM live_segments WHERE session_id = ? AND kind = 'frame' "
            "AND expired = 0 AND pinned = 1 ORDER BY media_ts LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return [
            Segment(row["artifact_id"], row["kind"], Path(row["path"]),
                    row["media_ts"], row["end_media_ts"], row["bytes"],
                    True, False)
            for row in rows
        ]
    finally:
        conn.close()


def cleanup(session_id: str) -> None:
    """Remove a finished session's media directory."""
    shutil.rmtree(session_dir(session_id), ignore_errors=True)


def clip_around(
    session_id: str, media_ts: float, before: float = 5.0, after: float = 5.0
) -> Path | None:
    """Stitch the buffered frames around a moment into a replayable clip.

    Uses the frames already on disk rather than re-reading the source, which
    is the only option for a source that no longer exists — a stopped stream,
    a closed window.
    """
    from watch_skill.health.binaries import require_binary

    frames = frames_between(session_id, media_ts - before, media_ts + after, limit=300)
    if len(frames) < 2:
        return None
    out_dir = session_dir(session_id) / "clips"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"clip_{media_ts:.2f}.mp4".replace(":", "-")
    listing = out_dir / f"list_{media_ts:.2f}.txt".replace(":", "-")
    listing.write_text(
        "".join(f"file '{seg.path.as_posix()}'\nduration 0.5\n" for seg in frames),
        encoding="utf-8",
    )
    import subprocess

    try:
        subprocess.run(
            [str(require_binary("ffmpeg")), "-y", "-f", "concat", "-safe", "0",
             "-i", str(listing),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
            check=True, capture_output=True, timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        listing.unlink(missing_ok=True)
    record(session_id, "clip", out, media_ts - before, media_ts + after, pinned=True)
    return out


def sweep_if_needed(session_id: str, keep_seconds: float, now_media_ts: float,
                    last_sweep: float, interval: float = 5.0) -> float:
    """Evict on a timer rather than per frame — the sweep costs a query."""
    now = time.time()
    if now - last_sweep < interval:
        return last_sweep
    evict(session_id, keep_seconds, now_media_ts)
    return now
