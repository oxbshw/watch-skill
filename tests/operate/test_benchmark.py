"""The benchmark's own guarantees, checked without launching nine browsers.

The full benchmark takes a couple of minutes and lives behind
`python -m watch_skill.operate.benchmark`. What the suite needs to hold onto
is cheaper and more important: that the scoring is honest.

A benchmark that scores itself wrongly is worse than none, because it produces
a number people quote. So the arithmetic is pinned here — particularly the
false-success rate, which is the one metric that would be embarrassing to get
backwards.
"""
from __future__ import annotations

from watch_skill.operate.benchmark import TASKS, BenchReport, TaskOutcome


def _outcome(**kwargs) -> TaskOutcome:
    base = dict(
        name="t", category="c", reported_success=True, actually_succeeded=True,
        expected_success=True, steps=1, attempts=1, recoveries=0,
        first_attempt=True, duration_ms=100.0,
    )
    base.update(kwargs)
    return TaskOutcome(**base)  # type: ignore[arg-type]


def test_a_claimed_success_the_server_denies_is_a_false_success() -> None:
    """The definition the whole benchmark turns on."""
    outcome = _outcome(reported_success=True, actually_succeeded=False)
    assert outcome.false_success is True


def test_a_task_that_was_supposed_to_fail_is_correct_when_it_fails() -> None:
    """Several scenarios here are meant to be refused. Refusing them is the
    right answer, and scoring them as failures would punish the runtime for
    behaving correctly."""
    outcome = _outcome(reported_success=False, actually_succeeded=True,
                       expected_success=False)
    assert outcome.correct is True
    assert outcome.false_success is False


def test_a_refused_task_is_never_counted_as_a_false_success() -> None:
    outcome = _outcome(reported_success=False, actually_succeeded=False)
    assert outcome.false_success is False


def test_the_summary_reports_the_false_success_rate_separately(
) -> None:
    """It must not be folded into the success rate, which is exactly the
    trick that lets an unreliable agent look good."""
    report = BenchReport()
    report.outcomes = [
        _outcome(name="honest", reported_success=True, actually_succeeded=True),
        _outcome(name="lied", reported_success=True, actually_succeeded=False),
    ]
    summary = report.summary()

    assert summary["task_success_rate"] == 1.0
    assert summary["verified_task_success_rate"] == 0.5
    assert summary["false_success_rate"] == 0.5


def test_every_task_declares_ground_truth_independent_of_the_page() -> None:
    """A truth predicate that read the browser's own report would be circular.

    Each one takes the fixture site's server state, which is the only witness
    the page cannot influence.
    """
    for task in TASKS:
        assert callable(task.truth), task.name
        assert task.category, f"{task.name} has no category"


def test_the_suite_covers_the_failure_modes_that_break_browser_agents() -> None:
    categories = {task.category for task in TASKS}
    for required in ("network", "recovery", "safety", "security", "iframe",
                     "tabs", "timing", "validation", "form"):
        assert required in categories, f"no task covers {required}"


def test_tasks_that_must_be_refused_are_marked_as_such() -> None:
    """If these were marked as expected successes, a runtime that clicked an
    ambiguous "Delete account" would score better than one that refused."""
    refusals = {task.name for task in TASKS if not task.expect_success}
    assert "false_success" in refusals
    assert "ambiguous_delete" in refusals
