"""What a durable job kind is, and how a handler talks to the runtime.

A handler receives a :class:`JobContext` rather than a bare progress
callback. The context is what makes cancellation real: ``ctx.checkpoint()``
both reports progress and raises when a cancel has been requested, so a
handler that calls it between bounded units of work is cancellable without
knowing anything about the queue.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from watch_skill.errors import WatchSkillError
from watch_skill.jobs import store
from watch_skill.jobs.types import Job, JobStage


class JobCancelled(Exception):
    """Raised inside a handler when a cancel has been requested.

    Not a WatchSkillError: a cancellation is an outcome the operator asked
    for, not a failure that needs a `fix` line.
    """


class LeaseLost(Exception):
    """Raised when another worker has taken this job. Stop immediately."""


@dataclass
class JobContext:
    """A handler's window onto the runtime."""

    job: Job
    owner: str
    # The worker's lease length, not the module default. A checkpoint that
    # renewed for 60 s while its worker held a 2 s lease would quietly make
    # the job unrecoverable for a minute after that worker died.
    lease_seconds: float = store.DEFAULT_LEASE_SECONDS
    # Injected so tests can drive checkpointing without a real queue.
    _heartbeat: Callable[..., bool] = store.heartbeat
    _cancel_requested: Callable[[str], bool] = store.is_cancel_requested

    def checkpoint(
        self, stage: JobStage | None = None, progress: float | None = None
    ) -> None:
        """Report progress and honour a cancel. Call it often and cheaply.

        Ordering matters: the cancel check comes first so a handler that is
        told to stop does not first publish a progress update implying it is
        still working.
        """
        if self._cancel_requested(self.job.job_id):
            raise JobCancelled(self.job.job_id)
        if not self._heartbeat(
            self.job.job_id, self.owner, stage=stage, progress=progress,
            lease_seconds=self.lease_seconds,
        ):
            raise LeaseLost(self.job.job_id)

    @property
    def payload(self) -> dict[str, Any]:
        return self.job.payload


class JobHandler(Protocol):
    """Runs one kind of durable job.

    Returns ``(result_ref, result_kind)`` — a pointer that survives a
    restart, never a live object. Returning a ``WatchResult`` would work
    until the process that produced it exits, which is precisely the failure
    the durable runtime exists to remove.
    """

    def __call__(self, ctx: JobContext) -> tuple[str | None, str | None]:
        ...


_HANDLERS: dict[str, JobHandler] = {}


def register(kind: str, handler: JobHandler) -> None:
    _HANDLERS[kind] = handler


def get_handler(kind: str) -> JobHandler:
    if kind not in _HANDLERS:
        raise WatchSkillError(
            f"no handler registered for job kind {kind!r}",
            code="jobs.unknown_kind",
            fix=f"known kinds: {', '.join(sorted(_HANDLERS)) or '(none)'}; a "
            "job submitted by a newer version may need an upgrade",
            details={"kind": kind, "known": sorted(_HANDLERS)},
        )
    return _HANDLERS[kind]


def known_kinds() -> list[str]:
    return sorted(_HANDLERS)


def load_builtin_handlers() -> None:
    """Import the modules that register the shipped job kinds.

    Done lazily and by import side effect so a worker process only pays for
    the heavy pipeline imports when it is actually going to run one.
    """
    from watch_skill.jobs import handlers  # noqa: F401,PLC0415
