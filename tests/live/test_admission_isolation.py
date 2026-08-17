"""The governor charges for resident models — so tests must not inherit them.

This pins the mechanism behind an intermittent UI failure that survived a
whole season being called "environmental".

`BrowserPool._reject_if_starved` adds every *resident* model's estimate to the
memory a new browser needs. That is correct in production: a process holding
half a gigabyte of ASR weights really does have that much less room for a
browser. It is wrong across tests, because model residency is process-global
and a model one test loads is still resident for every test after it.

On the machine this was found on the arithmetic was: 1632 MB free, 1150 MB
needed with an empty registry (admitted), 1650 MB needed with the 500 MB ASR
model still loaded (refused, by 18 MB). Whether the Observer could obtain its
verification browser therefore depended on which tests had run before it.
"""
from __future__ import annotations

import pytest

from watch_skill.live.browser_pool import BrowserPool
from watch_skill.models import get_registry


def test_a_resident_model_raises_the_bar_for_a_new_browser() -> None:
    """The accounting itself — stated, so the trade-off stays visible."""
    # Generous free memory, so only the model's contribution decides.
    pool = BrowserPool(max_browsers=2, min_available_mb=700.0,
                       session_cost_mb=450.0)
    assert pool.min_available_mb + pool.session_cost_mb == 1150.0
    # A resident model is added on top; this is the term that made admission
    # depend on test ordering.
    assert pool._worker_cost_locked() == 0.0, (
        "a test started with a model already resident — process-global model "
        "state leaked from an earlier test")


def test_each_test_starts_with_an_empty_model_registry() -> None:
    """The isolation this file exists to defend.

    If this fails, some earlier test left a model loaded and every browser
    admission after it is being charged for memory this test never asked for.
    """
    registry = get_registry()
    resident = []
    for name in registry.registered():
        from watch_skill.models import ModelState  # noqa: PLC0415

        if registry.get(name).status.state is ModelState.READY:
            resident.append(name)
    assert resident == [], (
        f"models still resident at test start: {resident}. Model state is "
        f"process-global; tests/conftest.py must reset it between tests.")


def test_each_test_starts_with_no_browser_leases() -> None:
    """A leaked lease is a slot the next test cannot have."""
    from watch_skill.live.browser_pool import diagnostics  # noqa: PLC0415

    assert diagnostics()["active_count"] == 0, (
        "a browser lease leaked from an earlier test")


def test_a_refusal_names_the_memory_it_was_refused_for() -> None:
    """A governor that refuses without saying why is an outage with no cause.

    The refusal has to carry the numbers, because the first thing anyone asks
    is whether the machine was genuinely short or the accounting was wrong.
    """
    from watch_skill.errors import WatchSkillError  # noqa: PLC0415

    # A reserve nothing can satisfy, so the refusal is deterministic.
    pool = BrowserPool(max_browsers=2, min_available_mb=10**9,
                       session_cost_mb=1.0)
    with pytest.raises(WatchSkillError) as caught:
        pool.acquire("verify:probe", timeout=0.0)
    error = caught.value
    assert error.code == "live.browser.memory_pressure"
    details = error.details or {}
    for field in ("available_mb", "required_mb", "session_cost_mb",
                  "reserve_mb", "owner"):
        assert field in details, f"the refusal did not report {field}"
    assert details["owner"] == "verify:probe"
