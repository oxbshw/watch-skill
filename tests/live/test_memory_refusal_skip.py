"""A governor refusal that arrives mid-test is a resource skip, not a pass.

`require_verification_browser` checks whether the machine can afford a browser
before the scenario starts. The governor checks again, for real, when the
browser starts. Both read machine-wide free memory, and that number moves --
measured at up to 336 MB in one second and 546 MB in three during a run of
`tests/live` and `tests/observer`. So the precondition can pass and the
acquisition still be refused, which is how a full suite failed on run 1 and
passed on run 2 with nothing changed.

These tests pin the two halves of the answer: the refusal that means "this
machine is busy" is skipped with the governor's own numbers, and the refusal
that means "a browser now costs far more than the governor is configured for"
is still a failure. A regression hiding behind a resource skip would be worse
than the flake it replaces.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from tests.conftest import _memory_refusal_skip_reason

from watch_skill.live.browser_pool import BrowserUnavailable, get_pool

REPO_ROOT = Path(__file__).resolve().parents[2]


def _refusal(**details: object) -> BrowserUnavailable:
    pool = get_pool()
    base: dict[str, object] = {
        "available_mb": 1086.0,
        "required_mb": pool.session_cost_mb + pool.min_available_mb,
        "session_cost_mb": pool.session_cost_mb,
        "reserve_mb": pool.min_available_mb,
        "owner": "live:test",
        "active": [],
    }
    base.update(details)
    return BrowserUnavailable(
        f"{base['available_mb']} MB is free; this session needs about "
        f"{base['session_cost_mb']} MB and {base['reserve_mb']} MB must "
        f"remain for everything else",
        code="live.browser.memory_pressure", details=base)


def test_a_busy_machine_is_a_skip_carrying_the_governors_numbers() -> None:
    reason = _memory_refusal_skip_reason(_refusal())
    assert reason is not None
    assert "1086" in reason, "the skip must repeat what was actually free"
    assert "resource skip, not a pass" in reason


def test_a_browser_that_costs_far_more_than_configured_still_fails() -> None:
    """The guard that stops a regression from hiding behind a resource skip."""
    pool = get_pool()
    ruinous = (pool.session_cost_mb + pool.min_available_mb) * 2.0 + 1.0
    assert _memory_refusal_skip_reason(_refusal(required_mb=ruinous)) is None


def test_the_boundary_is_inclusive() -> None:
    pool = get_pool()
    at_limit = (pool.session_cost_mb + pool.min_available_mb) * 2.0
    assert _memory_refusal_skip_reason(_refusal(required_mb=at_limit)) is not None


def test_any_other_browser_failure_is_untouched() -> None:
    other = BrowserUnavailable("no lease", code="live.browser.resource_limit")
    assert _memory_refusal_skip_reason(other) is None
    assert _memory_refusal_skip_reason(RuntimeError("boom")) is None


def test_a_refusal_with_no_arithmetic_is_not_silently_skipped() -> None:
    """Without `required_mb` there is nothing to check the claim against."""
    naked = BrowserUnavailable("refused", code="live.browser.memory_pressure")
    assert _memory_refusal_skip_reason(naked) is None


BODIES = {
    "body": "def test_refused():\n    _refuse()\n",
    "setup": (
        "@pytest.fixture\ndef refusing():\n    _refuse()\n\n"
        "def test_refused(refusing):\n    pass\n"
    ),
}


@pytest.mark.parametrize("phase", list(BODIES))
@pytest.mark.parametrize(
    ("required_factor", "outcome"),
    [(1.0, "skipped"), (3.0, "failed")],
    ids=["busy-machine", "ruinous-cost"])
def test_the_hook_is_wired_to_both_setup_and_call(
    tmp_path: Path, phase: str, required_factor: float, outcome: str
) -> None:
    """End to end, in a real pytest process.

    The decision function above is unit-tested; this proves it is actually
    reached -- once from a fixture and once from a test body -- because a hook
    that is defined but not registered would leave every one of these tests
    passing while the suite kept failing.

    pytest reports a refusal raised in setup as an *error* rather than a
    failure, which is why the two phases do not share an expected string.
    """
    pool = get_pool()
    required = (pool.session_cost_mb + pool.min_available_mb) * required_factor
    generated = tmp_path / "test_generated_refusal.py"
    generated.write_text(
        textwrap.dedent(f"""
        import pytest
        from watch_skill.live.browser_pool import BrowserUnavailable

        DETAILS = {{"available_mb": 1086.0, "required_mb": {required!r},
                    "session_cost_mb": {pool.session_cost_mb!r},
                    "reserve_mb": {pool.min_available_mb!r}}}

        def _refuse():
            raise BrowserUnavailable(
                "refused", code="live.browser.memory_pressure", details=DETAILS)

        """) + BODIES[phase],
        encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "tests.conftest",
         "-p", "no:cacheprovider", "-q", "--no-header", str(generated)],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=300)

    wanted = "1 error" if (phase == "setup" and outcome == "failed") \
        else f"1 {outcome}"
    assert wanted in result.stdout, (
        f"expected {wanted!r} from a refusal raised in {phase}, got:\n"
        f"{result.stdout[-2000:]}")
