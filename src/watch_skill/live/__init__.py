"""Live video understanding: watch what is happening, as it happens.

The property that makes this "live" rather than "batch with a nicer name":
events are emitted while the source is still producing media. A file replayed
through :class:`~watch_skill.live.types.LiveSourceKind.FILE_REPLAY` is paced
at real time for exactly this reason — the pipeline cannot tell it from a
camera, so the end-to-end tests prove the real property without hardware.

Shape of a session:

* capture pulls frames as fast as the source yields them;
* a *perception* stage takes only the newest frame and counts what it skipped;
* a *persistence* stage drops nothing, so evidence exists for moments nobody
  has yet decided were interesting;
* local detectors turn frames into events — no model runs per frame;
* events are appended with atomically allocated sequence numbers and read by
  cursor, so consuming twice is idempotent;
* stopping and finalising turns the session into ordinary searchable video
  memory without reprocessing the media.
"""
from __future__ import annotations

from watch_skill.live.ask import ask_live
from watch_skill.live.capabilities import capability_for, capability_matrix
from watch_skill.live.clock import SessionClock, correlate
from watch_skill.live.finalize import finalize_session
from watch_skill.live.session import (
    LiveError,
    aligned_evidence,
    frame_for,
    get_session,
    list_live,
    observe,
    start_live,
    status,
    stop_all,
    stop_live,
)
from watch_skill.live.types import (
    LIVE_SCHEMA_VERSION,
    CaptureCapability,
    EvidenceReference,
    LiveCursor,
    LiveEvent,
    LiveEventType,
    LiveProfile,
    LiveSession,
    LiveSourceKind,
    LiveSourceSpec,
    LiveState,
    StateChange,
    TemporalEntity,
)

__all__ = [
    "LIVE_SCHEMA_VERSION",
    "CaptureCapability",
    "EvidenceReference",
    "LiveCursor",
    "LiveError",
    "SessionClock",
    "LiveEvent",
    "LiveEventType",
    "LiveProfile",
    "LiveSession",
    "LiveSourceKind",
    "LiveSourceSpec",
    "LiveState",
    "StateChange",
    "TemporalEntity",
    "aligned_evidence",
    "ask_live",
    "correlate",
    "capability_for",
    "capability_matrix",
    "finalize_session",
    "frame_for",
    "get_session",
    "list_live",
    "observe",
    "start_live",
    "status",
    "stop_all",
    "stop_live",
]
