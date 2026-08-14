"""Typed, versioned contracts for the job runtime.

Everything persisted or returned across a surface carries
``schema_version``. A reader that finds a version it does not know can say
so instead of guessing at the shape, which is the difference between a
forward-compatible client and a mysterious KeyError.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

JOB_SCHEMA_VERSION = 1


class JobState(str, Enum):  # noqa: UP042 — matches SourceKind
    """Where a job is. Only the last three are terminal."""

    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    """A cancel was requested and the worker has not acknowledged it yet.
    Distinct from CANCELLED because a request is not an outcome — the worker
    may still finish first, and reporting a cancel that did not happen would
    be worse than reporting the delay."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATES = frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED})


class JobStage(str, Enum):  # noqa: UP042 — matches SourceKind
    """The pipeline stages a long operation moves through.

    Named rather than free-text so progress means the same thing to a CLI, an
    MCP client, and a restart-recovery decision about where to resume.
    """

    QUEUED = "queued"
    ACQUIRE = "acquire"
    PROBE = "probe"
    CAPTURE = "capture"
    SEGMENT = "segment"
    FRAMES = "frames"
    OCR = "ocr"
    AUDIO = "audio"
    TRANSCRIBE = "transcribe"
    EMBED = "embed"
    FUSE_EVENTS = "fuse-events"
    FINALIZE = "finalize"
    VERIFY = "verify"
    DONE = "done"


ORDERED_STAGES: tuple[JobStage, ...] = (
    JobStage.QUEUED, JobStage.ACQUIRE, JobStage.PROBE, JobStage.CAPTURE,
    JobStage.SEGMENT, JobStage.FRAMES, JobStage.OCR, JobStage.AUDIO,
    JobStage.TRANSCRIBE, JobStage.EMBED, JobStage.FUSE_EVENTS,
    JobStage.FINALIZE, JobStage.VERIFY, JobStage.DONE,
)


class JobEvent(BaseModel):
    """One append-only fact about a job. Never updated, only added."""

    schema_version: int = JOB_SCHEMA_VERSION
    job_id: str
    seq: int
    at: float
    kind: str  # submitted | claimed | stage | progress | heartbeat | ...
    stage: str | None = None
    progress: float | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class Job(BaseModel):
    """A durable unit of work and everything observable about it."""

    schema_version: int = JOB_SCHEMA_VERSION
    job_id: str
    kind: str
    state: JobState = JobState.QUEUED
    stage: JobStage = JobStage.QUEUED
    progress: float = 0.0
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None
    # A pointer, not the thing. A video_id or a run_id survives a restart;
    # a WatchResult object does not, and pretending otherwise is how the
    # in-memory version lost work.
    result_ref: str | None = None
    result_kind: str | None = None
    error: dict[str, Any] | None = None
    attempt: int = 0
    max_attempts: int = 3
    cancel_requested: bool = False
    lease_owner: str | None = None
    lease_expires_at: float | None = None
    heartbeat_at: float | None = None
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    not_before: float = 0.0

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def elapsed_seconds(self) -> float:
        return round((self.finished_at or time.time()) - self.created_at, 2)

    def to_dict(self) -> dict[str, Any]:
        """The public shape. Lease internals stay out of it — they are the
        runtime's business, not the caller's."""
        return {
            "schema_version": self.schema_version,
            "job_id": self.job_id,
            "kind": self.kind,
            "state": self.state.value,
            "stage": self.stage.value,
            "progress": round(self.progress, 3),
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "cancel_requested": self.cancel_requested,
            "elapsed_seconds": self.elapsed_seconds,
            "result_ref": self.result_ref,
            "result_kind": self.result_kind,
            "error": self.error,
        }
