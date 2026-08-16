"""Governed actions: proposed, approved, executed, and verified — separately.

The distinction this package exists to keep is between *an agent deciding
something should happen* and *that thing being permitted to happen*. Those are
one step in most agent frameworks, which is why "the model was convinced by a
webpage" and "the side effect occurred" are usually the same event.

Here they are different tables, different APIs, and different actors.
"""
from __future__ import annotations

from watch_skill.actions.approvals import (
    ApprovalError,
    approval_state,
    approve,
    list_approvals,
    reject,
    request_approval,
)
from watch_skill.actions.types import (
    ACTION_SCHEMA_VERSION,
    Action,
    ActionState,
    Approval,
    ApprovalStatus,
)

__all__ = [
    "ACTION_SCHEMA_VERSION",
    "Action",
    "ActionState",
    "Approval",
    "ApprovalError",
    "ApprovalStatus",
    "approval_state",
    "approve",
    "list_approvals",
    "reject",
    "request_approval",
]
