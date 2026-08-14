"""Turning a finished live session into ordinary, searchable video memory.

The requirement this satisfies: after finalisation the session is a normal
Watch Skill video — `ask_video`, `search_videos`, the viewer, all of it —
*without* reprocessing the media from scratch. The frames were already
extracted and OCR'd while the session ran; finalising moves that work into the
index rather than repeating it.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live.types import LiveEventType, LiveState


def finalize_session(session_id: str, ctx: Any = None) -> str:
    """Index a stopped session's pinned evidence; returns the video_id.

    Only *pinned* frames are carried over. Everything a detector found
    interesting was pinned when it fired, so this keeps the moments that
    mattered and lets the rest expire — which is the point of a rolling
    buffer.
    """
    from watch_skill.acquire.identify import capture_revision
    from watch_skill.acquire.sources import SourceKind
    from watch_skill.acquire.types import AcquireResult
    from watch_skill.index.store import index_watch_result
    from watch_skill.perceive.types import Frame, OcrBlock, PerceptionResult, VideoMetadata
    from watch_skill.transcribe.types import Segment, Transcript
    from watch_skill.watch import WatchResult

    session = db.get_session(session_id)
    if session is None:
        raise WatchSkillError(
            f"unknown live session: {session_id}",
            code="live.session_not_found",
            fix="`watch-skill live list` shows sessions on this machine",
            details={"session_id": session_id},
        )
    if session.state in (LiveState.STARTING, LiveState.RUNNING, LiveState.PAUSED):
        raise WatchSkillError(
            f"session {session_id} is still {session.state.value}",
            code="live.not_stopped",
            fix="stop it first (`watch-skill live stop <session_id>`); "
            "finalising a running session would index a moving target",
            details={"state": session.state.value},
        )
    if session.finalized_video_id:
        return session.finalized_video_id  # idempotent

    segments = buf.pinned_frames(session_id)
    frames: list[Frame] = []
    events = db.read_events(session_id, limit=500)
    ocr_by_ts = {
        round(change.media_ts or event.media_ts, 2): str(change.after)
        for event in events
        for change in event.state_changes
        if change.key == "visible_text" and change.after
    }
    for index, segment in enumerate(segments):
        if not segment.path.is_file():
            continue
        text = ocr_by_ts.get(round(segment.media_ts, 2), "")
        frames.append(Frame(
            index=index,
            timestamp_seconds=segment.media_ts,
            path=segment.path,
            scene_id=index,
            phash="",
            reason="live-pinned",
            ocr_blocks=[OcrBlock(text=text, bbox=(0.0, 0.0, 1.0, 1.0),
                                 confidence=0.9)] if text else [],
        ))

    if ctx is not None:
        ctx.checkpoint(progress=0.6)

    duration = max((event.media_ts for event in events), default=0.0)
    metadata = VideoMetadata(
        duration_seconds=duration, width=None, height=None, fps=session.spec.fps,
        codec=None, has_audio=False,
    )
    # The event log becomes the transcript-shaped record: it is what the
    # session actually observed, with timestamps, and it makes the session
    # searchable through exactly the same path as a spoken transcript.
    transcript = Transcript(
        segments=[
            Segment(event.media_ts, event.media_ts + 1.0,
                    f"[{event.type.value}] {event.summary}")
            for event in events
            if event.summary and event.type is not LiveEventType.SESSION_STARTED
        ],
        source="live-events",
    )

    label = f"live:{session.spec.kind.value}:{session_id}"
    acquisition = AcquireResult(
        source=label,
        kind=SourceKind.LOCAL_FILE,
        video_path=None,
        info={"title": f"Live session {session_id}",
              "uploader": session.spec.kind.value,
              "duration": duration},
        acquirer="live",
    )
    # A live session's identity is the session, not a file: it is unrepeatable
    # by nature, so its revision is minted from what it actually produced.
    anchor = segments[0].path if segments else None
    acquisition.revision = (
        capture_revision(anchor, label) if anchor and anchor.is_file() else None
    )

    result = WatchResult(
        acquisition=acquisition,
        metadata=metadata,
        perception=PerceptionResult(source=label, metadata=metadata, frames=frames)
        if frames else None,
        transcript=transcript,
        work_dir=Path(buf.session_dir(session_id)),
    )
    video_id = index_watch_result(result, describe_scenes=False)

    db.update_session(session_id, state=LiveState.FINALIZED,
                      finalized_video_id=video_id,
                      stopped_at=session.stopped_at or time.time())
    if ctx is not None:
        ctx.checkpoint(progress=0.95)
    return video_id
