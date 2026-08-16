"""Versioned contracts for live watching.

Two clocks, kept apart on purpose:

``media_ts``
    Seconds into the source. What a citation means, and what survives
    finalisation into the video index.
``wall_ts``
    Unix time. What a human reads and what correlates with an agent's logs.
``monotonic``
    Ordering only. Never displayed, never persisted as a timestamp — it is
    meaningless across processes, and using it for either of the above is how
    event ordering silently breaks when the system clock steps.

Every persisted or externally returned structure carries ``schema_version``.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

LIVE_SCHEMA_VERSION = 1


class LiveSourceKind(str, Enum):  # noqa: UP042 — matches SourceKind
    """Where live media comes from."""

    FILE_REPLAY = "file_replay"
    """A local file played at real time. A real live source, not a shortcut:
    the pipeline cannot tell the difference, so it is what the end-to-end
    tests use instead of hardware."""

    BROWSER = "browser"
    SCREEN = "screen"
    WINDOW = "window"
    CAMERA = "camera"
    STREAM = "stream"
    """RTSP / RTMP / HLS / DASH — anything FFmpeg can open."""

    PUSHED = "pushed"
    """Frames and audio handed in by an SDK caller."""


class LiveState(str, Enum):  # noqa: UP042 — matches SourceKind
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FINALIZED = "finalized"
    FAILED = "failed"


TERMINAL_LIVE_STATES = frozenset({LiveState.FINALIZED, LiveState.FAILED})


class LiveEventType(str, Enum):  # noqa: UP042 — matches SourceKind
    """What kinds of thing a live session reports."""

    SESSION_STARTED = "session_started"
    SESSION_STOPPED = "session_stopped"
    SCENE_CHANGE = "scene_change"
    VISIBLE_TEXT_CHANGE = "visible_text_change"
    SPEECH = "speech"
    MOTION = "motion"
    UI_STATE_CHANGE = "ui_state_change"
    ENTITY_APPEARED = "entity_appeared"
    ENTITY_DISAPPEARED = "entity_disappeared"
    ACTION = "action"
    ANOMALY = "anomaly"
    ERROR = "error"
    TRIGGER_MATCH = "trigger_match"
    CAPTURE_GAP = "capture_gap"
    PROVIDER_DEGRADED = "provider_degraded"

    BROWSER_EVENT = "browser_event"
    """Structured evidence from a watched browser — navigation, DOM and
    accessibility changes, request metadata, downloads, popups. Errors from a
    browser are reported as ``ERROR`` instead, so an operator filtering for
    failures sees them without knowing which source produced them."""


class Provenance(str, Enum):  # noqa: UP042 — matches SourceKind
    """Whether an event is something we SAW or something we concluded.

    Kept explicit because an agent that cannot tell an observation from an
    inference will cite a guess as evidence.
    """

    OBSERVATION = "observation"
    INFERENCE = "inference"


class LiveProfile(str, Enum):  # noqa: UP042 — matches SourceKind
    """How much work is done per second of media.

    All of these run locally. ``cloud-live`` is deliberately absent from the
    default set: a profile that requires egress is opt-in configuration, not
    a name you can reach by accident.
    """

    LOCAL_LITE = "local-lite"
    """Scene change + OCR at a low frame rate. Cheapest; the default."""

    LOCAL_REALTIME = "local-realtime"
    """Higher frame rate, motion regions, streaming transcription."""

    FORENSIC = "forensic"
    """Keep everything, drop nothing, retain the full buffer."""


class EvidenceReference(BaseModel):
    """A pointer to something that can be looked at again.

    Never a raw local path in public output — surfaces resolve
    ``artifact_id`` through the session so a tool result cannot be used to
    enumerate the filesystem.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    kind: str  # frame | clip | audio | ocr | transcript | dom | console
    artifact_id: str
    media_ts: float
    end_media_ts: float | None = None
    digest: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class TemporalEntity(BaseModel):
    """Something present in the scene at a moment."""

    schema_version: int = LIVE_SCHEMA_VERSION
    entity_id: str
    label: str
    kind: str = "unknown"  # text | object | person | ui_element
    confidence: float = 0.0
    first_media_ts: float = 0.0
    last_media_ts: float = 0.0


class StateChange(BaseModel):
    """A named thing that had one value and now has another."""

    schema_version: int = LIVE_SCHEMA_VERSION
    key: str
    before: Any = None
    after: Any = None
    media_ts: float = 0.0


class LiveEvent(BaseModel):
    """One fact about a live session, in the order it was observed."""

    schema_version: int = LIVE_SCHEMA_VERSION
    session_id: str
    seq: int
    media_ts: float
    wall_ts: float
    type: LiveEventType
    final: bool = True
    """False while a result may still be revised — a provisional transcript
    segment, for instance. A citation is only published against a final
    event, because correcting a quote an agent already used is worse than
    being slightly late."""

    confidence: float = 1.0
    provenance: Provenance = Provenance.OBSERVATION
    summary: str = ""
    evidence: list[EvidenceReference] = Field(default_factory=list)
    entities: list[TemporalEntity] = Field(default_factory=list)
    state_changes: list[StateChange] = Field(default_factory=list)
    detector: str = ""
    trace_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        """The shape a model sees. Artifact ids, never filesystem paths."""
        return {
            "schema_version": self.schema_version,
            "seq": self.seq,
            "media_ts": round(self.media_ts, 3),
            "wall_ts": self.wall_ts,
            "type": self.type.value,
            "final": self.final,
            "confidence": round(self.confidence, 3),
            "provenance": self.provenance.value,
            "summary": self.summary,
            "evidence": [
                {"kind": ref.kind, "artifact_id": ref.artifact_id,
                 "media_ts": round(ref.media_ts, 3)}
                for ref in self.evidence
            ],
            "state_changes": [
                {"key": c.key, "before": c.before, "after": c.after}
                for c in self.state_changes
            ],
            "detector": self.detector,
            # The structured payload a detector attached — a browser's
            # navigation epoch and redaction status, a semantic reading's
            # model and confidence. Producers bound it before it gets here;
            # withholding it would leave every surface able to see that
            # something happened and unable to say what.
            "detail": self.detail,
        }


class LiveCursor(BaseModel):
    """Where a consumer has read up to.

    A sequence number rather than a timestamp, so replaying the same cursor
    returns the same events and consuming twice is idempotent.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    session_id: str
    seq: int = 0

    def encode(self) -> str:
        return f"{self.session_id}:{self.seq}"

    @classmethod
    def decode(cls, value: str, session_id: str) -> LiveCursor:
        """Parse a cursor, tolerating a bare integer or a missing value.

        A cursor from a *different* session is refused rather than silently
        reset: it usually means the caller mixed up two sessions, and
        starting from zero would flood them with events they already saw.
        """
        from watch_skill.errors import WatchSkillError

        if not value:
            return cls(session_id=session_id, seq=0)
        text = str(value).strip()
        if ":" not in text:
            if text.lstrip("-").isdigit():
                return cls(session_id=session_id, seq=max(0, int(text)))
            raise WatchSkillError(
                f"malformed live cursor: {value!r}",
                code="live.bad_cursor",
                fix="pass the `next_cursor` from the previous observe_live "
                "call, or omit it to start from the beginning",
            )
        owner, _, seq = text.rpartition(":")
        if owner != session_id:
            raise WatchSkillError(
                f"cursor belongs to session {owner!r}, not {session_id!r}",
                code="live.cursor_session_mismatch",
                fix="use the cursor returned by observe_live for THIS session",
                details={"cursor_session": owner, "session_id": session_id},
            )
        return cls(session_id=session_id, seq=max(0, int(seq or 0)))


class LiveSourceSpec(BaseModel):
    """What to watch, and how."""

    schema_version: int = LIVE_SCHEMA_VERSION
    kind: LiveSourceKind
    target: str
    profile: LiveProfile = LiveProfile.LOCAL_LITE
    fps: float = Field(default=2.0, gt=0, le=30)
    """Analysis frame rate, not capture frame rate. Capture keeps up; this is
    how often a frame is looked at."""

    buffer_seconds: float = Field(default=120.0, gt=0)
    max_duration_seconds: float = Field(default=3600.0, gt=0)
    audio: bool = True
    detail: dict[str, Any] = Field(default_factory=dict)


class LiveBudget(BaseModel):
    """Hard ceilings a session may not exceed."""

    schema_version: int = LIVE_SCHEMA_VERSION
    max_frames_analyzed: int = 20000
    max_egress_frames: int = 0
    """Frames permitted to leave the machine. Zero by default: live watching
    is local unless someone says otherwise."""

    max_usd: float = 0.0
    max_buffer_bytes: int = 2 * 1024**3


class LiveStats(BaseModel):
    """What the session is actually doing, as opposed to intending to."""

    schema_version: int = LIVE_SCHEMA_VERSION
    frames_captured: int = 0
    frames_analyzed: int = 0
    frames_dropped: int = 0
    """Dropped on purpose, by a bounded queue preferring the newest frame.
    Counted rather than hidden: a live view that silently skips is a live
    view you cannot trust."""

    audio_chunks: int = 0
    audio_gap_seconds: float = 0.0
    events_emitted: int = 0
    queue_depths: dict[str, int] = Field(default_factory=dict)
    capture_fps: float = 0.0
    analyzed_fps: float = 0.0
    last_event_latency_ms: float = 0.0
    provider_failures: int = 0


class LiveSession(BaseModel):
    """A live watch, and everything durable about it."""

    schema_version: int = LIVE_SCHEMA_VERSION
    session_id: str
    spec: LiveSourceSpec
    state: LiveState = LiveState.STARTING
    budget: LiveBudget = Field(default_factory=LiveBudget)
    stats: LiveStats = Field(default_factory=LiveStats)
    policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    started_at: float = Field(default_factory=time.time)
    heartbeat_at: float = Field(default_factory=time.time)
    stopped_at: float | None = None
    finalized_video_id: str | None = None
    error: dict[str, Any] | None = None
    last_seq: int = 0

    @property
    def active(self) -> bool:
        return self.state in (LiveState.STARTING, LiveState.RUNNING, LiveState.PAUSED)

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "state": self.state.value,
            "source": {"kind": self.spec.kind.value, "target": self.spec.target,
                       "profile": self.spec.profile.value, "fps": self.spec.fps},
            "started_at": self.started_at,
            "elapsed_seconds": round(
                (self.stopped_at or time.time()) - self.started_at, 2
            ),
            "last_seq": self.last_seq,
            "stats": self.stats.model_dump(),
            "finalized_video_id": self.finalized_video_id,
            "error": self.error,
        }


class CaptureCapability(BaseModel):
    """Whether one kind of capture actually works on this machine."""

    schema_version: int = LIVE_SCHEMA_VERSION
    kind: str
    status: str  # available | unavailable | degraded | untested
    backend: str = ""
    audio: bool = False
    video: bool = False
    requires_permission: str = ""
    missing_binary: str = ""
    missing_system_api: str = ""
    limitations: list[str] = Field(default_factory=list)
    repair: str = ""
    verified: str = "not_tested"
    """How the status was established: `machine_tested`, `probed`, or
    `not_tested`. A capability nobody probed is never reported available."""
