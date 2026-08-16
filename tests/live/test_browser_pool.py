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


def test_an_unmeasurable_machine_does_not_block_every_browser(monkeypatch) -> None:
    """Pressure that cannot be measured is not reported as pressure.

    The check has to fail *open* here, and say so: refusing every browser on
    a platform whose free memory we cannot read would make the product
    unusable there, and claiming plenty of memory would be a safety property
    we never verified. Measuring nothing means the limit is the count alone.
    """
    monkeypatch.setattr(pool, "available_memory_mb", lambda: None)
    budget = BrowserPool(max_browsers=1, min_available_mb=10**9)
    lease = budget.acquire("unmeasurable", timeout=0.5)
    assert lease is not None
    budget.release(lease)


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
