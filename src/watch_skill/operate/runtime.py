"""The browser runtime: run a task, prove what happened, hand back receipts.

Built on top of the existing `BrowserSource` rather than beside it. That
matters more than it might sound: the source already owns the navigation
policy, the resource lease, the per-session profile, the navigation epochs and
the frame capture that Observer mode depends on. A second browser stack for
operating would have meant two lease accountings, two policies and two sets of
evidence that could disagree — so this drives the same page, on the same
thread, through the same command queue.

The consequence is that Watch Skill has one browser subsystem with two modes:

    operator  — Watch performs the task and proves its own work
    observer  — Watch watches someone else and proves theirs

They share perception, evidence, policy and governance. Only the question
differs.
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.operate import recover
from watch_skill.operate.execute import ConsoleLog, NetworkLog, perform
from watch_skill.operate.observe import BrowserObservation, observe
from watch_skill.operate.types import (
    Action,
    ActionReceipt,
    TaskResult,
    TaskStatus,
    Verdict,
)


class OperateError(WatchSkillError):
    """The browser could not be driven."""

    default_code = "operate.failed"


class BrowserRuntime:
    """Drives one live browser session as an operator.

    Wraps a `BrowserSource` that is already running. Every page interaction
    goes through `source.call`, which marshals it onto the browser thread —
    Playwright's sync objects belong to one thread, and this is how the
    capture loop and the operator share a page without a lock.
    """

    def __init__(self, source: Any, run_id: str = "",
                 session_id: str = "") -> None:
        self.source = source
        self.run_id = run_id or f"op_{uuid.uuid4().hex[:12]}"
        self.session_id = session_id or getattr(source, "session_id", "")
        self.receipts: list[ActionReceipt] = []
        self._network = NetworkLog()
        self._console = ConsoleLog()
        self._wired = False
        self._sequence = 0

    # --- lifecycle ---------------------------------------------------------

    def _wire(self) -> None:
        """Attach the per-step logs once, lazily.

        The source has its own listeners for session evidence; these are
        separate and narrower, existing only to correlate requests and console
        errors with the action that was running at the time.
        """
        if self._wired:
            return

        def attach(page: Any) -> None:
            self._network.attach(page)
            self._console.attach(page)

        self.source.call(attach)
        self._wired = True

    def close(self) -> None:
        if not self._wired:
            return

        def detach(page: Any) -> None:
            self._network.detach(page)
            self._console.detach(page)

        try:
            self.source.call(detach, timeout=5.0)
        except Exception:  # noqa: BLE001 - a closed browser needs no detach
            pass
        self._wired = False

    # --- perception --------------------------------------------------------

    def observe(self) -> BrowserObservation:
        """A bounded snapshot of the current browser state."""
        self._wire()
        epoch = int(getattr(self.source, "_navigation_epoch", 0))
        return self.source.call(lambda page: observe(page, epoch))

    # --- execution ---------------------------------------------------------

    def act(self, action: Action) -> ActionReceipt:
        """Perform one action, with bounded recovery, and record a receipt.

        The recovery loop lives here rather than inside `perform` so that
        every attempt produces its own receipt. A run that succeeded on the
        second try is a different thing from one that succeeded first time,
        and flattening them would erase the most interesting part of the
        record.
        """
        self._wire()
        epoch = int(getattr(self.source, "_navigation_epoch", 0))
        attempt = 1
        recovered_from = None
        trail: list[str] = []

        while True:
            self._sequence += 1
            sequence = self._sequence
            receipt: ActionReceipt = self.source.call(
                lambda page, a=action, s=sequence: perform(
                    page, a, self._network, self._console, epoch, s),
                timeout=action.timeout_seconds + 30.0,
            )
            receipt.run_id = self.run_id
            receipt.session_id = self.session_id
            receipt.attempt = attempt
            receipt.recovered_from = recovered_from
            receipt.evidence.extend(trail)
            self.receipts.append(receipt)

            if receipt.verdict in (Verdict.SUCCEEDED, Verdict.UNVERIFIED):
                return receipt

            move = recover.plan(receipt, attempt, action.retry_safe)
            if move is None:
                receipt.reason = (
                    f"{receipt.reason} "
                    f"({recover.describe_refusal(receipt, action.retry_safe, attempt)})"
                ).strip()
                return receipt

            note = self.source.call(move.apply, timeout=30.0)
            recovered_from = receipt.failure
            attempt += 1
            # Carried forward, not appended to the receipt being left behind.
            # The recovery is the reason the *next* attempt succeeds, so
            # recording it on the failed one would leave the successful
            # receipt looking as though it simply worked first time.
            receipt.evidence.append(f"recovery[{move.name}]: {note}")
            trail.append(f"recovery[{move.name}] after "
                         f"{receipt.failure.value}: {note}")

    # --- tasks -------------------------------------------------------------

    def run_task(self, goal: str, actions: list[Action]) -> TaskResult:
        """Run a planned sequence and return a structured verdict.

        The plan is supplied rather than invented here. Choosing *what* to do
        is a judgement a caller — a person, a script, or a model — is entitled
        to make; deciding whether it worked is not, and that is the half this
        runtime owns.

        The task stops at the first failed step. Continuing past a step that
        did not do what it claimed means every later step is operating on a
        page that is not the one the plan assumed.
        """
        result = TaskResult(run_id=self.run_id, session_id=self.session_id,
                            goal=goal)
        try:
            for action in actions:
                receipt = self.act(action)
                if receipt.verdict is Verdict.REFUSED:
                    result.status = TaskStatus.REFUSED
                    result.failure_reason = receipt.reason
                    break
                if receipt.verdict is Verdict.FAILED:
                    result.status = TaskStatus.FAILED
                    result.failure_reason = (
                        f"step {receipt.sequence} ({receipt.kind.value}) "
                        f"failed: {receipt.reason}")
                    break
            else:
                result.status = TaskStatus.COMPLETED
        except WatchSkillError as exc:
            result.status = TaskStatus.FAILED
            result.failure_reason = str(exc)

        result.receipts = list(self.receipts)
        # Verified means every step stated an expectation and met it. A run of
        # UNVERIFIED steps completed without proving anything, and saying so is
        # the whole reason this field is separate from `status`.
        result.verified = (
            result.status is TaskStatus.COMPLETED
            and bool(result.receipts)
            and all(r.verdict is Verdict.SUCCEEDED for r in result.receipts)
        )

        try:
            final = self.observe()
            result.final_url, result.final_title = final.url, final.title
        except Exception:  # noqa: BLE001 - a closed browser has no final state
            pass
        result.finished_wall_ts = time.time()
        return result


__all__ = ["BrowserRuntime", "OperateError"]
