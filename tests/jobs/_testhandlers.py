"""Job handlers used by the durable-jobs tests, importable from a subprocess.

A separate module because the out-of-process tests spawn a real worker that
has to import these by name — a handler defined inside a test function only
exists in the test's own interpreter, which would make "out of process" a
fiction.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from watch_skill.jobs.registry import JobContext, register
from watch_skill.jobs.types import JobStage


def _marker(ctx: JobContext, name: str) -> Path:
    path = Path(ctx.payload["marker_dir"]) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def slow_job(ctx: JobContext) -> tuple[str | None, str | None]:
    """Announces that it started, then works in checkpointed chunks.

    The `started` marker is what lets a test kill the worker at a known point
    rather than guessing at a sleep duration.
    """
    _marker(ctx, "started").write_text(str(os.getpid()), encoding="utf-8")
    chunks = int(ctx.payload.get("chunks", 40))
    for i in range(chunks):
        ctx.checkpoint(JobStage.TRANSCRIBE, (i + 1) / chunks)
        time.sleep(float(ctx.payload.get("chunk_seconds", 0.05)))
    output = _marker(ctx, "output")
    # Append, so a job that ran twice is visibly different from one that ran
    # once — this is the duplicate-artifact check.
    with output.open("a", encoding="utf-8") as handle:
        handle.write(f"{ctx.job.job_id}\n")
    return "done", "marker"


def counting_job(ctx: JobContext) -> tuple[str | None, str | None]:
    """Appends one line per completed run. Fast."""
    output = _marker(ctx, "output")
    with output.open("a", encoding="utf-8") as handle:
        handle.write(f"{ctx.job.job_id}\n")
    return ctx.job.job_id, "marker"


def always_crashes(ctx: JobContext) -> tuple[str | None, str | None]:
    raise RuntimeError("this handler always crashes")


def structured_failure(ctx: JobContext) -> tuple[str | None, str | None]:
    from watch_skill.errors import AcquisitionError

    raise AcquisitionError("nope", code="acquire.failed", fix="try a real URL")


def register_all() -> None:
    register("test_slow", slow_job)
    register("test_count", counting_job)
    register("test_crash", always_crashes)
    register("test_structured", structured_failure)


register_all()
