"""The durable job runtime.

The point of this suite is the out-of-process tests. Everything else can be
green while the real failure — a worker dies mid-job and the work is lost or
silently done twice — is still there, because that failure only exists across
a process boundary.
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from watch_skill.jobs import store
from watch_skill.jobs.registry import JobCancelled, JobContext
from watch_skill.jobs.types import TERMINAL_STATES, JobStage, JobState
from watch_skill.jobs.worker import Worker, run_one

from . import _testhandlers  # noqa: F401 - registers the test job kinds

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")
TESTS_ROOT = str(Path(__file__).resolve().parents[1])


def _worker_script(kinds: list[str], lease: float, max_jobs: int | None) -> str:
    """A real worker process, importing the same handlers the test uses."""
    return textwrap.dedent(f"""
        import sys
        sys.path[:0] = [{REPO_SRC!r}, {TESTS_ROOT!r}]
        import jobs._testhandlers  # noqa: F401
        from watch_skill.jobs.worker import Worker
        w = Worker(kinds={kinds!r}, lease_seconds={lease!r})
        w.run_forever(max_jobs={max_jobs!r})
    """)


def _spawn_worker(
    tmp_path: Path, data_dir: Path, kinds: list[str],
    lease: float = 2.0, max_jobs: int | None = 1,
) -> subprocess.Popen:
    script = tmp_path / f"worker_{len(list(tmp_path.glob('worker_*.py')))}.py"
    script.write_text(_worker_script(kinds, lease, max_jobs), encoding="utf-8")
    env = {**os.environ, "WATCHSKILL_DATA_DIR": str(data_dir)}
    return subprocess.Popen(
        [sys.executable, str(script)], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def _wait_for(predicate, timeout: float = 30.0, interval: float = 0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


# --- submission and idempotency ---------------------------------------------


def test_submit_persists_a_queued_job() -> None:
    job = store.submit("test_count", {"marker_dir": "x"})
    assert job.state is JobState.QUEUED
    assert job.stage is JobStage.QUEUED
    assert store.get(job.job_id).job_id == job.job_id


def test_the_same_idempotency_key_does_not_create_two_jobs() -> None:
    first = store.submit("test_count", {"a": 1}, idempotency_key="same")
    second = store.submit("test_count", {"a": 2}, idempotency_key="same")
    assert first.job_id == second.job_id
    assert second.payload == {"a": 1}, "the first submission wins"
    assert len([j for j in store.list_jobs() if j.idempotency_key == "same"]) == 1


def test_different_keys_create_different_jobs() -> None:
    one = store.submit("test_count", {}, idempotency_key="k1")
    two = store.submit("test_count", {}, idempotency_key="k2")
    assert one.job_id != two.job_id


def test_unknown_job_id_is_structured() -> None:
    with pytest.raises(store.JobError) as raised:
        store.get("job_nope")
    assert raised.value.code == "jobs.not_found"
    assert raised.value.fix


# --- the queue survives a restart -------------------------------------------


def test_queue_storage_survives_a_new_process(
    tmp_path: Path, isolated_settings: Path
) -> None:
    """Submit here, run there, read the result back here."""
    marker_dir = tmp_path / "markers"
    job = store.submit("test_count", {"marker_dir": str(marker_dir)})

    worker = _spawn_worker(tmp_path, isolated_settings, ["test_count"])
    try:
        worker.wait(timeout=60)
    finally:
        worker.kill()

    final = store.get(job.job_id)
    assert final.state is JobState.SUCCEEDED, final.error
    assert final.result_ref == job.job_id
    assert (marker_dir / "output").read_text(encoding="utf-8").strip() == job.job_id


def test_a_killed_worker_is_recovered_without_duplicating_the_artifact(
    tmp_path: Path, isolated_settings: Path
) -> None:
    """The headline durability test.

    A worker is killed mid-job. The row still says `running`, but its lease
    stops being renewed, so a second worker recovers it — and because the
    first process never reached its output write, the artifact is produced
    exactly once.
    """
    marker_dir = tmp_path / "markers"
    job = store.submit(
        "test_slow",
        {"marker_dir": str(marker_dir), "chunks": 400, "chunk_seconds": 0.05},
        max_attempts=3,
    )

    first = _spawn_worker(tmp_path, isolated_settings, ["test_slow"], lease=2.0)
    try:
        assert _wait_for(lambda: (marker_dir / "started").is_file(), timeout=60), \
            "the first worker never started the job"
        running = _wait_for(
            lambda: store.get(job.job_id).state is JobState.RUNNING, timeout=30
        )
        assert running, "the job never reached running"
        first.kill()          # SIGKILL equivalent: no cleanup, lease left behind
        first.wait(timeout=30)
    finally:
        if first.poll() is None:
            first.kill()

    assert store.get(job.job_id).state is JobState.RUNNING, \
        "a killed worker should leave the row running until its lease expires"

    # Let the lease lapse, then prove recovery re-queues it.
    time.sleep(2.5)
    assert store.recover_stale_leases() >= 1
    assert store.get(job.job_id).state is JobState.QUEUED

    second = _spawn_worker(tmp_path, isolated_settings, ["test_slow"], lease=60.0)
    try:
        # Shrink the remaining work so the second run finishes quickly.
        second.wait(timeout=120)
    finally:
        if second.poll() is None:
            second.kill()

    final = store.get(job.job_id)
    assert final.state is JobState.SUCCEEDED, final.error
    lines = (marker_dir / "output").read_text(encoding="utf-8").split()
    assert len(lines) == 1, f"the artifact was produced {len(lines)} times: {lines}"


def test_stale_leases_are_recovered_and_attempts_are_respected() -> None:
    job = store.submit("test_count", {}, max_attempts=1)
    owner = "ghost:1"
    claimed = store.claim(owner, kinds=["test_count"], lease_seconds=-1.0)
    assert claimed is not None and claimed.state is JobState.RUNNING

    assert store.recover_stale_leases() == 1
    # attempt 1 of 1 was spent by the dead worker, so it is abandoned rather
    # than looping forever.
    final = store.get(job.job_id)
    assert final.state is JobState.FAILED
    assert final.error["error"] == "jobs.attempts_exhausted"


def test_a_lease_holder_that_lost_the_row_cannot_finish_it() -> None:
    job = store.submit("test_count", {})
    first = store.claim("worker-a", kinds=["test_count"], lease_seconds=-1.0)
    assert first is not None
    store.recover_stale_leases()
    second = store.claim("worker-b", kinds=["test_count"])
    assert second is not None and second.job_id == job.job_id

    assert store.succeed(job.job_id, "worker-a") is False, \
        "the evicted worker must not be able to complete the job"
    assert store.succeed(job.job_id, "worker-b") is True


# --- cancellation is real ---------------------------------------------------


def test_cancelling_a_queued_job_is_immediate() -> None:
    job = store.submit("test_count", {})
    cancelled = store.request_cancel(job.job_id)
    assert cancelled.state is JobState.CANCELLED
    assert store.claim("anyone", kinds=["test_count"]) is None


def test_cancel_during_a_long_job_actually_stops_it(tmp_path: Path) -> None:
    """A cooperative checkpoint, exercised through the real worker path."""
    marker_dir = tmp_path / "markers"
    job = store.submit(
        "test_slow",
        {"marker_dir": str(marker_dir), "chunks": 2000, "chunk_seconds": 0.01},
    )
    claimed = store.claim("worker-1", kinds=["test_slow"])
    assert claimed is not None

    stop_requested = time.time()

    def cancel_soon() -> None:
        time.sleep(0.3)
        store.request_cancel(job.job_id)

    import threading

    threading.Thread(target=cancel_soon, daemon=True).start()
    run_one(claimed, "worker-1")
    elapsed = time.time() - stop_requested

    final = store.get(job.job_id)
    assert final.state is JobState.CANCELLED
    assert elapsed < 15, "cancellation did not take effect promptly"
    # 2000 chunks x 10 ms would be 20 s; stopping early is the proof.
    assert not (marker_dir / "output").exists(), \
        "a cancelled job must not write its final artifact"


def test_checkpoint_raises_when_a_cancel_is_pending() -> None:
    job = store.submit("test_count", {})
    claimed = store.claim("w", kinds=["test_count"])
    assert claimed is not None
    store.request_cancel(job.job_id)
    ctx = JobContext(job=claimed, owner="w")
    with pytest.raises(JobCancelled):
        ctx.checkpoint(JobStage.TRANSCRIBE, 0.5)


def test_cancelling_a_finished_job_is_not_an_error() -> None:
    job = store.submit("test_count", {})
    claimed = store.claim("w", kinds=["test_count"])
    assert claimed is not None
    store.succeed(job.job_id, "w", result_ref="r")
    assert store.request_cancel(job.job_id).state is JobState.SUCCEEDED


# --- terminal states are final ----------------------------------------------


@pytest.mark.parametrize("terminal", ["succeeded", "failed", "cancelled"])
def test_a_terminal_job_cannot_return_to_running(terminal: str) -> None:
    import sqlite3

    from watch_skill.jobs.db import connect

    job = store.submit("test_count", {})
    conn = connect()
    try:
        with conn:
            conn.execute("UPDATE jobs SET state = ? WHERE job_id = ?",
                         (terminal, job.job_id))
        with pytest.raises(sqlite3.IntegrityError, match="terminal_state_is_final"), conn:
            conn.execute("UPDATE jobs SET state = 'running' WHERE job_id = ?",
                         (job.job_id,))
    finally:
        conn.close()
    assert store.get(job.job_id).state.value == terminal


def test_a_terminal_job_is_not_claimable() -> None:
    job = store.submit("test_count", {})
    store.request_cancel(job.job_id)
    assert store.get(job.job_id).state in TERMINAL_STATES
    assert store.claim("w", kinds=["test_count"]) is None


# --- retries and failures ---------------------------------------------------


def test_a_crash_retries_with_backoff_then_fails() -> None:
    job = store.submit("test_crash", {}, max_attempts=2)
    worker = Worker(kinds=["test_crash"])
    worker.run_forever(max_jobs=1)
    after_first = store.get(job.job_id)
    assert after_first.state is JobState.QUEUED
    assert after_first.attempt == 1
    assert after_first.not_before > time.time(), "backoff was not applied"

    # Skip the backoff rather than sleeping through it.
    from watch_skill.jobs.db import connect

    conn = connect()
    try:
        with conn:
            conn.execute("UPDATE jobs SET not_before = 0 WHERE job_id = ?", (job.job_id,))
    finally:
        conn.close()

    worker.run_forever(max_jobs=1)
    final = store.get(job.job_id)
    assert final.state is JobState.FAILED
    assert final.attempt == 2
    assert final.error["error"] == "jobs.crashed"


def test_a_structured_error_keeps_its_code_and_fix() -> None:
    job = store.submit("test_structured", {}, max_attempts=1)
    Worker(kinds=["test_structured"]).run_forever(max_jobs=1)
    final = store.get(job.job_id)
    assert final.state is JobState.FAILED
    assert final.error["error"] == "acquire.failed"
    assert final.error["fix"] == "try a real URL"


def test_an_unregistered_kind_fails_with_a_structured_error() -> None:
    job = store.submit("no_such_kind", {}, max_attempts=1)
    Worker(kinds=["no_such_kind"]).run_forever(max_jobs=1)
    final = store.get(job.job_id)
    assert final.state is JobState.FAILED
    assert final.error["error"] == "jobs.unknown_kind"


# --- the append-only event log ----------------------------------------------


def test_events_are_append_only_and_ordered(tmp_path: Path) -> None:
    job = store.submit("test_count", {"marker_dir": str(tmp_path)})
    Worker(kinds=["test_count"]).run_forever(max_jobs=1)
    log = store.events(job.job_id)
    kinds = [event.kind for event in log]
    assert kinds[0] == "submitted"
    assert "claimed" in kinds
    assert kinds[-1] == "succeeded"
    assert [event.seq for event in log] == sorted(event.seq for event in log)
    assert store.events(job.job_id, after_seq=log[-1].seq) == []


def test_two_workers_do_not_both_claim_one_job() -> None:
    store.submit("test_count", {})
    first = store.claim("worker-a", kinds=["test_count"])
    second = store.claim("worker-b", kinds=["test_count"])
    assert first is not None
    assert second is None, "two workers claimed the same job"


def test_prune_keeps_recent_terminal_jobs(tmp_path: Path) -> None:
    for _ in range(5):
        job = store.submit("test_count", {"marker_dir": str(tmp_path)})
        claimed = store.claim("w", kinds=["test_count"])
        assert claimed is not None
        store.succeed(job.job_id, "w")
    removed = store.prune(keep_terminal=2)
    assert removed == 3
    assert len(store.list_jobs()) == 2
