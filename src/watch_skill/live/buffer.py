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
import threading
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


def oldest_frame_media_ts(session_id: str) -> float | None:
    """The media timestamp of the oldest frame still on disk, or None.

    The counterpart to `newest_frame_media_ts`. Together they bound what can
    still be asked for, which is what lets a refusal name a cause instead of
    shrugging.
    """
    conn = connect()
    try:
        row = conn.execute(
            "SELECT MIN(media_ts) AS oldest FROM live_segments WHERE session_id = ? "
            "AND kind = 'frame' AND expired = 0",
            (session_id,),
        ).fetchone()
        return None if row is None or row["oldest"] is None else float(row["oldest"])
    finally:
        conn.close()


def _evicted_in(session_id: str, start: float, end: float) -> int:
    """How many frames in a window were captured and later swept away."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM live_segments WHERE session_id = ? "
            "AND kind = 'frame' AND expired = 1 AND media_ts BETWEEN ? AND ?",
            (session_id, start, end),
        ).fetchone()
        return 0 if row is None else int(row["n"])
    finally:
        conn.close()


def explain_window(
    session_id: str, start: float, end: float, frames: list[Segment]
) -> str:
    """Why a window cannot be stitched. Three causes, three sentences.

    They are not the same problem and must not get the same message:

    * captured and later evicted — the retention window is shorter than the
      delay between the moment and the request, which a setting can fix;
    * never captured that early — the source began producing frames after the
      moment, which no setting can fix after the fact;
    * present but too few to stitch.

    Telling the first two apart is the difference between "raise the buffer"
    and "that evidence never existed", and a caller that cannot tell will
    spend an afternoon adjusting the wrong one.
    """
    evicted = _evicted_in(session_id, start, end)
    if evicted > 0:
        return (
            f"{evicted} frame(s) in {start:.2f}s–{end:.2f}s were captured and "
            f"then evicted before the clip was asked for; the session's buffer "
            f"window is shorter than the delay before the request"
        )
    oldest = oldest_frame_media_ts(session_id)
    if not frames and oldest is not None and oldest > start:
        return (
            f"no frame was ever captured in {start:.2f}s–{end:.2f}s; the "
            f"earliest frame this session holds is at {oldest:.2f}s, so the "
            f"moment happened before capture produced anything"
        )
    if oldest is None:
        return (
            f"this session has captured no frames at all, so there is nothing "
            f"in {start:.2f}s–{end:.2f}s to stitch"
        )
    return (
        f"only {len(frames)} frame(s) are available in {start:.2f}s–{end:.2f}s, "
        f"and stitching needs at least two"
    )


def _spans(frames: list[Segment], moment: float) -> bool:
    """Whether these frames have something on each side of a moment."""
    return (any(frame.media_ts < moment for frame in frames)
            and any(frame.media_ts >= moment for frame in frames))


def _explain_unsatisfied(
    session_id: str, start: float, end: float, frames: list[Segment],
    require_span_at: float | None,
) -> str:
    """Why the window is not usable, including a span that never closed."""
    if len(frames) >= 2 and require_span_at is not None:
        side = ("at or after" if not any(f.media_ts >= require_span_at
                                         for f in frames) else "before")
        return (
            f"{len(frames)} frame(s) are buffered in {start:.2f}s–{end:.2f}s "
            f"but none {side} {require_span_at:.2f}s, so a clip built from "
            f"them would not span the moment it is meant to explain"
        )
    return explain_window(session_id, start, end, frames)


def await_clip_window(
    session_id: str,
    start: float,
    end: float,
    *,
    timeout: float,
    cancel: threading.Event | None = None,
    poll: float = 0.2,
    require_span_at: float | None = None,
) -> tuple[list[Segment], str | None]:
    """Wait until a window can be stitched, or until it provably cannot.

    Four callers had written this loop and all four had written the same
    mistake into it: they waited for the *newest* frame to pass the far edge
    of the window and treated that as success. It is the opposite — it is the
    moment the answer becomes final. Every frame captured after it has a
    media timestamp greater than the newest, so once the newest is past
    `end` no future frame can land inside the window, and a window that is
    still short is short for good.

    On a machine where the source starts slowly that mistake is invisible:
    the first frame arrives already past the far edge, the wait succeeds
    instantly, and the clip is requested over a range that never existed.
    That is not a race to be slept through — waiting longer cannot help, and
    lengthening the timeout only makes the failure slower.

    So the loop below stops on the first of four things: the window is
    usable, the window is final and short, the source has stopped, or the
    caller cancelled. The deadline is the backstop, not the mechanism.

    `require_span_at` asks for the stronger condition some callers actually
    need: not merely enough frames to stitch, but frames on *both* sides of a
    moment. Two frames that both land after a failure make a clip that cannot
    explain it, and a caller that waits only for stitchability gets exactly
    that whenever the far side is still arriving.

    Returns the frames and `None`, or the frames it has and the reason it
    stopped.
    """
    from watch_skill.live import db as live_db

    def usable() -> list[Segment]:
        # A row can outlive its file — eviction unlinks first and marks the
        # row afterwards, and a half-swept window would otherwise look whole.
        return [seg for seg in frames_between(session_id, start, end, limit=600)
                if seg.path.is_file()]

    def satisfied(found: list[Segment]) -> bool:
        if len(found) < 2:
            return False
        return require_span_at is None or _spans(found, require_span_at)

    deadline = time.monotonic() + max(0.0, timeout)
    frames = usable()
    while True:
        if satisfied(frames):
            return frames, None
        if cancel is not None and cancel.is_set():
            return frames, (
                f"the wait for media in {start:.2f}s–{end:.2f}s was cancelled"
            )
        newest = newest_frame_media_ts(session_id)
        if newest is not None and newest >= end:
            # Final: nothing captured from here on can be inside the window.
            return frames, _explain_unsatisfied(
                session_id, start, end, frames, require_span_at)
        session = live_db.get_session(session_id)
        if session is not None and not session.active:
            return frames, (
                f"the source stopped before media reached {end:.2f}s; "
                + _explain_unsatisfied(
                    session_id, start, end, frames, require_span_at)
            )
        if time.monotonic() >= deadline:
            return frames, (
                f"waited {timeout:.1f}s for media through {end:.2f}s and it did "
                f"not arrive; " + _explain_unsatisfied(
                    session_id, start, end, frames, require_span_at)
            )
        time.sleep(poll)
        frames = usable()


def clip_around(
    session_id: str, media_ts: float, before: float = 5.0, after: float = 5.0,
    *, timeout: float = 40.0, cancel: threading.Event | None = None,
) -> Path:
    """Stitch the buffered frames around a moment into a replayable clip.

    Uses the frames already on disk rather than re-reading the source, which
    is the only option for a source that no longer exists — a stopped stream,
    a closed window. Waits for the far side of the window to be captured
    before looking, because a clip requested the instant an event fires can
    only contain the past.

    Raises `ClipError` rather than returning `None`. This module's opening
    paragraph argues that an expired row beats a blank — "asking for evidence
    that has aged out gets an honest 'that has been evicted' instead of
    silence" — and this builder was the one place that did not honour it.
    Three callers had `assert clip` with no way to say what went wrong.
    """
    from watch_skill.health.binaries import require_binary
    from watch_skill.live.clips import ClipError

    lo, hi = media_ts - before, media_ts + after
    frames, why = await_clip_window(
        session_id, lo, hi, timeout=timeout, cancel=cancel)
    if why is not None:
        raise ClipError(
            f"cannot build a clip around {media_ts:.2f}s: {why}",
            code="live.clip_insufficient_media",
            fix="widen the session's buffer window, narrow the requested "
                "pre/post window, or accept that this moment has no media; "
                "evidence that was never retained cannot be reconstructed",
            details={"session_id": session_id, "window": [lo, hi],
                     "frames": len(frames)},
        )

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
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        stderr = getattr(exc, "stderr", b"") or b""
        tail = stderr.decode("utf-8", "replace").strip().splitlines()[-1:]
        raise ClipError(
            f"the encoder failed on {len(frames)} frame(s) around {media_ts:.2f}s",
            code="live.clip_encode_failed",
            fix="run `watch-skill doctor` to check ffmpeg; the frames are "
                "still buffered, so the clip can be asked for again",
            details={"session_id": session_id, "window": [lo, hi],
                     "encoder": (tail[0] if tail else str(exc))[:400]},
        ) from exc
    finally:
        listing.unlink(missing_ok=True)
    record(session_id, "clip", out, lo, hi, pinned=True)
    return out


def sweep_if_needed(session_id: str, keep_seconds: float, now_media_ts: float,
                    last_sweep: float, interval: float = 5.0) -> float:
    """Evict on a timer rather than per frame — the sweep costs a query."""
    now = time.time()
    if now - last_sweep < interval:
        return last_sweep
    evict(session_id, keep_seconds, now_media_ts)
    return now


def newest_frame_media_ts(session_id: str) -> float | None:
    """The media timestamp of the most recent buffered frame, or None.

    Used to tell whether the media after an event has actually been captured
    yet — a clip cannot contain frames the source has not produced.
    """
    conn = connect()
    try:
        row = conn.execute(
            "SELECT MAX(media_ts) AS newest FROM live_segments "
            "WHERE session_id = ? AND kind = 'frame' AND expired = 0",
            (session_id,),
        ).fetchone()
        return None if row is None or row["newest"] is None else float(row["newest"])
    finally:
        conn.close()
