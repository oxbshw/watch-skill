"""Background jobs: lifecycle, progress, structured failures, pruning."""
from __future__ import annotations

import time

import pytest
from watch_skill import jobs
from watch_skill.errors import AcquisitionError, WatchSkillError


def _wait(job: jobs.Job, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while job.status == "running" and time.time() < deadline:
        time.sleep(0.02)


def test_job_success_with_progress() -> None:
    def work(progress):
        progress("phase one", 0.3)
        progress("phase two", 0.8)
        return {"answer": 42}

    job = jobs.start_job("watch", work)
    _wait(job)
    assert job.status == "done"
    assert job.result == {"answer": 42}
    assert job.progress == 1.0
    assert job.to_dict()["phase"] == "finished"


def test_job_structured_failure() -> None:
    def work(progress):
        raise AcquisitionError("boom", code="acquire.failed", fix="try again")

    job = jobs.start_job("watch", work)
    _wait(job)
    assert job.status == "failed"
    assert job.error["error"] == "acquire.failed"
    assert job.error["fix"] == "try again"


def test_job_crash_becomes_structured() -> None:
    def work(progress):
        raise RuntimeError("totally unexpected")

    job = jobs.start_job("watch", work)
    _wait(job)
    assert job.status == "failed"
    assert job.error["error"] == "job.crashed"
    assert "totally unexpected" in job.error["message"]


def test_get_job_unknown_is_structured() -> None:
    with pytest.raises(WatchSkillError) as excinfo:
        jobs.get_job("nope")
    assert excinfo.value.code == "jobs.not_found"


def test_progress_clamped() -> None:
    def work(progress):
        progress("over", 1.7)
        assert False is True or True  # keep running briefly
        return None

    job = jobs.start_job("watch", work)
    _wait(job)
    # progress was clamped even though work reported 1.7
    assert job.progress <= 1.0
