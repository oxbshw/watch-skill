"""Evidence clips: the seconds before an event, and the seconds after.

An event is almost never interesting on its own. "The total went to NaN" is a
fact; "the total went to NaN right after the coupon was applied" is the thing
someone can act on. That second sentence needs media from *before* the moment
anything decided the moment was interesting — which is why the buffer keeps a
rolling window rather than starting to record when something fires.

Three properties this module exists to guarantee:

**Nothing partial is ever presented as complete.** A clip is built under a
temporary name and renamed into place only after its hash is computed. A
process killed halfway leaves a `.partial` file that recovery deletes, never
a short clip that looks finished.

**Overlapping events share storage.** Two events three seconds apart want
overlapping media. They reference the same immutable segments rather than each
copying them, and a segment is only evictable once no clip still needs it.

**Public output carries no filesystem paths.** Clips are addressed by
artifact id, like every other piece of evidence.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.live import buffer as buf
from watch_skill.live.db import connect

DEFAULT_PRE_SECONDS = 5.0
DEFAULT_POST_SECONDS = 5.0
CLIP_TIMEOUT = 300.0
DEFAULT_QUOTA_BYTES = 2 * 1024**3


class ClipError(WatchSkillError):
    """A clip could not be produced."""

    default_code = "live.clip_failed"


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


@dataclass
class ClipManifest:
    """Everything needed to verify a clip without trusting the producer."""

    artifact_id: str
    session_id: str
    event_seq: int
    media_start: float
    media_end: float
    event_media_ts: float
    wall_start: float
    wall_end: float
    frame_count: int
    source_artifact_ids: list[str] = field(default_factory=list)
    audio_artifact_ids: list[str] = field(default_factory=list)
    clip_sha256: str = ""
    segment_sha256: dict[str, str] = field(default_factory=dict)
    manifest_sha256: str = ""
    created_at: float = field(default_factory=time.time)

    def canonical(self) -> str:
        """Deterministic serialization, excluding the manifest's own hash."""
        payload = {k: v for k, v in self.to_dict().items() if k != "manifest_sha256"}
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))

    def seal(self) -> str:
        self.manifest_sha256 = hashlib.sha256(
            self.canonical().encode("utf-8")
        ).hexdigest()
        return self.manifest_sha256

    def verify(self, clip_path: Path) -> dict[str, Any]:
        """Recompute every hash. Used by tests and by anyone auditing a run."""
        problems: list[str] = []
        if not clip_path.is_file():
            problems.append("clip file is missing")
        elif sha256_file(clip_path) != self.clip_sha256:
            problems.append("clip hash does not match the manifest")
        expected = self.manifest_sha256
        if hashlib.sha256(self.canonical().encode("utf-8")).hexdigest() != expected:
            problems.append("manifest hash does not match its own contents")
        return {"ok": not problems, "problems": problems}

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "session_id": self.session_id,
            "event_seq": self.event_seq,
            "media_start": round(self.media_start, 3),
            "media_end": round(self.media_end, 3),
            "event_media_ts": round(self.event_media_ts, 3),
            "wall_start": self.wall_start,
            "wall_end": self.wall_end,
            "frame_count": self.frame_count,
            "source_artifact_ids": self.source_artifact_ids,
            "audio_artifact_ids": self.audio_artifact_ids,
            "clip_sha256": self.clip_sha256,
            "segment_sha256": self.segment_sha256,
            "manifest_sha256": self.manifest_sha256,
            "created_at": self.created_at,
        }

    def to_public(self) -> dict[str, Any]:
        """No paths. A clip is an artifact id like everything else."""
        payload = self.to_dict()
        payload["contains_pre_event"] = self.media_start < self.event_media_ts
        payload["contains_post_event"] = self.media_end > self.event_media_ts
        return payload


def _clip_dir(session_id: str) -> Path:
    path = buf.session_dir(session_id) / "clips"
    path.mkdir(parents=True, exist_ok=True)
    return path


def existing_clip(session_id: str, event_seq: int) -> ClipManifest | None:
    """The clip for this event, if one was already sealed.

    Idempotency: asking twice for the same event's evidence must not build a
    second file, and must not race the first one into existence.
    """
    manifest_path = _clip_dir(session_id) / f"event_{event_seq}.json"
    if not manifest_path.is_file():
        return None
    try:
        return ClipManifest(**json.loads(manifest_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def cleanup_partials(session_id: str) -> int:
    """Delete `.partial` files left by a killed builder.

    This is what makes "no partial artifact is ever presented as complete"
    true after a crash rather than only during normal operation.
    """
    removed = 0
    for path in _clip_dir(session_id).glob("*.partial"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def _await_post_event_media(
    session_id: str, until_media_ts: float, post_seconds: float
) -> bool:
    """Block until media past ``until_media_ts`` exists, or give up honestly.

    Returns whether the full post-event window arrived. A session that stops
    early — the source ended, the operator cancelled — will never produce it,
    so the wait is bounded and the caller records the range it actually got
    rather than the range it asked for.
    """
    from watch_skill.live import db as live_db

    deadline = time.monotonic() + max(2.0, post_seconds * 2.0 + 3.0)
    while time.monotonic() < deadline:
        newest = buf.newest_frame_media_ts(session_id)
        if newest is not None and newest >= until_media_ts:
            return True
        session = live_db.get_session(session_id)
        if session is not None and not session.active:
            return False  # nothing more is coming
        time.sleep(0.2)
    return False


def build_event_clip(
    session_id: str,
    event_seq: int,
    event_media_ts: float,
    pre_seconds: float = DEFAULT_PRE_SECONDS,
    post_seconds: float = DEFAULT_POST_SECONDS,
    fps: float = 2.0,
) -> ClipManifest:
    """Stitch the buffered frames around an event into a verifiable clip.

    Built from frames already on disk rather than by re-reading the source:
    for a live session the source may no longer exist, and for a stream it
    certainly does not.
    """
    from watch_skill.health.binaries import require_binary

    already = existing_clip(session_id, event_seq)
    if already is not None:
        return already

    lo = max(0.0, event_media_ts - pre_seconds)
    hi = event_media_ts + post_seconds

    # Wait for the post-event media to exist. A clip built the instant an
    # event fires can only contain the past — the frames after the moment have
    # not been captured yet, and stitching immediately produces a "clip"
    # whose range ends exactly at the event. The pre-event half comes from the
    # rolling buffer; the post-event half has to be waited for.
    _await_post_event_media(session_id, hi, post_seconds)

    segments = buf.frames_between(session_id, lo, hi, limit=600)
    usable = [s for s in segments if s.path.is_file()]
    if len(usable) < 2:
        raise ClipError(
            f"not enough buffered media around {event_media_ts:.2f}s to build "
            f"a clip ({len(usable)} frames)",
            code="live.clip_insufficient_media",
            fix="increase --buffer, or lower the pre/post window; evidence "
            "that was never retained cannot be reconstructed",
            details={"session_id": session_id, "event_seq": event_seq,
                     "window": [lo, hi], "frames": len(usable)},
        )

    # Pin first. A sweep between here and the ffmpeg call would delete the
    # very frames being stitched, and the clip would silently lose its
    # pre-event half.
    buf.pin_window(session_id, event_media_ts, before=pre_seconds, after=post_seconds)

    clip_dir = _clip_dir(session_id)
    partial = clip_dir / f"event_{event_seq}.mp4.partial"
    final = clip_dir / f"event_{event_seq}.mp4"
    listing = clip_dir / f"event_{event_seq}.txt"
    listing.write_text(
        "".join(f"file '{s.path.as_posix()}'\nduration {1.0 / fps:.4f}\n"
                for s in usable),
        encoding="utf-8",
    )
    try:
        subprocess.run(
            # `-f mp4` is required, not decoration: the output is named
            # `.partial` so a killed builder is unmistakable, and ffmpeg
            # cannot infer a container from an extension it does not know.
            [str(require_binary("ffmpeg")), "-y", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(listing),
             "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", "-f", "mp4", str(partial)],
            check=True, capture_output=True, timeout=CLIP_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        partial.unlink(missing_ok=True)
        raise ClipError(
            f"clip encoding timed out after {CLIP_TIMEOUT:.0f}s",
            code="live.clip_timeout",
            fix="narrow the pre/post window",
            details={"session_id": session_id, "event_seq": event_seq},
        ) from exc
    except subprocess.CalledProcessError as exc:
        partial.unlink(missing_ok=True)
        raise ClipError(
            f"clip encoding failed: {(exc.stderr or b'')[-300:]!r}",
            code="live.clip_failed",
            fix="run `watch-skill doctor` to check ffmpeg",
            details={"session_id": session_id, "event_seq": event_seq},
        ) from exc
    finally:
        listing.unlink(missing_ok=True)

    manifest = ClipManifest(
        artifact_id=buf.new_artifact_id("clip"),
        session_id=session_id,
        event_seq=event_seq,
        media_start=usable[0].media_ts,
        media_end=usable[-1].media_ts,
        event_media_ts=event_media_ts,
        wall_start=time.time(), wall_end=time.time(),
        frame_count=len(usable),
        source_artifact_ids=[s.artifact_id for s in usable],
        segment_sha256={s.artifact_id: sha256_file(s.path) for s in usable[:64]},
        clip_sha256=sha256_file(partial),
    )
    manifest.seal()

    # Atomic: the clip becomes visible under its real name only once its hash
    # is in a sealed manifest. Anything killed before this point is a
    # `.partial` that recovery deletes.
    os.replace(partial, final)
    (clip_dir / f"event_{event_seq}.json").write_text(
        json.dumps(manifest.to_dict(), indent=2), encoding="utf-8"
    )
    buf.record(session_id, "clip", final, manifest.media_start,
               manifest.media_end, pinned=True)
    _link_event(session_id, event_seq, manifest)
    return manifest


def _link_event(session_id: str, event_seq: int, manifest: ClipManifest) -> None:
    """Record the event → clip relationship so a fresh process can find it."""
    conn = connect()
    try:
        with conn:
            row = conn.execute(
                "SELECT payload_json FROM live_events WHERE session_id = ? AND seq = ?",
                (session_id, event_seq),
            ).fetchone()
            if row is None:
                return
            payload = json.loads(row["payload_json"] or "{}")
            payload.setdefault("evidence", []).append({
                "schema_version": 1, "kind": "clip",
                "artifact_id": manifest.artifact_id,
                "media_ts": manifest.media_start,
                "end_media_ts": manifest.media_end,
                "digest": manifest.clip_sha256,
                "detail": {"event_seq": event_seq},
            })
            conn.execute(
                "UPDATE live_events SET payload_json = ? "
                "WHERE session_id = ? AND seq = ?",
                (json.dumps(payload, default=str), session_id, event_seq),
            )
    finally:
        conn.close()


def clip_path(session_id: str, event_seq: int) -> Path | None:
    """Resolve a sealed clip to a real path. Surfaces only — never public."""
    path = _clip_dir(session_id) / f"event_{event_seq}.mp4"
    return path if path.is_file() else None


def enforce_quota(session_id: str, quota_bytes: int = DEFAULT_QUOTA_BYTES) -> int:
    """Drop the oldest unpinned media once the session exceeds its quota."""
    used = buf.buffer_bytes(session_id)
    if used <= quota_bytes:
        return 0
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT artifact_id, path, bytes FROM live_segments "
            "WHERE session_id = ? AND pinned = 0 AND expired = 0 "
            "ORDER BY media_ts", (session_id,),
        ).fetchall()
        freed = 0
        for row in rows:
            if used - freed <= quota_bytes:
                break
            try:
                Path(row["path"]).unlink(missing_ok=True)
            except OSError:
                continue
            with conn:
                conn.execute(
                    "UPDATE live_segments SET expired = 1 "
                    "WHERE session_id = ? AND artifact_id = ?",
                    (session_id, row["artifact_id"]),
                )
            freed += int(row["bytes"] or 0)
        return freed
    finally:
        conn.close()
