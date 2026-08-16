"""Where a contract's checks actually run.

Two backends ship. :class:`InProcessVerifier` runs checks in the calling
process and is honest about being worth :attr:`Assurance.DETERMINISTIC_LOCAL`.
:class:`LocalIsolatedVerifier` runs them in a separate process with a
sanitized environment and bounded roots, which is worth
:attr:`Assurance.ISOLATED_LOCAL`.

Neither is worth ``remote_attested``, and there is deliberately no third
backend pretending otherwise: a verifier running as the same OS user as the
agent it is judging can be interfered with by that agent, and calling that
"independent" would be the most dangerous claim in this system. The
:class:`Verifier` protocol is the extension point for a real remote verifier —
authenticated, replay-resistant, on another machine — if one is ever built.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Protocol

from watch_skill.errors import WatchSkillError
from watch_skill.verify.checks import (
    CheckContext,
    CheckResult,
    _sanitized_env,
    run_check,
)
from watch_skill.verify.contract import Assurance, Check, CheckStatus


class VerifierError(WatchSkillError):
    """The verifier itself failed (as opposed to a check failing)."""

    default_code = "verify.backend_failed"


class Verifier(Protocol):
    """A place checks can be executed."""

    assurance: Assurance

    def run(self, checks: list[Check], ctx: CheckContext) -> list[CheckResult]:
        ...


class InProcessVerifier:
    """Runs checks here. Simple, and no stronger than the process it runs in."""

    assurance = Assurance.DETERMINISTIC_LOCAL

    def run(self, checks: list[Check], ctx: CheckContext) -> list[CheckResult]:
        return [run_check(check, ctx) for check in checks]


class LocalIsolatedVerifier:
    """Runs checks in a separate process with a stripped environment.

    What this buys: the checks cannot read the parent's provider keys, cannot
    corrupt its interpreter state, and cannot outlive their deadline. What it
    does NOT buy: independence from an agent running as the same user, which
    is why the assurance stops at ``isolated_local``.
    """

    assurance = Assurance.ISOLATED_LOCAL

    def __init__(self, timeout_seconds: float = 300.0) -> None:
        self.timeout_seconds = timeout_seconds

    def run(self, checks: list[Check], ctx: CheckContext) -> list[CheckResult]:
        if not checks:
            return []
        job = json.dumps({
            "context": ctx.model_dump(mode="json"),
            "checks": [check.model_dump(mode="json") for check in checks],
        })
        # Sum of the per-check budgets, so one slow check cannot be masked by
        # a generous overall deadline and vice versa.
        deadline = min(
            self.timeout_seconds,
            sum(check.timeout_seconds for check in checks) + 30.0,
        )
        # The verifier subprocess may launch its own Chromium — a `browser_dom`
        # check opens a browser to read the page. The pool is per process, so
        # that instance was invisible to the parent's budget: the parent
        # believed one browser was running while two existed. Under a live
        # session plus a verification that is already the ceiling, and the
        # third Chromium is what pushed the machine over.
        #
        # The parent holds the lease on the child's behalf for the lifetime of
        # the subprocess. Accounting for a browser we cause but do not own is
        # the honest reading of a budget; raising the limit so the arithmetic
        # stops complaining would only move the failure to the OS.
        lease = None
        if any(check.type.startswith("browser_") for check in checks):
            from watch_skill.live import browser_pool as pool  # noqa: PLC0415

            lease = pool.acquire("verifier:isolated", timeout=deadline)
        try:
            completed = subprocess.run(  # noqa: S603 - argv list, shell=False
                [sys.executable, "-m", "watch_skill.verify.worker"],
                input=job,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=deadline,
                cwd=ctx.working_dir,
                env={**_sanitized_env(), "PYTHONPATH": _package_root()},
            )
        except subprocess.TimeoutExpired:
            return [
                _inconclusive(check, f"the verifier exceeded its {deadline:.0f}s deadline")
                for check in checks
            ]
        finally:
            # Released whether the child succeeded, failed, or timed out. A
            # lease that survives a timeout is the one that makes the *next*
            # run fail, which is how a single slow verification turns into a
            # suite that degrades run after run.
            if lease is not None:
                from watch_skill.live import browser_pool as pool  # noqa: PLC0415

                pool.release(lease)

        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            # The worker died without producing results. Every check is
            # unknown — not passed, and not failed either.
            return [
                _inconclusive(
                    check,
                    "the verifier process produced no results "
                    f"(exit {completed.returncode}): {completed.stderr[-300:]}",
                )
                for check in checks
            ]
        if not payload.get("ok"):
            raise VerifierError(
                f"verifier rejected the job: {payload.get('error')}",
                code="verify.backend_rejected",
                fix="report this — the contract was serialized in a form the "
                "verifier could not read",
                details={"stderr": completed.stderr[-500:]},
            )
        return [CheckResult.model_validate(item) for item in payload["results"]]


def _package_root() -> str:
    """The src root, so the child imports the SAME code the parent is running."""
    return str(Path(__file__).resolve().parents[2])


def _inconclusive(check: Check, reason: str) -> CheckResult:
    return CheckResult(
        check_id=check.id, type=check.type, required=check.required,
        status=CheckStatus.INCONCLUSIVE, summary=reason,
        error={"code": "verify.backend_unavailable", "message": reason},
        tool={"runner": "watch-skill", "version": "1"},
    )


def get_verifier(isolated: bool = True) -> Verifier:
    """The backend a run should use. Isolated unless explicitly opted out."""
    return LocalIsolatedVerifier() if isolated else InProcessVerifier()
