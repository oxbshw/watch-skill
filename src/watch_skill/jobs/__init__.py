"""Durable background jobs.

An agent must never sit on a silent multi-minute tool call, and the previous
answer to that — a daemon thread with state in a dict — meant a `job_id` died
with the process and a long transcription could not really be cancelled.

Work now lives in SQLite: submitted with an idempotency key, claimed under a
lease, heartbeated, checkpointed by stage, and recoverable by any process
after a crash. Handlers return a *reference* (a video_id, a session_id), not
an object, because a reference is what still means something tomorrow.

``start_job``/``get_job`` are kept for callers that pass a Python callable.
They run in-process and their results do not survive a restart — the module
says so rather than implying otherwise.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.jobs.registry import (
    JobCancelled,
    JobContext,
    JobHandler,
    LeaseLost,
    get_handler,
    known_kinds,
    load_builtin_handlers,
    register,
)
from watch_skill.jobs.store import (
    JobError,
    claim,
    events,
    fail,
    get,
    heartbeat,
    is_cancel_requested,
    list_jobs,
    prune,
    recover_stale_leases,
    request_cancel,
    submit,
    succeed,
    worker_identity,
)
from watch_skill.jobs.types import (
    JOB_SCHEMA_VERSION,
    ORDERED_STAGES,
    TERMINAL_STATES,
    Job,
    JobEvent,
    JobStage,
    JobState,
)
from watch_skill.jobs.worker import (
    Worker,
    ensure_background_worker,
    run_one,
    stop_background_worker,
)

__all__ = [
    "JOB_SCHEMA_VERSION",
    "ORDERED_STAGES",
    "TERMINAL_STATES",
    "Job",
    "JobCancelled",
    "JobContext",
    "JobError",
    "JobEvent",
    "JobHandler",
    "JobStage",
    "JobState",
    "LeaseLost",
    "LegacyJob",
    "Worker",
    "cancel",
    "claim",
    "ensure_background_worker",
    "events",
    "fail",
    "get",
    "get_handler",
    "get_job",
    "heartbeat",
    "is_cancel_requested",
    "known_kinds",
    "list_jobs",
    "load_builtin_handlers",
    "prune",
    "recover_stale_leases",
    "register",
    "request_cancel",
    "run_one",
    "start_job",
    "stop_background_worker",
    "submit",
    "submit_and_run",
    "succeed",
    "worker_identity",
]


def cancel(job_id: str) -> Job:
    """Ask a job to stop. Queued jobs stop now; running jobs stop at their
    next checkpoint and acknowledge it."""
    return request_cancel(job_id)


def submit_and_run(
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    idempotency_key: str | None = None,
) -> Job:
    """Enqueue durable work and make sure something is draining the queue.

    Surfaces use this so ``background=true`` runs without the operator
    starting a worker by hand. The job is durable either way; the worker is
    just who happens to pick it up.
    """
    job = submit(kind, payload, idempotency_key=idempotency_key)
    ensure_background_worker()
    return job


# --- legacy in-process jobs -------------------------------------------------
#
# Kept because callers pass a closure, which cannot be persisted or resumed.
# These are honest about that: `durable` is False on every one of them.

_MAX_FINISHED_LEGACY = 50


@dataclass
class LegacyJob:
    """An in-process job created from a Python callable.

    Not durable: the result lives in this process's memory and a restart
    loses it. Use :func:`submit` for anything that must survive.
    """

    job_id: str
    kind: str
    status: str = "running"          # running | done | failed
    phase: str = "starting"
    progress: float = 0.0
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    result: Any = None
    error: dict[str, Any] | None = None
    durable: bool = False

    def to_dict(self) -> dict[str, Any]:
        elapsed = (self.finished_at or time.time()) - self.started_at
        return {
            "schema_version": JOB_SCHEMA_VERSION,
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "phase": self.phase,
            "progress": round(self.progress, 3),
            "elapsed_seconds": round(elapsed, 1),
            "durable": self.durable,
            "error": self.error,
        }


_legacy: dict[str, LegacyJob] = {}
_legacy_lock = threading.Lock()


def _prune_legacy_locked() -> None:
    finished = [j for j in _legacy.values() if j.status != "running"]
    finished.sort(key=lambda j: j.finished_at or 0)
    while len(finished) > _MAX_FINISHED_LEGACY:
        _legacy.pop(finished.pop(0).job_id, None)


def start_job(kind: str, work: Callable[[Callable[[str, float], None]], Any]) -> LegacyJob:
    """Run ``work(progress_cb)`` in a daemon thread; returns at once.

    In-process only. Prefer :func:`submit` with a registered handler when the
    work is long enough that surviving a restart matters.
    """
    job = LegacyJob(job_id=uuid.uuid4().hex[:12], kind=kind)
    with _legacy_lock:
        _legacy[job.job_id] = job
        _prune_legacy_locked()

    def progress(phase: str, fraction: float) -> None:
        job.phase = phase
        job.progress = max(0.0, min(1.0, fraction))

    def runner() -> None:
        # ORDER MATTERS: `status` is what pollers wait on, so result/error
        # must be fully populated before status flips away from "running".
        try:
            job.result = work(progress)
            job.phase, job.progress = "finished", 1.0
            job.finished_at = time.time()
            job.status = "done"
        except WatchSkillError as exc:
            job.error = exc.to_dict()
            job.finished_at = time.time()
            job.status = "failed"
        except Exception as exc:  # keep the traceback for the status report
            job.error = {
                "error": "job.crashed",
                "message": str(exc),
                "fix": "report this — unexpected failures should be structured errors",
                "details": {"traceback": traceback.format_exc()[-1500:]},
            }
            job.finished_at = time.time()
            job.status = "failed"

    threading.Thread(target=runner, name=f"watch-skill-{kind}-{job.job_id}",
                     daemon=True).start()
    return job


def get_job(job_id: str) -> LegacyJob:
    """Look up an in-process job; structured error when unknown."""
    with _legacy_lock:
        job = _legacy.get(job_id)
    if job is None:
        raise WatchSkillError(
            f"unknown job_id: {job_id}",
            code="jobs.not_found",
            fix="in-process job ids expire when the server restarts; durable "
            "jobs (`watch-skill jobs list`) do not",
        )
    return job
