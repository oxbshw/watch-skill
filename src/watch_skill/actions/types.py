"""The lifecycle a side effect goes through, and the record it leaves.

An action is never a function call that either happened or did not. It is a
row that moves through named states, each transition recorded with who caused
it and what evidence existed at the time. That shape is what makes "an
approved correction was applied and then independently verified" a claim
somebody can audit rather than a sentence in a summary.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

ACTION_SCHEMA_VERSION = 1


class ActionState(str, Enum):  # noqa: UP042 — matches SourceKind
    """Where an action is in its life.

    Verification is deliberately *after* success. An action that ran without
    error and an action that achieved its postcondition are different facts,
    and collapsing them is how "it worked" comes to mean "it did not crash".
    """

    PROPOSED = "proposed"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    STARTED = "started"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    VERIFICATION_PENDING = "verification_pending"
    VERIFIED = "verified"
    VERIFICATION_FAILED = "verification_failed"


TERMINAL_ACTION_STATES = frozenset({
    ActionState.VERIFIED,
    ActionState.VERIFICATION_FAILED,
    ActionState.CANCELLED,
    ActionState.FAILED,
})

# Which moves are legal. Written as data rather than as `if` statements
# scattered through the executor, so "can an action go straight from proposed
# to succeeded" has one answer, in one place, that a test can read.
ALLOWED_TRANSITIONS: dict[ActionState, frozenset[ActionState]] = {
    ActionState.PROPOSED: frozenset({
        ActionState.AWAITING_APPROVAL, ActionState.APPROVED,
        ActionState.CANCELLED,
    }),
    ActionState.AWAITING_APPROVAL: frozenset({
        ActionState.APPROVED, ActionState.CANCELLED, ActionState.FAILED,
    }),
    ActionState.APPROVED: frozenset({
        ActionState.STARTED, ActionState.CANCELLED,
    }),
    ActionState.STARTED: frozenset({
        ActionState.SUCCEEDED, ActionState.FAILED, ActionState.CANCELLED,
    }),
    ActionState.SUCCEEDED: frozenset({
        ActionState.VERIFICATION_PENDING, ActionState.VERIFIED,
        ActionState.VERIFICATION_FAILED,
    }),
    ActionState.VERIFICATION_PENDING: frozenset({
        ActionState.VERIFIED, ActionState.VERIFICATION_FAILED,
    }),
    ActionState.FAILED: frozenset(),
    ActionState.CANCELLED: frozenset(),
    ActionState.VERIFIED: frozenset(),
    ActionState.VERIFICATION_FAILED: frozenset(),
}


class ApprovalStatus(str, Enum):  # noqa: UP042 — matches SourceKind
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


class Approval(BaseModel):
    """One human decision about one specific side effect.

    Scoped to an ``effect_digest``: the approval covers the exact thing that
    was described, not the action id. Re-approving is cheap; letting an
    approved action quietly change what it does afterwards is not survivable,
    and the digest is what makes that substitution detectable.
    """

    schema_version: int = ACTION_SCHEMA_VERSION
    approval_id: str
    action_id: str = ""
    effect_digest: str
    summary: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    requested_at: float = Field(default_factory=time.time)
    decided_at: float | None = None
    actor: str = ""
    reason: str = ""
    expires_at: float | None = None
    used_at: float | None = None
    """When the approval was spent. An approval is single-use: replaying one
    would let a correction be applied twice on one decision."""

    @property
    def expired(self) -> bool:
        return (self.expires_at is not None
                and time.time() > self.expires_at
                and self.used_at is None)

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "approval_id": self.approval_id,
            "action_id": self.action_id,
            "effect_digest": self.effect_digest,
            "summary": self.summary,
            "status": ApprovalStatus.EXPIRED.value if self.expired
            else self.status.value,
            "requested_at": self.requested_at,
            "decided_at": self.decided_at,
            "actor": self.actor,
            "reason": self.reason,
            "expires_at": self.expires_at,
            "used": self.used_at is not None,
        }


class Action(BaseModel):
    """A side effect somebody wants to happen, and everything about it."""

    schema_version: int = ACTION_SCHEMA_VERSION
    action_id: str
    kind: str
    """What sort of effect this is — the executor is looked up by this name.
    Never a command string: a string is something page content can rewrite."""

    summary: str = ""
    state: ActionState = ActionState.PROPOSED
    proposed_by: str = ""
    requires_approval: bool = True
    approval_id: str | None = None
    idempotency_key: str = ""
    """Two proposals with the same key are the same action. This is what makes
    a retried trigger firing propose once rather than once per delivery."""

    inputs: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)
    evidence_refs: list[str] = Field(default_factory=list)
    policy_decision: dict[str, Any] = Field(default_factory=dict)
    retry_count: int = 0
    verification_run_id: str | None = None
    verification_verdict: str | None = None
    error: dict[str, Any] | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    session_id: str | None = None
    loop_id: str | None = None

    def can_move_to(self, target: ActionState) -> bool:
        return target in ALLOWED_TRANSITIONS[self.state]

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "action_id": self.action_id,
            "kind": self.kind,
            "summary": self.summary,
            "state": self.state.value,
            "proposed_by": self.proposed_by,
            "requires_approval": self.requires_approval,
            "approval_id": self.approval_id,
            "idempotency_key": self.idempotency_key,
            "inputs": self.inputs,
            "outputs": self.outputs,
            "evidence_refs": self.evidence_refs,
            "policy_decision": self.policy_decision,
            "retry_count": self.retry_count,
            "verification": {
                "run_id": self.verification_run_id,
                "verdict": self.verification_verdict,
            },
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "session_id": self.session_id,
            "loop_id": self.loop_id,
        }


__all__ = [
    "ACTION_SCHEMA_VERSION",
    "ALLOWED_TRANSITIONS",
    "TERMINAL_ACTION_STATES",
    "Action",
    "ActionState",
    "Approval",
    "ApprovalStatus",
]
