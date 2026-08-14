"""The worker loop: claim, run, heartbeat, finish.

Runs in-process (a background thread the MCP server starts) or as its own
process via ``python -m watch_skill.jobs.worker``. Both use the same loop, so
the out-of-process path is the tested one rather than a second implementation
that drifts.
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading
import time
import traceback
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.jobs import store
from watch_skill.jobs.registry import (
    JobCancelled,
    JobContext,
    LeaseLost,
    get_handler,
    load_builtin_handlers,
)
from watch_skill.jobs.types import JobStage

POLL_SECONDS = 0.25
HEARTBEAT_SECONDS = 15.0


def run_one(
    job: Any, owner: str, lease_seconds: float = store.DEFAULT_LEASE_SECONDS
) -> None:
    """Execute one claimed job to a terminal state.

    A heartbeat thread runs alongside the handler so a long stage that never
    reaches a checkpoint still holds its lease. Without it, a slow ffmpeg call
    would look exactly like a dead worker and get re-queued underneath itself.
    """
    stop_beating = threading.Event()

    def beat() -> None:
        while not stop_beating.wait(min(HEARTBEAT_SECONDS, lease_seconds / 3)):
            store.heartbeat(job.job_id, owner, lease_seconds=lease_seconds)

    beater = threading.Thread(target=beat, name=f"ws-heartbeat-{job.job_id}", daemon=True)
    beater.start()
    ctx = JobContext(job=job, owner=owner, lease_seconds=lease_seconds)
    try:
        handler = get_handler(job.kind)
        result_ref, result_kind = handler(ctx)
        store.succeed(job.job_id, owner, result_ref=result_ref, result_kind=result_kind)
    except JobCancelled:
        store.cancelled(job.job_id, owner)
    except LeaseLost:
        return  # another worker owns it; touching the row now would be the bug
    except WatchSkillError as exc:
        store.fail(job.job_id, owner, exc.to_dict())
    except Exception as exc:  # noqa: BLE001 - a crash is a structured failure here
        store.fail(job.job_id, owner, {
            "error": "jobs.crashed",
            "message": str(exc),
            "fix": "report this — unexpected failures should be structured errors",
            "details": {"traceback": traceback.format_exc()[-1500:]},
        })
    finally:
        stop_beating.set()


class Worker:
    """A claim loop. Stop it by setting ``stop_event``."""

    def __init__(
        self,
        kinds: list[str] | None = None,
        owner: str | None = None,
        stop_event: threading.Event | None = None,
        lease_seconds: float = store.DEFAULT_LEASE_SECONDS,
    ) -> None:
        self.kinds = kinds
        self.owner = owner or store.worker_identity()
        self.stop_event = stop_event or threading.Event()
        self.lease_seconds = lease_seconds
        self.completed = 0

    def run_forever(self, max_jobs: int | None = None, idle_exit: bool = False) -> int:
        load_builtin_handlers()
        while not self.stop_event.is_set():
            job = store.claim(self.owner, kinds=self.kinds,
                              lease_seconds=self.lease_seconds)
            if job is None:
                if idle_exit:
                    return self.completed
                if self.stop_event.wait(POLL_SECONDS):
                    return self.completed
                continue
            run_one(job, self.owner, lease_seconds=self.lease_seconds)
            self.completed += 1
            if max_jobs is not None and self.completed >= max_jobs:
                return self.completed
        return self.completed


_background: Worker | None = None
_background_thread: threading.Thread | None = None
_lock = threading.Lock()


def ensure_background_worker(kinds: list[str] | None = None) -> Worker:
    """Start one in-process worker, idempotently.

    Surfaces call this so `background=true` actually runs something without
    the operator having to start a separate process. It is a convenience, not
    the durability story — the durability comes from the queue, which any
    process can drain.
    """
    global _background, _background_thread
    with _lock:
        if _background is not None and _background_thread is not None \
                and _background_thread.is_alive():
            return _background
        _background = Worker(kinds=kinds)
        _background_thread = threading.Thread(
            target=_background.run_forever, name="watch-skill-worker", daemon=True
        )
        _background_thread.start()
        return _background


def stop_background_worker(timeout: float = 5.0) -> None:
    global _background, _background_thread
    with _lock:
        if _background is not None:
            _background.stop_event.set()
        if _background_thread is not None:
            _background_thread.join(timeout=timeout)
        _background, _background_thread = None, None


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - process entry
    parser = argparse.ArgumentParser(prog="watch-skill-worker")
    parser.add_argument("--kinds", nargs="*", default=None)
    parser.add_argument("--max-jobs", type=int, default=None)
    parser.add_argument("--idle-exit", action="store_true",
                        help="Exit when the queue is empty instead of polling.")
    args = parser.parse_args(argv)

    worker = Worker(kinds=args.kinds)

    def handle_signal(signum: int, _frame: Any) -> None:
        worker.stop_event.set()

    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), handle_signal)

    started = time.time()
    completed = worker.run_forever(max_jobs=args.max_jobs, idle_exit=args.idle_exit)
    print(f"worker {worker.owner} ran {completed} job(s) in "
          f"{time.time() - started:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entry
    raise SystemExit(main())


__all__ = [
    "HEARTBEAT_SECONDS",
    "JobStage",
    "Worker",
    "ensure_background_worker",
    "run_one",
    "stop_background_worker",
]
