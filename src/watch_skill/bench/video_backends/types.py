"""The transport-independent vocabulary the video-backend benchmark scores.

Nothing in this module knows what MCP is. A backend reached over stdio, over
a REST API, or replayed from a recorded fixture produces the same three
things — frames, cues, and call records — and the scorer only ever sees
these. One scorer therefore outlives the transport it was written against:
when Adversal ships the direct API they have said is coming, it becomes a
second adapter rather than a second benchmark.

The one rule these types exist to enforce: **absence is never success.**
Every outcome carries an explicit :class:`OutcomeStatus`, and there is no way
to hand the scorer an empty frame list that reads as a backend which returned
nothing wrong. A backend that could not produce evidence is scored as a
backend that could not produce evidence.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class OutcomeStatus(str, Enum):  # noqa: UP042 — matches the repo's SourceKind style
    """What actually happened, in terms a scorer can act on.

    Deliberately finer-grained than ok/error: Watch Skill's evidence model
    distinguishes "this source has no transcript" from "we could not reach
    the service", and a backend that cannot be mapped onto that distinction
    cannot feed durable evidence.
    """

    OK = "ok"
    """Evidence was produced and is present."""

    NOT_SUBMITTED = "not_submitted"
    """No job exists for this source yet."""

    NOT_READY = "not_ready"
    """The job exists and is still running. Retryable by waiting."""

    UNAVAILABLE = "unavailable"
    """The job finished but this artifact does not exist for it.

    Distinct from FAILED: the pipeline succeeded, this slice of it did not.
    """

    FAILED = "failed"
    """The provider's pipeline reported a terminal failure."""

    AUTH_REQUIRED = "auth_required"
    """The call needs credentials that are absent or expired."""

    INVALID_INPUT = "invalid_input"
    """The provider rejected the request before doing any work."""

    QUOTA_EXHAUSTED = "quota_exhausted"
    """Refused for lack of remaining allowance."""

    TRANSPORT_ERROR = "transport_error"
    """The call did not complete: connection, timeout, protocol."""

    UNKNOWN = "unknown"
    """The provider answered in a way this adapter could not classify.

    Never collapsed into an error: an unclassifiable answer is a finding
    about the interface, and hiding it inside TRANSPORT_ERROR would erase it.
    """

    @property
    def is_success(self) -> bool:
        return self is OutcomeStatus.OK

    @property
    def is_retryable(self) -> bool:
        """Whether waiting and asking again could plausibly change the answer."""
        return self in (
            OutcomeStatus.NOT_READY,
            OutcomeStatus.TRANSPORT_ERROR,
        )


class TimestampSemantics(str, Enum):  # noqa: UP042
    """What a returned timestamp is claimed to mean.

    Set from what the adapter can *establish*, never from what would be
    convenient. ``UNKNOWN`` is the honest default and the report says so
    rather than assuming a returned number is decoded media time.
    """

    REQUESTED = "requested"
    """The time the caller asked for, echoed back."""

    DECODED = "decoded"
    """The presentation time of the frame that was actually decoded."""

    SCENE = "scene"
    """A scene boundary the provider chose."""

    KEYFRAME = "keyframe"
    """The nearest keyframe."""

    UNKNOWN = "unknown"
    """Not stated by the provider and not derivable from its output."""


@dataclass(frozen=True)
class BackendFrame:
    """One frame a backend returned, in the backend's own terms.

    ``index`` is position in the returned ordering, kept separate from
    ``timestamp_seconds`` on purpose: the whole point of the ordering checks
    is to find out whether those two ever disagree.
    """

    index: int
    timestamp_seconds: float | None
    path: Path | None = None
    provider_id: str | None = None
    semantics: TimestampSemantics = TimestampSemantics.UNKNOWN
    ocr_text: str | None = None
    requested_seconds: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "timestamp_seconds": self.timestamp_seconds,
            "path": str(self.path) if self.path is not None else None,
            "provider_id": self.provider_id,
            "semantics": self.semantics.value,
            "ocr_text": self.ocr_text,
            "requested_seconds": self.requested_seconds,
            "raw": self.raw,
        }


@dataclass(frozen=True)
class BackendCue:
    """One transcript cue a backend returned."""

    index: int
    start: float | None
    end: float | None
    text: str
    speaker: str | None = None
    provider_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CallRecord:
    """One request to the backend, with its cost in wall clock.

    Arguments are recorded already sanitized — see :mod:`sanitize`. A raw
    request that carried a token must never reach this record, because this
    record is what gets written to disk and sent to the vendor.
    """

    tool: str
    arguments: dict[str, Any]
    status: OutcomeStatus
    latency_seconds: float
    message_excerpt: str = ""
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data


@dataclass
class Outcome:
    """The result of asking a backend for one thing.

    ``frames``/``cues`` are only meaningful when ``status`` is OK. The scorer
    checks the status first and refuses to read the payload otherwise, so a
    backend that returned nothing can never be scored as one that returned
    nothing *wrong*.
    """

    status: OutcomeStatus
    frames: list[BackendFrame] = field(default_factory=list)
    cues: list[BackendCue] = field(default_factory=list)
    transcript_source: str | None = None
    provider_job_id: str | None = None
    calls: list[CallRecord] = field(default_factory=list)
    detail: str = ""
    artifacts: dict[str, Any] = field(default_factory=dict)

    @property
    def latency_seconds(self) -> float:
        return round(sum(call.latency_seconds for call in self.calls), 4)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "detail": self.detail,
            "transcript_source": self.transcript_source,
            "provider_job_id": self.provider_job_id,
            "latency_seconds": self.latency_seconds,
            "frames": [f.to_dict() for f in self.frames],
            "cues": [c.to_dict() for c in self.cues],
            "calls": [c.to_dict() for c in self.calls],
            "artifacts": self.artifacts,
        }


@dataclass
class BackendDescription:
    """What is being exercised, recorded so a result can be reproduced.

    ``version`` is the *provider package's* version, which for a stdio MCP
    server is not what the MCP handshake reports — that field carries the
    framework's version. Conflating the two would put the wrong number at the
    top of a report sent to the vendor.
    """

    name: str
    version: str
    version_source: str
    transport: str
    server_name: str | None = None
    server_version: str | None = None
    protocol_version: str | None = None
    tools: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
