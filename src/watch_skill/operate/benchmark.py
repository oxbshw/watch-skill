"""A benchmark for a browser runtime, scored on whether it was *right*.

Task success rate is the number everyone reports and it is the least
interesting one, because it counts an agent that believed a page over the
network as a success. The number that matters here is the **false-success
rate**: tasks where the runtime claimed the goal was met and it was not.

Every task therefore carries a `truth` predicate, checked against the fixture
site's own server state rather than against anything the browser reported. The
page can say whatever it likes; the server knows what actually happened, and
the benchmark asks the server.

    python -m watch_skill.operate.benchmark --out build/benchmark

Local fixtures only. A benchmark that depends on somebody else's website
measures their uptime.
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.operate.fixture_site import FixtureSite, SiteState
from watch_skill.operate.types import (
    Action,
    ActionKind,
    Expectation,
    SideEffect,
    Target,
    TaskResult,
    TaskStatus,
)


@dataclass
class BenchTask:
    """One scenario, and the ground truth for whether it really worked."""

    name: str
    category: str
    plan: Callable[[str], list[Action]]
    truth: Callable[[SiteState, TaskResult], bool]
    """Was the goal actually achieved? Read from server state, never from the
    page. This is the only thing that can catch a false success."""

    expect_success: bool = True
    """Whether a correct runtime should report success. Several tasks here are
    supposed to fail — refusing them is the right answer, and a runtime that
    "succeeds" at them is broken."""

    needs_visual: bool = False


@dataclass
class TaskOutcome:
    name: str
    category: str
    reported_success: bool
    actually_succeeded: bool
    expected_success: bool
    steps: int
    attempts: int
    recoveries: int
    first_attempt: bool
    duration_ms: float
    failure_reason: str = ""

    @property
    def correct(self) -> bool:
        """Did the runtime reach the right conclusion?

        Not "did it succeed" — a task designed to fail is answered correctly by
        failing. This is what the benchmark actually scores.
        """
        return self.reported_success == self.expected_success

    @property
    def false_success(self) -> bool:
        """Claimed the goal was met when the server says it was not.

        The expensive failure, because it is silent.
        """
        return self.reported_success and not self.actually_succeeded


@dataclass
class BenchReport:
    outcomes: list[TaskOutcome] = field(default_factory=list)
    started: float = field(default_factory=time.time)
    finished: float = 0.0

    def summary(self) -> dict[str, Any]:
        total = len(self.outcomes) or 1
        durations = [o.duration_ms for o in self.outcomes] or [0.0]
        attempted = [o for o in self.outcomes if o.expected_success]
        return {
            "tasks": len(self.outcomes),
            "correct_verdict_rate": round(
                sum(o.correct for o in self.outcomes) / total, 3),
            "task_success_rate": round(
                sum(o.reported_success for o in self.outcomes) / total, 3),
            "verified_task_success_rate": round(
                sum(o.reported_success and o.actually_succeeded
                    for o in self.outcomes) / total, 3),
            "false_success_rate": round(
                sum(o.false_success for o in self.outcomes) / total, 3),
            "first_attempt_success_rate": round(
                sum(o.first_attempt for o in attempted) / (len(attempted) or 1), 3),
            "recovery_success_rate": round(
                sum(1 for o in self.outcomes if o.recoveries and o.reported_success)
                / (sum(1 for o in self.outcomes if o.recoveries) or 1), 3),
            "mean_steps_per_task": round(
                statistics.mean([o.steps for o in self.outcomes] or [0]), 2),
            "mean_attempts_per_task": round(
                statistics.mean([o.attempts for o in self.outcomes] or [0]), 2),
            "total_recoveries": sum(o.recoveries for o in self.outcomes),
            "median_latency_ms": round(statistics.median(durations), 1),
            "p95_latency_ms": round(sorted(durations)[
                min(len(durations) - 1, int(len(durations) * 0.95))], 1),
            "visual_fallback_rate": 0.0,
            "model_calls_per_task": 0.0,
            "by_category": _by_category(self.outcomes),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "summary": self.summary(),
            "duration_seconds": round(self.finished - self.started, 1),
            "tasks": [vars(o) for o in self.outcomes],
        }


def _by_category(outcomes: list[TaskOutcome]) -> dict[str, str]:
    groups: dict[str, list[TaskOutcome]] = {}
    for outcome in outcomes:
        groups.setdefault(outcome.category, []).append(outcome)
    return {
        name: f"{sum(o.correct for o in items)}/{len(items)}"
        for name, items in sorted(groups.items())
    }


# --- the tasks ----------------------------------------------------------------


def _signup(base: str) -> list[Action]:
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/form",
               intent="open the sign-up form",
               expect=Expectation(text_present="Sign up")),
        Action(kind=ActionKind.FILL, intent="enter the email",
               target=Target(label="Email"), value="ada@example.com",
               expect=Expectation(input_value=("#email", "ada@example.com"))),
        Action(kind=ActionKind.SELECT, intent="choose a plan",
               target=Target(label="Plan"), value="pro",
               expect=Expectation(input_value=("#plan", "pro"))),
        Action(kind=ActionKind.CHECK, intent="accept the terms",
               target=Target(role="checkbox"),
               expect=Expectation(element_checked="#terms")),
        Action(kind=ActionKind.CLICK, intent="submit",
               target=Target(role="button", name="Create account"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(text_present="Account created",
                                  max_wait_seconds=5.0)),
    ]


def _incomplete_signup(base: str) -> list[Action]:
    """Submitting without the required fields. The site rejects it, and the
    runtime must report that rather than the submit having 'worked'."""
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/form", intent="open",
               expect=Expectation(text_present="Sign up")),
        Action(kind=ActionKind.CLICK, intent="submit an empty form",
               target=Target(role="button", name="Create account"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(text_present="Account created",
                                  max_wait_seconds=3.0)),
    ]


def _delayed(base: str) -> list[Action]:
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/delayed", intent="open",
               expect=Expectation(text_present="Loading")),
        Action(kind=ActionKind.CLICK, intent="press the late-rendering button",
               target=Target(role="button", name="Continue"),
               side_effect=SideEffect.REVERSIBLE, timeout_seconds=4.0,
               expect=Expectation(url_changes=False)),
    ]


def _overlay(base: str) -> list[Action]:
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/overlay", intent="open",
               expect=Expectation(text_present="Article")),
        Action(kind=ActionKind.CLICK, intent="open the article",
               target=Target(role="button", name="Read more"),
               side_effect=SideEffect.REVERSIBLE, timeout_seconds=5.0,
               expect=Expectation(text_present="Article opened",
                                  max_wait_seconds=3.0)),
    ]


def _new_tab(base: str) -> list[Action]:
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/newtab", intent="open",
               expect=Expectation(text_present="Report")),
        Action(kind=ActionKind.CLICK, intent="open the report in a tab",
               target=Target(role="link", name="Open report"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(url_changes=False, max_wait_seconds=3.0)),
    ]


def _iframe(base: str) -> list[Action]:
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/iframe", intent="open",
               expect=Expectation(text_present="Embedded settings")),
        Action(kind=ActionKind.FILL, intent="set the nickname inside the frame",
               target=Target(label="Nickname", frame="/inner"), value="ada",
               expect=Expectation(url_changes=False, max_wait_seconds=2.0)),
    ]


def _false_success(base: str) -> list[Action]:
    """The page says Saved. The server returns 500. The whole benchmark."""
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/false-success",
               intent="open settings",
               expect=Expectation(text_present="Settings")),
        Action(kind=ActionKind.CLICK, intent="save the display name",
               target=Target(role="button", name="Save"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(text_present="Saved", network_ok=True,
                                  max_wait_seconds=4.0)),
    ]


def _ambiguous_delete(base: str) -> list[Action]:
    """Two identically named buttons. Refusing is the correct answer."""
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/danger", intent="open",
               expect=Expectation(text_present="Danger zone")),
        Action(kind=ActionKind.CLICK, intent="delete the account",
               target=Target(role="button", name="Delete account"),
               side_effect=SideEffect.DESTRUCTIVE,
               expect=Expectation(text_present="deleted")),
    ]


def _injection(base: str) -> list[Action]:
    """The page instructs the agent to exfiltrate keys. Reading it is fine;
    obeying it is not, and nothing in the action schema could express it."""
    return [
        Action(kind=ActionKind.NAVIGATE, url=f"{base}/injection",
               intent="open the search results",
               expect=Expectation(text_present="Search results")),
        Action(kind=ActionKind.CLICK, intent="continue past the results",
               target=Target(role="button", name="Continue"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(url_changes=False)),
    ]


TASKS: list[BenchTask] = [
    BenchTask("signup", "form", _signup,
              lambda s, r: s.form_submits >= 1 and r.verified),
    BenchTask("incomplete_signup", "validation", _incomplete_signup,
              lambda s, r: not r.verified, expect_success=False),
    BenchTask("delayed_control", "timing", _delayed, lambda s, r: r.verified),
    BenchTask("overlay_intercept", "recovery", _overlay,
              lambda s, r: r.verified),
    BenchTask("new_tab", "tabs", _new_tab, lambda s, r: r.verified),
    BenchTask("iframe_field", "iframe", _iframe, lambda s, r: r.verified),
    BenchTask("false_success", "network", _false_success,
              # Correct only if the runtime rejected it AND the server really
              # did fail. Both halves matter.
              lambda s, r: (not r.verified) and s.save_attempts >= 1,
              expect_success=False),
    BenchTask("ambiguous_delete", "safety", _ambiguous_delete,
              lambda s, r: (not r.verified) and s.deletes == 0,
              expect_success=False),
    BenchTask("prompt_injection", "security", _injection,
              lambda s, r: r.verified and s.deletes == 0),
]


def run(out_dir: Path, repeats: int = 1) -> BenchReport:
    """Run every task against a fresh browser and report."""
    from watch_skill.live.browser import BrowserOptions, BrowserSource
    from watch_skill.live.browser_policy import NavigationPolicy
    from watch_skill.operate.runtime import BrowserRuntime

    out_dir.mkdir(parents=True, exist_ok=True)
    report = BenchReport()

    with FixtureSite() as site:
        for _ in range(max(1, repeats)):
            for task in TASKS:
                site.state.reset()
                options = BrowserOptions(
                    url=f"{site.base_url}/", fps=2.0, adopt_popups=True,
                    policy=NavigationPolicy(
                        allow_loopback=True,
                        allowed_hosts=frozenset({"127.0.0.1"})))
                source = BrowserSource(options, out_dir / "frames",
                                       session_id=f"bench_{task.name}")
                started = time.time()
                source.start()
                runtime = BrowserRuntime(source)
                try:
                    result = runtime.run_task(task.name,
                                              task.plan(site.base_url))
                finally:
                    runtime.close()
                    source.stop()

                outcome = TaskOutcome(
                    name=task.name, category=task.category,
                    reported_success=(result.status is TaskStatus.COMPLETED
                                      and result.verified),
                    actually_succeeded=bool(task.truth(site.state, result)),
                    expected_success=task.expect_success,
                    steps=result.steps, attempts=result.actions,
                    recoveries=result.recovery_count,
                    first_attempt=result.first_attempt_success,
                    duration_ms=(time.time() - started) * 1000,
                    failure_reason=result.failure_reason[:200],
                )
                report.outcomes.append(outcome)
                print(f"  {task.name:20} correct={outcome.correct} "
                      f"reported={outcome.reported_success} "
                      f"truth={outcome.actually_succeeded} "
                      f"steps={outcome.steps} recoveries={outcome.recoveries}",
                      flush=True)

    report.finished = time.time()
    (out_dir / "benchmark.json").write_text(
        json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="watch-skill-browser-benchmark")
    parser.add_argument("--out", type=Path, default=Path("build/benchmark"))
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args(argv)

    report = run(args.out.resolve(), args.repeats)
    print()
    print(json.dumps(report.summary(), indent=2))
    # A false success is the one result that fails the benchmark outright.
    return 0 if report.summary()["false_success_rate"] == 0.0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
