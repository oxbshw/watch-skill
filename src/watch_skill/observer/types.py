"""The Observer Loop's states, budgets, and durable run record.

The loop's job is to make one sentence true and checkable: *the postcondition
was declared before the work, and something other than the actor decided
whether it was met*. Everything in this module exists to keep those two
properties from quietly eroding.

The state list is longer than a loop strictly needs because the interesting
distinctions are exactly the ones a shorter list would collapse:
``verification_pending`` is not ``acting``, ``verification_failed`` is not
``failed``, and ``exhausted`` is not ``verified``. Each pair is a place where
"it worked" could otherwise come to mean something weaker.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

OBSERVER_SCHEMA_VERSION = 1


class ObserverState(str, Enum):  # noqa: UP042 — matches SourceKind
    CREATED = "created"
    OBSERVING = "observing"
    ACTING = "acting"
    VERIFICATION_PENDING = "verification_pending"
    VERIFICATION_FAILED = "verification_failed"
    CORRECTION_PROPOSED = "correction_proposed"
    AWAITING_APPROVAL = "awaiting_approval"
    RETRYING = "retrying"
    VERIFIED = "verified"
    EXHAUSTED = "exhausted"
    """Every budget spent without the postcondition being met. Deliberately
    not `failed`: nothing malfunctioned, the work simply did not succeed, and
    an operator needs to tell those apart."""

    CANCELLED = "cancelled"
    FAILED = "failed"
    """The loop itself broke — the oracle was unreachable, a correction could
    not be attempted. Never used for "the postcondition was not met"."""


TERMINAL_STATES = frozenset({
    ObserverState.VERIFIED,
    ObserverState.EXHAUSTED,
    ObserverState.CANCELLED,
    ObserverState.FAILED,
})

WAITING_STATES = frozenset({
    ObserverState.AWAITING_APPROVAL,
})


class Budgets(BaseModel):
    """Hard ceilings. Every one of them ends the loop in ``exhausted``.

    A loop with no ceiling is a loop that spends someone's money or someone's
    afternoon until a human notices, so there is no way to construct one
    without limits — the defaults are conservative rather than absent.
    """

    schema_version: int = OBSERVER_SCHEMA_VERSION
    max_iterations: int = Field(default=5, ge=1, le=100)
    deadline_seconds: float = Field(default=600.0, gt=0)
    max_tool_calls: int = Field(default=200, ge=1)
    max_model_calls: int = Field(default=0, ge=0)
    """Zero by default, and honest: this loop calls no model. Corrections are
    declarative and the oracle is deterministic. The budget exists so a loop
    that later grows a model step cannot do it silently."""

    max_usd: float = Field(default=0.0, ge=0)
    max_repeated_failure_signature: int = Field(default=2, ge=1)
    """Stop after seeing the same failure this many times. A correction that
    produces an identical failure twice is not going to produce a different
    one on the third attempt, and retrying is just spending the deadline."""

    max_consecutive_unavailable_oracle: int = Field(default=2, ge=1)
    """An oracle that cannot be reached is not a pass. After this many the
    loop fails closed rather than continuing to act blind."""

    def to_public(self) -> dict[str, Any]:
        return self.model_dump()


class Spend(BaseModel):
    """What has actually been used, against what was allowed."""

    schema_version: int = OBSERVER_SCHEMA_VERSION
    iterations: int = 0
    tool_calls: int = 0
    model_calls: int = 0
    usd: float = 0.0
    elapsed_seconds: float = 0.0
    verification_attempts: int = 0
    corrections_applied: int = 0
    consecutive_unavailable_oracle: int = 0
    failure_signatures: dict[str, int] = Field(default_factory=dict)


class CorrectionSpec(BaseModel):
    """What to do when the postcondition is not met.

    Declarative and typed — a ``kind`` resolved against the executor registry
    plus structured inputs. Never a command string and never generated code:
    the correction for a failing browser postcondition is a thing an operator
    approves by reading it, and a string assembled at runtime is a thing that
    page content can rewrite between the reading and the running.
    """

    schema_version: int = OBSERVER_SCHEMA_VERSION
    kind: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    requires_approval: bool = True
    """Default true, and lowering it is an explicit operator decision rather
    than a convenience the loop can reach for when it is in a hurry."""

    reobserve_url: str | None = None
    """A page to reload after the correction, so the *observed* state is the
    corrected one rather than a stale render. Verification does not depend on
    this — the oracle opens its own browser — but the human-facing after clip
    does."""


class VerificationAttempt(BaseModel):
    """One judgement, and who made it."""

    schema_version: int = OBSERVER_SCHEMA_VERSION
    iteration: int
    run_id: str
    verdict: str
    assurance: str = ""
    failure_signature: str = ""
    at: float = Field(default_factory=time.time)
    unavailable: bool = False


class ObserverRun(BaseModel):
    """One attempt to make a declared postcondition true, start to finish."""

    schema_version: int = OBSERVER_SCHEMA_VERSION
    run_id: str
    contract_id: str
    contract_digest: str
    """The digest of the frozen postcondition, captured when the run was
    created. If the contract on disk ever stops matching this, the run is
    refused — a moved target makes every verdict meaningless."""

    state: ObserverState = ObserverState.CREATED
    iteration: int = 0
    budgets: Budgets = Field(default_factory=Budgets)
    spend: Spend = Field(default_factory=Spend)
    correction: CorrectionSpec | None = None
    attempts: list[VerificationAttempt] = Field(default_factory=list)
    action_id: str | None = None
    approval_id: str | None = None
    session_id: str | None = None
    working_dir: str = ""
    allowed_origins: list[str] = Field(default_factory=list)
    allowed_roots: list[str] = Field(default_factory=list)
    stop_reason: str = ""
    error: dict[str, Any] | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    deadline_at: float = 0.0

    @property
    def finished(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def waiting(self) -> bool:
        return self.state in WAITING_STATES

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "state": self.state.value,
            "iteration": self.iteration,
            "postcondition": {
                "contract_id": self.contract_id,
                "contract_digest": self.contract_digest,
            },
            "budgets": self.budgets.to_public(),
            "spend": self.spend.model_dump(),
            "correction": self.correction.model_dump() if self.correction else None,
            "attempts": [attempt.model_dump() for attempt in self.attempts],
            "action_id": self.action_id,
            "approval_id": self.approval_id,
            "session_id": self.session_id,
            "stop_reason": self.stop_reason,
            "error": self.error,
            "finished": self.finished,
            "waiting_for_human": self.waiting,
            "verified_by": (self.attempts[-1].run_id if self.attempts
                            and self.state is ObserverState.VERIFIED else None),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "deadline_at": self.deadline_at,
        }


__all__ = [
    "OBSERVER_SCHEMA_VERSION",
    "TERMINAL_STATES",
    "WAITING_STATES",
    "Budgets",
    "CorrectionSpec",
    "ObserverRun",
    "ObserverState",
    "Spend",
    "VerificationAttempt",
]
