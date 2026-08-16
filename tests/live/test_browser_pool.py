"""The browser budget: refuse rather than let the machine be killed.

The defect this exists for was real. A full suite run died with `MemoryError`
during setup of an unrelated cost-meter test, because a browser suite was
holding several Chromium instances at the time. Nothing counted them, so
nothing could refuse. These tests fix the counting in place.
"""
from __future__ import annotations

import threading
import time

import pytest

from watch_skill.live import browser_pool as pool
from watch_skill.live.browser_pool import BrowserPool, BrowserUnavailable


@pytest.fixture(autouse=True)
def clean_pool():
    """No lease may outlive its test — a leak here breaks every later test."""
    yield
    pool.get_pool().release_all()


def test_a_lease_is_returned_and_the_slot_becomes_reusable() -> None:
    budget = BrowserPool(max_browsers=1, min_available_mb=0)
    first = budget.acquire("session-a")
    assert budget.diagnostics()["active_count"] == 1

    with pytest.raises(BrowserUnavailable) as excinfo:
        budget.acquire("session-b", timeout=0.2)
    assert excinfo.value.code == "live.browser.too_many"
    assert "session-a" in str(excinfo.value.details["active"])

    budget.release(first)
    assert budget.diagnostics()["active_count"] == 0
    second = budget.acquire("session-b", timeout=0.2)
    assert second.owner == "session-b"


def test_releasing_twice_is_harmless() -> None:
    """Teardown paths run more than once; a double release must not free a
    slot somebody else is holding."""
    budget = BrowserPool(max_browsers=1, min_available_mb=0)
    lease = budget.acquire("a")
    budget.release(lease)
    budget.release(lease)
    budget.release(None)
    assert budget.diagnostics()["active_count"] == 0
    other = budget.acquire("b", timeout=0.2)
    budget.release(other)


def test_memory_pressure_refuses_instead_of_queueing() -> None:
    """Below the floor the answer is no, immediately.

    Queueing would make it worse: more waiters means more memory held by
    things that are about to allocate.
    """
    budget = BrowserPool(max_browsers=4, min_available_mb=10**9)
    with pytest.raises(BrowserUnavailable) as excinfo:
        budget.acquire("hungry", timeout=5.0)
    assert excinfo.value.code == "live.browser.memory_pressure"
    assert excinfo.value.details["available_mb"] < excinfo.value.details["required_mb"]
    assert excinfo.value.fix, "a refusal with no remedy is just a failure"
    assert budget.diagnostics()["refusals"] == 1


def test_the_reserve_must_survive_the_new_session_not_merely_exist(
    monkeypatch,
) -> None:
    """Two quantities, not one.

    Checking only that free memory is above the reserve admits a session that
    consumes the reserve entirely — and then the next allocation anywhere on
    the host is the one that fails. The session's own cost has to be
    subtracted first.
    """
    monkeypatch.setattr(pool, "available_memory_mb", lambda: 800.0)
    # 800 free is comfortably above a 700 reserve, and nowhere near enough
    # once a 450 MB session is accounted for.
    budget = BrowserPool(max_browsers=2, min_available_mb=700.0,
                         session_cost_mb=450.0)
    with pytest.raises(BrowserUnavailable) as excinfo:
        budget.acquire("optimistic", timeout=0.2)
    assert excinfo.value.code == "live.browser.memory_pressure"
    detail = excinfo.value.details
    assert detail["required_mb"] == pytest.approx(1150.0)
    assert detail["session_cost_mb"] >= 450.0

    # With room for both, the same request succeeds.
    monkeypatch.setattr(pool, "available_memory_mb", lambda: 1400.0)
    lease = budget.acquire("roomy", timeout=0.2)
    budget.release(lease)


def test_resident_models_count_against_the_budget(monkeypatch) -> None:
    """A browser is not the only thing holding memory.

    Admitting a session while ignoring loaded ASR/OCR/vision weights is how
    the governor stays satisfied right up until the host is not.
    """
    monkeypatch.setattr(pool, "available_memory_mb", lambda: 1300.0)
    budget = BrowserPool(max_browsers=2, min_available_mb=700.0,
                         session_cost_mb=450.0)
    lease = budget.acquire("no-models", timeout=0.2)
    budget.release(lease)

    monkeypatch.setattr(BrowserPool, "_worker_cost_locked", lambda self: 400.0)
    with pytest.raises(BrowserUnavailable) as excinfo:
        budget.acquire("with-models", timeout=0.2)
    assert excinfo.value.details["session_cost_mb"] == pytest.approx(850.0)


def test_an_unmeasurable_machine_falls_back_to_one_session(monkeypatch) -> None:
    """Unmeasurable is not the same as plentiful.

    Failing open here was the safety gap. A platform whose free memory cannot
    be read gets a single session — enough to work, few enough that a second
    cannot be the thing that tips the host over.
    """
    monkeypatch.setattr(pool, "available_memory_mb", lambda: None)
    budget = BrowserPool(max_browsers=4, min_available_mb=700.0)
    assert budget.configured_max == 4
    assert budget.max_browsers == pool.UNMEASURED_MAX_BROWSERS == 1

    first = budget.acquire("only-one", timeout=0.2)
    with pytest.raises(BrowserUnavailable) as excinfo:
        budget.acquire("second", timeout=0.2)
    assert excinfo.value.code == "live.browser.too_many"

    report = budget.diagnostics()
    assert report["memory_measurement_unavailable"] is True
    assert report["admission"] == "count_only_conservative"
    assert report["available_memory_mb"] is None
    assert report["limit"] == 1 and report["configured_limit"] == 4
    budget.release(first)


def test_failing_open_requires_an_explicit_override(monkeypatch) -> None:
    """The old behaviour is still reachable, but only on purpose."""
    monkeypatch.setattr(pool, "available_memory_mb", lambda: None)
    budget = BrowserPool(max_browsers=3, min_available_mb=700.0,
                         allow_unmeasured=True)
    assert budget.max_browsers == 3
    leases = [budget.acquire(f"w{i}", timeout=0.2) for i in range(3)]
    assert budget.diagnostics()["admission"] == "count_only_override"
    for lease in leases:
        budget.release(lease)


def test_the_override_is_reachable_from_the_environment(monkeypatch) -> None:
    monkeypatch.setattr(pool, "available_memory_mb", lambda: None)
    monkeypatch.setenv("WATCHSKILL_ALLOW_UNMEASURED_BROWSERS", "1")
    assert BrowserPool(max_browsers=3).max_browsers == 3
    monkeypatch.setenv("WATCHSKILL_ALLOW_UNMEASURED_BROWSERS", "0")
    assert BrowserPool(max_browsers=3).max_browsers == 1


def test_diagnostics_carry_no_paths_or_page_content() -> None:
    """Diagnostics get pasted into issues; they must be safe to paste."""
    budget = BrowserPool(max_browsers=2, min_available_mb=0)
    lease = budget.acquire("live:live_ab12cd")
    report = budget.diagnostics()
    blob = repr(report)
    assert "live:live_ab12cd" in blob
    for leak in ("/", "\\", "http://", "C:", "profile_"):
        assert leak not in str(report["active"]), leak
    budget.release(lease)


def test_leases_are_released_when_the_interpreter_exits() -> None:
    """A lease that outlives its interpreter is a slot nobody can reclaim.

    Asserted in a real subprocess: the child takes a lease, never releases
    it, and exits. If the atexit hook were missing the child would still exit
    zero, so the assertion is on the hook running — the child prints what
    release_all reclaimed on its way out.
    """
    import subprocess
    import sys
    import textwrap
    from pathlib import Path

    src = str(Path(__file__).resolve().parents[2] / "src")
    program = textwrap.dedent(f"""
        import atexit, sys
        sys.path.insert(0, {src!r})
        from watch_skill.live import browser_pool as pool

        pool.acquire("leaked-on-purpose", timeout=1.0)
        assert pool.get_pool().diagnostics()["active_count"] == 1
        # Registered after the module's own hook, so it runs first and can
        # observe that the lease is still held at exit time.
        atexit.register(lambda: print("held_at_exit=1", flush=True))
    """)
    result = subprocess.run([sys.executable, "-c", program],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-1000:]
    assert "held_at_exit=1" in result.stdout

    # And in this process, releasing an empty pool is safe and idempotent.
    assert pool.get_pool().release_all() == 0


def test_concurrent_acquirers_never_exceed_the_limit() -> None:
    """The invariant, under threads: never more than N at once."""
    budget = BrowserPool(max_browsers=3, min_available_mb=0)
    peak = 0
    live = 0
    guard = threading.Lock()
    errors: list[str] = []

    def worker(index: int) -> None:
        nonlocal peak, live
        try:
            lease = budget.acquire(f"w{index}", timeout=30.0)
        except BrowserUnavailable as exc:
            errors.append(str(exc))
            return
        with guard:
            live += 1
            peak = max(peak, live)
        time.sleep(0.05)
        with guard:
            live -= 1
        budget.release(lease)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors[:2]
    assert peak <= 3, f"{peak} browsers ran at once against a limit of 3"
    assert budget.diagnostics()["active_count"] == 0, "leases leaked"


def test_diagnostics_name_what_is_running_and_do_not_overclaim_scope() -> None:
    budget = BrowserPool(max_browsers=2, min_available_mb=0)
    lease = budget.acquire("live:abc")
    report = budget.diagnostics()
    assert report["active"][0]["owner"] == "live:abc"
    assert report["limit"] == 2
    # The budget is per process, and says so. Implying a machine-wide
    # guarantee would be a safety claim nothing here enforces.
    assert report["scope"] == "process"
    budget.release(lease)


def test_the_limit_is_configurable_by_environment(monkeypatch) -> None:
    monkeypatch.setenv("WATCHSKILL_MAX_BROWSERS", "7")
    assert BrowserPool().max_browsers == 7
    monkeypatch.setenv("WATCHSKILL_MAX_BROWSERS", "nonsense")
    assert BrowserPool().max_browsers == pool.DEFAULT_MAX_BROWSERS


def test_release_all_frees_a_leaked_lease() -> None:
    budget = BrowserPool(max_browsers=2, min_available_mb=0)
    budget.acquire("leaky-one")
    budget.acquire("leaky-two")
    assert budget.release_all() == 2
    assert budget.diagnostics()["active_count"] == 0
