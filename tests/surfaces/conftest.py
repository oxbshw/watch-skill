"""Resource assertions around every surface test.

A leaked browser lease does not fail the test that leaked it. It fails the
*next* one, for a reason that has nothing to do with what that test is
checking — which is exactly how a suite comes to look flaky when it is
actually leaking. Asserting at both ends puts the failure on the culprit.
"""
from __future__ import annotations

import pytest


def _lease_state() -> tuple[int, list[str]]:
    from watch_skill.live.browser_pool import get_pool

    report = get_pool().diagnostics()
    return report["active_count"], [a["owner"] for a in report["active"]]


@pytest.fixture(autouse=True)
def no_leaked_browser_leases(request):
    """Zero leases before, zero after. Names the owner when one survives."""
    before, before_owners = _lease_state()
    assert before == 0, (
        f"{request.node.name} started with {before} leaked browser lease(s) "
        f"held by {before_owners} — an earlier test did not release them")

    yield

    after, after_owners = _lease_state()
    if after:
        # Reclaim so the rest of the run is not poisoned, then fail loudly
        # naming who held it. Leaving it would turn one bug into a cascade.
        from watch_skill.live.browser_pool import get_pool

        get_pool().release_all()
        pytest.fail(
            f"{request.node.name} leaked {after} browser lease(s) held by "
            f"{after_owners}; the pool has been reclaimed so later tests are "
            f"not affected, but the lifetime bug is here")
