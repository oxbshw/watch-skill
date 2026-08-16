"""Proposing, approving, and performing a side effect — in that order, always.

This module is the only path from "an agent thinks something should happen" to
"it happened". Everything it does is arranged so that the steps cannot be
reordered or skipped:

* :func:`propose` writes a row and returns; it performs nothing.
* :func:`perform` refuses unless an approval exists, is granted, is unspent,
  is unexpired, and was granted for *this exact effect*.
* The approval is spent inside the same call that performs the effect, and the
  action's state moves by compare-and-swap, so two workers holding the same
  proposal cannot both execute it.

The verification step is deliberately absent from this file. An action that
ran without error is not an action that worked, and putting the oracle here
would let the executor be the judge of its own output.
"""
from __future__ import annotations

import uuid
from typing import Any

from watch_skill.actions import db
from watch_skill.actions.approvals import ApprovalError, consume, request_approval
from watch_skill.actions.executors import ExecutionError, execute
from watch_skill.actions.types import Action, ActionState, Approval
from watch_skill.errors import WatchSkillError
from watch_skill.policy import Channel, get_policy


class ActionError(WatchSkillError):
    """An action could not be proposed or performed."""

    default_code = "actions.failed"


def propose(
    *,
    kind: str,
    inputs: dict[str, Any],
    summary: str,
    proposed_by: str,
    idempotency_key: str = "",
    requires_approval: bool = True,
    evidence_refs: list[str] | None = None,
    session_id: str | None = None,
    loop_id: str | None = None,
) -> Action:
    """Record that something should happen. Nothing happens.

    The policy decision is taken and stored *now*, at proposal time, so the
    record shows what the rules were when the action was raised rather than
    what they became by the time somebody looked at it.
    """
    decision = get_policy().check(Channel.ACTION)
    action = Action(
        action_id=f"act_{uuid.uuid4().hex[:12]}",
        kind=kind,
        summary=summary,
        state=(ActionState.AWAITING_APPROVAL if requires_approval
               else ActionState.PROPOSED),
        proposed_by=proposed_by,
        requires_approval=requires_approval,
        idempotency_key=idempotency_key,
        inputs=inputs,
        evidence_refs=evidence_refs or [],
        policy_decision={"channel": decision.channel.value,
                         "allowed": decision.allowed,
                         "reason": decision.reason},
        session_id=session_id,
        loop_id=loop_id,
    )
    return db.insert_action(action)


def request_approval_for(action: Action, *, ttl_seconds: float = 900.0) -> Approval:
    """Raise the approval request for a proposed action.

    The summary shown to the approver is the action's own summary plus the
    literal inputs, because an approval prompt that describes the effect
    vaguely is an approval nobody actually gave.
    """
    approval = request_approval(
        kind=action.kind, inputs=action.inputs,
        summary=action.summary, action_id=action.action_id,
        ttl_seconds=ttl_seconds,
    )
    db.transition(action.action_id, ActionState.AWAITING_APPROVAL,
                  actor=action.proposed_by, reason="approval requested",
                  approval_id=approval.approval_id)
    return approval


def perform(action_id: str, *, approval_id: str | None = None,
            actor: str = "executor") -> Action:
    """Carry out an approved action, exactly once.

    Ordering inside this function is the security property. The approval is
    spent *before* the effect runs, so a crash between the two leaves an
    approval marked used and an action marked started — which reads as "we do
    not know whether this happened" and requires a human. The opposite order
    would leave a spent effect with an unspent approval, which reads as safe
    and is not.
    """
    action = db.get_action(action_id)
    if action is None:
        raise ActionError(
            f"no action {action_id!r} exists",
            code="actions.not_found",
            fix="propose the action first",
            details={"action_id": action_id},
        )
    if action.state in (ActionState.SUCCEEDED, ActionState.VERIFIED,
                        ActionState.VERIFICATION_PENDING):
        return action  # already done; performing again is not a retry

    if action.requires_approval:
        approval_id = approval_id or action.approval_id
        if not approval_id:
            raise ActionError(
                f"action {action_id} requires approval and has none",
                code="actions.approval_required",
                fix="request_approval_for(action), have a human approve it, "
                    "then perform the action",
                details={"action_id": action_id},
            )
        try:
            consume(approval_id, kind=action.kind, inputs=action.inputs)
        except ApprovalError:
            db.transition(action_id, ActionState.FAILED, actor=actor,
                          reason="approval refused")
            raise

    started = db.transition(
        action_id, ActionState.STARTED,
        expect=action.state, actor=actor, reason="executing",
    )
    if started is None:
        # Someone else moved it between the read and the write. That is the
        # duplicate-execution case, and losing the race means doing nothing.
        current = db.get_action(action_id)
        raise ActionError(
            f"action {action_id} was already claimed by another worker",
            code="actions.already_claimed",
            fix="the action is being executed elsewhere; do not retry",
            details={"action_id": action_id,
                     "state": current.state.value if current else "unknown"},
        )

    try:
        outputs = execute(action.kind, action.inputs)
    except (ExecutionError, WatchSkillError) as exc:
        failed = db.transition(action_id, ActionState.FAILED,
                               expect=ActionState.STARTED, actor=actor,
                               reason=exc.message, error=exc.to_dict(),
                               bump_retry=True)
        return failed or action
    return db.transition(action_id, ActionState.SUCCEEDED,
                         expect=ActionState.STARTED, actor=actor,
                         reason="executed", outputs=outputs) or action


def record_verification(action_id: str, *, run_id: str, verdict: str,
                        actor: str = "verifier") -> Action | None:
    """Attach an independent verdict to an action.

    Separate from :func:`perform` and reached by a different caller, because
    an executor that could write its own verdict would make the verdict
    worthless.
    """
    state = (ActionState.VERIFIED if verdict == "pass"
             else ActionState.VERIFICATION_FAILED)
    return db.transition(action_id, state, actor=actor,
                         reason=f"verification {verdict}",
                         verification_run_id=run_id,
                         verification_verdict=verdict)


__all__ = [
    "ActionError",
    "perform",
    "propose",
    "record_verification",
    "request_approval_for",
]
