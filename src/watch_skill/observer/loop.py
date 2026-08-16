"""The Observer Loop: declare success, observe, act, and let someone else judge.

The order of operations is the product. A loop that verifies with the same
process that acted, or that writes its postcondition after seeing the result,
is a loop that always succeeds — and a loop that always succeeds tells you
nothing. So:

1. the postcondition is **frozen before the run exists**, and its digest is
   copied onto the run so a later edit is detectable;
2. verification happens in a **separate process** through the existing
   isolated verifier, against targets named in the contract;
3. a correction is a **typed, declarative** spec, approved by a human as a
   specific effect, spent once;
4. the loop **stops and waits** for that approval rather than proceeding;
5. every ceiling ends the run in ``exhausted`` — which is not ``verified``,
   and is not ``failed`` either.

The video a session records is human evidence: it shows what happened and is
what someone reviews. It is never the stop condition. The oracle is.
"""
from __future__ import annotations

import hashlib
import time
import uuid
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.observer import db
from watch_skill.observer.types import (
    Budgets,
    CorrectionSpec,
    ObserverRun,
    ObserverState,
    VerificationAttempt,
)
from watch_skill.verify import verify_run
from watch_skill.verify.contract import CheckStatus, VerificationContract


class ObserverError(WatchSkillError):
    """The loop could not be created or advanced."""

    default_code = "observer.failed"


def start_run(
    *,
    contract: VerificationContract,
    working_dir: str | Path,
    correction: CorrectionSpec | None = None,
    budgets: Budgets | None = None,
    allowed_origins: list[str] | None = None,
    allowed_roots: list[str] | None = None,
    session_id: str | None = None,
) -> ObserverRun:
    """Create a run around an already-frozen postcondition.

    Refusing an unfrozen contract here is the single most important line in
    this module. An unfrozen contract can be edited after the work is done,
    and a target that moves after the shot is not a target.
    """
    if not contract.frozen:
        raise ObserverError(
            "the postcondition must be frozen before the run starts",
            code="observer.postcondition_not_frozen",
            fix="call contract.freeze() first — declaring success after "
                "seeing the result is not verification",
            details={"contract_id": contract.contract_id},
        )
    contract.verify_integrity()
    budgets = budgets or Budgets()
    work = Path(working_dir).resolve()
    run = ObserverRun(
        run_id=f"obs_{uuid.uuid4().hex[:12]}",
        contract_id=contract.contract_id,
        contract_digest=contract.digest or "",
        state=ObserverState.OBSERVING,
        budgets=budgets,
        correction=correction,
        session_id=session_id,
        working_dir=str(work),
        allowed_origins=list(allowed_origins or []),
        allowed_roots=[str(Path(r).resolve()) for r in (allowed_roots or [work])],
        deadline_at=time.time() + budgets.deadline_seconds,
    )
    return db.insert_run(run)


def advance(run_id: str, contract: VerificationContract) -> ObserverRun:
    """Take the run as far as it can go without a human.

    Returns as soon as it needs something only a person can give — which in
    practice means an approval — or when it reaches a terminal state. Calling
    it again after the approval resumes from exactly where it stopped.
    """
    run = _load(run_id)
    _assert_same_contract(run, contract)

    while True:
        if run.finished or run.waiting:
            return run
        exceeded = _budget_exceeded(run)
        if exceeded:
            return _finish(run, ObserverState.EXHAUSTED, exceeded)

        if run.state in (ObserverState.OBSERVING, ObserverState.RETRYING,
                         ObserverState.CREATED):
            run = _verify(run, contract)
            continue
        if run.state is ObserverState.VERIFICATION_FAILED:
            run = _propose_correction(run)
            continue
        if run.state is ObserverState.CORRECTION_PROPOSED:
            run = _apply_correction(run)
            continue
        # Any other state is one this driver does not own — a caller moved it,
        # or a newer version wrote it. Stopping is the honest response.
        return run


# --- steps -------------------------------------------------------------------


def _verify(run: ObserverRun, contract: VerificationContract) -> ObserverRun:
    """Ask the independent oracle, in its own process, and believe only it."""
    run.iteration += 1
    run.spend.iterations = run.iteration
    run.spend.verification_attempts += 1
    run.state = ObserverState.VERIFICATION_PENDING
    db.save_run(run)

    try:
        bundle, _attestation = verify_run(
            contract,
            working_dir=run.working_dir,
            allowed_roots=run.allowed_roots,
            allowed_origins=run.allowed_origins,
            isolated=True,
            loop_id=run.run_id,
            iteration=run.iteration,
        )
    except WatchSkillError as exc:
        run.spend.consecutive_unavailable_oracle += 1
        run.attempts.append(VerificationAttempt(
            iteration=run.iteration, run_id="", verdict="unavailable",
            failure_signature="oracle_unavailable", unavailable=True))
        if (run.spend.consecutive_unavailable_oracle
                >= run.budgets.max_consecutive_unavailable_oracle):
            # Fail closed. An oracle nobody can reach has not said yes.
            return _finish(run, ObserverState.FAILED,
                           f"the verifier was unavailable "
                           f"{run.spend.consecutive_unavailable_oracle} times "
                           f"in a row: {exc.message}", error=exc.to_dict())
        run.state = ObserverState.RETRYING
        return db.save_run(run)

    run.spend.consecutive_unavailable_oracle = 0
    verdict = bundle.verdict.value if hasattr(bundle.verdict, "value") \
        else str(bundle.verdict)
    signature = _failure_signature(bundle)
    run.attempts.append(VerificationAttempt(
        iteration=run.iteration, run_id=bundle.run_id, verdict=verdict,
        assurance=(bundle.assurance.value if hasattr(bundle.assurance, "value")
                   else str(bundle.assurance)),
        failure_signature=signature))

    if verdict == "pass":
        return _finish(run, ObserverState.VERIFIED,
                       f"postcondition met, verified by {bundle.run_id}")

    if signature:
        seen = run.spend.failure_signatures.get(signature, 0) + 1
        run.spend.failure_signatures[signature] = seen
        if seen > run.budgets.max_repeated_failure_signature:
            return _finish(
                run, ObserverState.EXHAUSTED,
                f"the same failure recurred {seen} times; a correction that "
                f"produces an identical failure will not produce a different "
                f"one next time")

    run.state = ObserverState.VERIFICATION_FAILED
    return db.save_run(run)


def _propose_correction(run: ObserverRun) -> ObserverRun:
    """Raise a correction, and stop if it needs a human."""
    from watch_skill.actions.runner import propose, request_approval_for

    if run.correction is None:
        return _finish(run, ObserverState.EXHAUSTED,
                       "the postcondition is not met and no correction was "
                       "declared for this run")

    inputs = dict(run.correction.inputs)
    inputs.setdefault("allowed_origins", run.allowed_origins)
    # One key per run and iteration, so a redelivered advance() proposes the
    # same action rather than a second one.
    key = f"{run.run_id}:{run.iteration}"
    action = propose(
        kind=run.correction.kind,
        inputs=inputs,
        summary=run.correction.summary or f"correction for {run.contract_id}",
        proposed_by=f"observer:{run.run_id}",
        idempotency_key=key,
        requires_approval=run.correction.requires_approval,
        session_id=run.session_id,
        loop_id=run.run_id,
    )
    run.action_id = action.action_id
    run.spend.tool_calls += 1

    if not run.correction.requires_approval:
        run.state = ObserverState.CORRECTION_PROPOSED
        return db.save_run(run)

    approval = request_approval_for(action)
    run.approval_id = approval.approval_id
    run.state = ObserverState.AWAITING_APPROVAL
    run.stop_reason = (
        f"waiting for a human to approve: {run.correction.summary}")
    return db.save_run(run)


def _apply_correction(run: ObserverRun) -> ObserverRun:
    """Perform the approved effect, then go back and observe again."""
    from watch_skill.actions.runner import perform
    from watch_skill.actions.types import ActionState

    if run.action_id is None:  # pragma: no cover - guarded by the caller
        return _finish(run, ObserverState.FAILED, "no correction to apply")

    run.state = ObserverState.ACTING
    db.save_run(run)
    try:
        action = perform(run.action_id, approval_id=run.approval_id,
                         actor=f"observer:{run.run_id}")
    except WatchSkillError as exc:
        return _finish(run, ObserverState.FAILED,
                       f"the approved correction could not be applied: "
                       f"{exc.message}", error=exc.to_dict())

    run.spend.tool_calls += 1
    if action.state is not ActionState.SUCCEEDED:
        # A correction that failed is not a reason to stop — the next
        # iteration re-verifies and may propose again — but it is a reason to
        # record why, so a human reading the run sees the attempt.
        run.spend.failure_signatures["correction_failed"] = (
            run.spend.failure_signatures.get("correction_failed", 0) + 1)
        if (run.spend.failure_signatures["correction_failed"]
                > run.budgets.max_repeated_failure_signature):
            return _finish(run, ObserverState.EXHAUSTED,
                           "the correction failed repeatedly",
                           error=action.error)
    else:
        run.spend.corrections_applied += 1

    _reobserve(run)
    # The approval is spent. A second iteration must ask again, because the
    # world it was granted about is not the world any more.
    run.approval_id = None
    run.action_id = None
    run.state = ObserverState.RETRYING
    return db.save_run(run)


def _reobserve(run: ObserverRun) -> None:
    """Show the corrected state to the live session, for the human record.

    Best effort on purpose. This produces the *after* footage a person looks
    at; it has no bearing on the verdict, which comes from the oracle's own
    read. A session that has already stopped simply gets no after clip.
    """
    if run.session_id is None or run.correction is None:
        return
    url = run.correction.reobserve_url
    if not url:
        return
    from watch_skill.live.session import running_session

    runner = running_session(run.session_id)
    source = getattr(runner, "_source", None) if runner else None
    if source is None or not hasattr(source, "navigate"):
        return
    try:
        source.navigate(url)
    except Exception:  # noqa: BLE001 - the human record is never load-bearing
        return


# --- helpers -----------------------------------------------------------------


def _failure_signature(bundle: Any) -> str:
    """A stable fingerprint of *why* verification failed.

    Built from the failing required checks and their statuses, not from
    observed values: "the status text was 'failed'" and "the status text was
    'pending'" are the same failure for retry purposes, and treating them as
    different would let a flapping value burn the whole budget.
    """
    failing = sorted(
        f"{result.check_id}:{result.status.value}"
        for result in bundle.check_results
        if result.required and result.status is not CheckStatus.PASS
    )
    if not failing:
        return ""
    return hashlib.sha256("|".join(failing).encode("utf-8")).hexdigest()[:16]


def _budget_exceeded(run: ObserverRun) -> str:
    now = time.time()
    run.spend.elapsed_seconds = round(now - run.created_at, 2)
    if run.iteration >= run.budgets.max_iterations:
        return (f"the iteration budget of {run.budgets.max_iterations} was "
                f"spent without the postcondition being met")
    if now > run.deadline_at:
        return (f"the wall-clock deadline of "
                f"{run.budgets.deadline_seconds:g}s passed")
    if run.spend.tool_calls >= run.budgets.max_tool_calls:
        return f"the tool-call budget of {run.budgets.max_tool_calls} was spent"
    if run.spend.model_calls > run.budgets.max_model_calls:
        return f"the model-call budget of {run.budgets.max_model_calls} was spent"
    if run.budgets.max_usd and run.spend.usd > run.budgets.max_usd:
        return f"the cost ceiling of ${run.budgets.max_usd:.2f} was passed"
    return ""


def _finish(run: ObserverRun, state: ObserverState, reason: str,
            error: dict[str, Any] | None = None) -> ObserverRun:
    run.state = state
    run.stop_reason = reason
    if error is not None:
        run.error = error
    return db.save_run(run)


def _load(run_id: str) -> ObserverRun:
    run = db.get_run(run_id)
    if run is None:
        raise ObserverError(
            f"no observer run {run_id!r} exists",
            code="observer.run_not_found",
            fix="`watch-skill observe list` shows runs on this machine",
            details={"run_id": run_id},
        )
    return run


def _assert_same_contract(run: ObserverRun, contract: VerificationContract) -> None:
    """The contract handed in must be the one the run was created against.

    Without this, a caller could advance a run using a contract that has since
    been widened, and every earlier verdict in the run would silently be about
    a different question.
    """
    contract.verify_integrity()
    if contract.digest != run.contract_digest:
        raise ObserverError(
            "this run was created against a different postcondition",
            code="observer.postcondition_changed",
            fix="advance the run with the contract it was started with; a "
                "changed postcondition is a new run",
            details={"run_digest": run.contract_digest,
                     "given_digest": contract.digest},
        )


def cancel(run_id: str, reason: str = "cancelled by operator") -> ObserverRun:
    """Stop a run wherever it is. Safe in every state, including waiting."""
    run = _load(run_id)
    if run.finished:
        return run
    return _finish(run, ObserverState.CANCELLED, reason)


def get(run_id: str) -> ObserverRun:
    return _load(run_id)


def approve_pending(run_id: str, *, actor: str, reason: str = "") -> ObserverRun:
    """Record a human's approval of the correction this run is waiting on.

    A convenience over the approvals API, not a shortcut around it: it still
    requires a named actor, still writes to the approval store, and still
    leaves the effect unperformed until the loop is advanced again.
    """
    from watch_skill.actions.approvals import approve

    run = _load(run_id)
    if run.state is not ObserverState.AWAITING_APPROVAL or not run.approval_id:
        raise ObserverError(
            f"run {run_id} is not waiting for an approval",
            code="observer.not_awaiting_approval",
            fix="advance the run until it reports awaiting_approval",
            details={"state": run.state.value},
        )
    approve(run.approval_id, actor=actor, reason=reason)
    run.state = ObserverState.CORRECTION_PROPOSED
    run.stop_reason = ""
    return db.save_run(run)


__all__ = [
    "ObserverError",
    "advance",
    "approve_pending",
    "cancel",
    "get",
    "start_run",
]
