"""Asking a human, and being unable to answer on their behalf.

The API is deliberately asymmetric. Proposing work and requesting approval are
things an agent does constantly; *granting* one is a separate call, with a
separate actor, that the acting agent has no legitimate path to. That
asymmetry is the only thing standing between "the agent decided" and "the
agent was permitted", and it is worth the extra function.

An approval is bound to an ``effect_digest`` — a hash of exactly what will
happen. Approving "POST /api/fix on port 61233" does not approve "POST
/api/delete on port 61233", even for the same action id, because the digest
differs and :func:`consume` refuses the mismatch.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

from watch_skill.actions import db
from watch_skill.actions.types import Approval, ApprovalStatus
from watch_skill.errors import WatchSkillError

DEFAULT_TTL_SECONDS = 900.0
"""Fifteen minutes. An approval that outlives the situation it was granted in
is a stale approval, and a stale approval applied later is indistinguishable
from an unapproved action."""


class ApprovalError(WatchSkillError):
    """An approval was missing, stale, spent, or for a different effect."""

    default_code = "actions.approval_denied"


def effect_digest(kind: str, inputs: dict[str, Any]) -> str:
    """A stable hash of exactly what is about to happen.

    Canonical JSON with sorted keys, so two processes describing the same
    effect agree — the digest is worthless if it depends on dict ordering.
    """
    payload = json.dumps({"kind": kind, "inputs": inputs}, sort_keys=True,
                         separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def request_approval(
    *,
    kind: str,
    inputs: dict[str, Any],
    summary: str,
    action_id: str = "",
    ttl_seconds: float = DEFAULT_TTL_SECONDS,
) -> Approval:
    """Ask for permission. Returns a pending record; grants nothing."""
    approval = Approval(
        approval_id=f"apr_{uuid.uuid4().hex[:12]}",
        action_id=action_id,
        effect_digest=effect_digest(kind, inputs),
        summary=summary,
        status=ApprovalStatus.PENDING,
        expires_at=time.time() + max(1.0, ttl_seconds),
    )
    db.insert_approval(approval)
    return approval


def approve(approval_id: str, *, actor: str, reason: str = "") -> Approval:
    """Grant a pending request. ``actor`` is required and recorded.

    There is no default actor. An approval whose approver is "system" or ""
    documents nothing, and the entire value of this record is that it names
    who decided.
    """
    if not actor.strip():
        raise ApprovalError(
            "an approval must name who granted it",
            code="actions.approval_actor_required",
            fix="pass the human or service identity that approved this",
        )
    decided = db.decide_approval(approval_id, ApprovalStatus.APPROVED,
                                 actor=actor, reason=reason)
    if decided is None:
        raise ApprovalError(
            f"no approval request {approval_id!r} exists",
            code="actions.approval_not_found",
            fix="request_approval() first, then approve the id it returns",
            details={"approval_id": approval_id},
        )
    return decided


def reject(approval_id: str, *, actor: str, reason: str = "") -> Approval:
    decided = db.decide_approval(approval_id, ApprovalStatus.REJECTED,
                                 actor=actor, reason=reason)
    if decided is None:
        raise ApprovalError(
            f"no approval request {approval_id!r} exists",
            code="actions.approval_not_found",
            fix="request_approval() first, then reject the id it returns",
            details={"approval_id": approval_id},
        )
    return decided


def consume(approval_id: str, *, kind: str, inputs: dict[str, Any]) -> Approval:
    """Spend an approval for one effect, or refuse and say why.

    Every reason for refusal gets its own error code, because they call for
    different responses: a stale approval should be re-requested, a spent one
    means something is retrying that should not be, and a digest mismatch
    means the effect changed after it was approved — which is an attack shape,
    not a mistake.
    """
    record = db.get_approval(approval_id)
    if record is None:
        raise ApprovalError(
            f"no approval {approval_id!r} exists",
            code="actions.approval_not_found",
            fix="request approval before performing the side effect",
            details={"approval_id": approval_id},
        )
    if record.status is not ApprovalStatus.APPROVED:
        raise ApprovalError(
            f"approval {approval_id} is {record.status.value}, not approved",
            code="actions.approval_not_granted",
            fix="wait for a human decision, or request a new approval",
            details={"approval_id": approval_id, "status": record.status.value},
        )
    if record.expired:
        raise ApprovalError(
            f"approval {approval_id} expired before it was used",
            code="actions.approval_expired",
            fix="request a fresh approval — a decision made about an earlier "
                "state of the world is not a decision about this one",
            details={"approval_id": approval_id, "expires_at": record.expires_at},
        )
    wanted = effect_digest(kind, inputs)
    if record.effect_digest != wanted:
        raise ApprovalError(
            "this approval was granted for a different effect",
            code="actions.approval_effect_mismatch",
            fix="request approval for the effect you are actually performing; "
                "an approved action may not change what it does",
            details={"approval_id": approval_id,
                     "approved_digest": record.effect_digest,
                     "attempted_digest": wanted},
        )
    spent = db.consume_approval(approval_id, wanted)
    if spent is None:
        raise ApprovalError(
            f"approval {approval_id} has already been used",
            code="actions.approval_already_used",
            fix="an approval authorises one execution; request another if the "
                "effect genuinely needs to happen again",
            details={"approval_id": approval_id, "used_at": record.used_at},
        )
    return spent


def approval_state(approval_id: str) -> dict[str, Any] | None:
    """A read-only view for the verification oracle.

    Returns the record the way a verifier needs to read it — including
    ``expired`` resolved against the clock now, rather than the stored status,
    which is only updated when somebody looks.
    """
    record = db.get_approval(approval_id)
    if record is None:
        return None
    payload = record.to_public()
    payload["expired"] = record.expired
    payload["decided_at"] = record.decided_at
    return payload


def list_approvals(status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    return [approval.to_public()
            for approval in db.list_approvals(status=status, limit=limit)]


__all__ = [
    "DEFAULT_TTL_SECONDS",
    "ApprovalError",
    "approval_state",
    "approve",
    "consume",
    "effect_digest",
    "list_approvals",
    "reject",
    "request_approval",
]
