"""Lightweight background jobs for long operations (watch on a long video).

An agent must never sit on a silent multi-minute tool call. Surfaces that
support MCP progress notifications stream phase updates; clients that don't
can start a job (fast ack with a job_id) and poll ``get_status``.

Threads, not processes: the pipeline is I/O- and subprocess-bound, results
stay in memory, and one process owns the SQLite index.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from agentvision.errors import AgentVisionError

_MAX_FINISHED_JOBS = 50


@dataclass
class Job:
    """One background operation and everything observable about it."""

    job_id: str
    kind: str                       # e.g. "watch"
    status: str = "running"         # running | done | failed
    phase: str = "starting"
    progress: float = 0.0           # 0..1
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    result: Any = None              # set when done
    error: dict[str, Any] | None = None  # structured, set when failed

    def to_dict(self) -> dict[str, Any]:
        elapsed = (self.finished_at or time.time()) - self.started_at
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "phase": self.phase,
            "progress": round(self.progress, 3),
            "elapsed_seconds": round(elapsed, 1),
            "error": self.error,
        }


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def _prune_locked() -> None:
    finished = [j for j in _jobs.values() if j.status != "running"]
    finished.sort(key=lambda j: j.finished_at or 0)
    while len(finished) > _MAX_FINISHED_JOBS:
        dead = finished.pop(0)
        _jobs.pop(dead.job_id, None)


def start_job(kind: str, work: Callable[[Callable[[str, float], None]], Any]) -> Job:
    """Run ``work(progress_cb)`` in a daemon thread; returns the Job at once.

    ``work`` receives a ``progress(phase, fraction)`` callback and its return
    value becomes ``job.result``.
    """
    job = Job(job_id=uuid.uuid4().hex[:12], kind=kind)
    with _lock:
        _jobs[job.job_id] = job
        _prune_locked()

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
        except AgentVisionError as exc:
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

    threading.Thread(target=runner, name=f"agentvision-{kind}-{job.job_id}", daemon=True).start()
    return job


def get_job(job_id: str) -> Job:
    """Look up a job; structured error when unknown."""
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise AgentVisionError(
            f"unknown job_id: {job_id}",
            code="jobs.not_found",
            fix="job ids expire when the server restarts; start the operation again",
        )
    return job
