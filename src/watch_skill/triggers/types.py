"""Triggers as data, never as code.

The temptation with "fire when X happens" is to accept a Python expression, a
template, or a model-written predicate. Every one of those turns an event log
— which is full of text a webpage wrote — into an execution surface. So a
trigger here is a typed structure compiled to a fixed set of comparisons, and
there is deliberately no escape hatch: no ``eval``, no lambda, no template
with code in it, no model-generated expression.

What that costs is expressiveness. What it buys is that a trigger's behaviour
can be read off its definition, replayed exactly, and explained afterwards —
which is what makes it safe to let one propose an action.
"""
from __future__ import annotations

import time
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator

TRIGGER_SCHEMA_VERSION = 1

MAX_PREDICATES = 32
MAX_SEQUENCE_STEPS = 8


class Comparator(str, Enum):  # noqa: UP042 — matches SourceKind
    """The complete set of comparisons a predicate may make."""

    EQ = "eq"
    NE = "ne"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    CONTAINS = "contains"
    NOT_CONTAINS = "not_contains"
    STARTS_WITH = "starts_with"
    IN = "in"
    NOT_IN = "not_in"
    EXISTS = "exists"
    ABSENT = "absent"


class FieldPredicate(BaseModel):
    """One comparison against one field of an event's public payload.

    ``path`` is a dotted path, resolved by walking dictionaries. It cannot
    call anything, index by expression, or reach outside the payload it is
    given — a path is a lookup, not a program.
    """

    model_config = {"frozen": True, "extra": "forbid"}

    path: str = Field(min_length=1, max_length=200)
    op: Comparator
    value: Any = None

    @model_validator(mode="after")
    def _value_required_unless_existence(self) -> FieldPredicate:
        if self.op in (Comparator.EXISTS, Comparator.ABSENT):
            return self
        if self.value is None:
            raise ValueError(f"{self.op.value} needs a value to compare against")
        if self.op in (Comparator.IN, Comparator.NOT_IN) \
                and not isinstance(self.value, list):
            raise ValueError(f"{self.op.value} needs a list")
        return self


class EventPattern(BaseModel):
    """What counts as a matching event.

    ``none_of`` exists so exclusions are first-class. Expressing "a console
    error that is not the known-noisy one" by inverting the whole pattern is
    how people end up wanting a boolean expression language.
    """

    model_config = {"frozen": True, "extra": "forbid"}

    types: tuple[str, ...] = ()
    detectors: tuple[str, ...] = ()
    all_of: tuple[FieldPredicate, ...] = ()
    any_of: tuple[FieldPredicate, ...] = ()
    none_of: tuple[FieldPredicate, ...] = ()

    @model_validator(mode="after")
    def _bounded(self) -> EventPattern:
        total = len(self.all_of) + len(self.any_of) + len(self.none_of)
        if total > MAX_PREDICATES:
            raise ValueError(
                f"a pattern may hold at most {MAX_PREDICATES} predicates, got {total}")
        return self


class ConditionKind(str, Enum):  # noqa: UP042 — matches SourceKind
    MATCH = "match"
    """Any single matching event fires."""

    COUNT = "count"
    """N matching events inside a rolling window."""

    SEQUENCE = "sequence"
    """Patterns matched in order, inside a window."""

    ABSENCE = "absence"
    """No matching event for a window. The only condition that fires because
    of something that did *not* happen, which is why it needs a clock rather
    than only an event to evaluate."""


class TriggerCondition(BaseModel):
    model_config = {"frozen": True, "extra": "forbid"}

    kind: ConditionKind = ConditionKind.MATCH
    pattern: EventPattern | None = None
    steps: tuple[EventPattern, ...] = ()
    threshold: int = Field(default=1, ge=1, le=10_000)
    window_seconds: float = Field(default=60.0, gt=0, le=86_400)

    @model_validator(mode="after")
    def _shape_matches_kind(self) -> TriggerCondition:
        if self.kind is ConditionKind.SEQUENCE:
            if not 2 <= len(self.steps) <= MAX_SEQUENCE_STEPS:
                raise ValueError(
                    f"a sequence needs 2 to {MAX_SEQUENCE_STEPS} steps")
        elif self.pattern is None:
            raise ValueError(f"{self.kind.value} needs a pattern")
        return self


class TriggerState(str, Enum):  # noqa: UP042 — matches SourceKind
    ENABLED = "enabled"
    DISABLED = "disabled"
    EXPIRED = "expired"
    DEAD_LETTER = "dead_letter"
    """Repeatedly failed to turn a firing into a proposal. Stopped, and kept,
    so the failure is visible rather than being retried forever in silence."""


class TriggerAction(BaseModel):
    """What a firing proposes. A proposal, never an execution.

    A trigger cannot perform anything. The strongest thing it can do is create
    a `proposed` action that a human still has to approve, which is why an
    event log full of page-authored text is safe to evaluate triggers over.
    """

    model_config = {"frozen": True, "extra": "forbid"}

    kind: str = ""
    inputs: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    requires_approval: bool = True


class Trigger(BaseModel):
    """A durable rule over a session's event log."""

    schema_version: int = TRIGGER_SCHEMA_VERSION
    trigger_id: str
    session_id: str
    name: str = ""
    condition: TriggerCondition
    action: TriggerAction | None = None
    state: TriggerState = TriggerState.ENABLED
    dry_run: bool = False
    """Evaluate and record firings, propose nothing. The way to find out what
    a rule would have done before letting it do it."""

    once: bool = False
    debounce_seconds: float = Field(default=0.0, ge=0)
    cooldown_seconds: float = Field(default=0.0, ge=0)
    max_firings_per_window: int = Field(default=0, ge=0)
    firing_window_seconds: float = Field(default=60.0, gt=0)
    max_firings_total: int = Field(default=0, ge=0)
    expires_at: float | None = None
    idempotency_prefix: str = ""
    created_at: float = Field(default_factory=time.time)

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "trigger_id": self.trigger_id,
            "session_id": self.session_id,
            "name": self.name,
            "condition": self.condition.model_dump(mode="json"),
            "action": self.action.model_dump() if self.action else None,
            "state": self.state.value,
            "dry_run": self.dry_run,
            "once": self.once,
            "debounce_seconds": self.debounce_seconds,
            "cooldown_seconds": self.cooldown_seconds,
            "max_firings_per_window": self.max_firings_per_window,
            "max_firings_total": self.max_firings_total,
            "expires_at": self.expires_at,
            "created_at": self.created_at,
        }


class Firing(BaseModel):
    """One time a trigger fired, and why."""

    schema_version: int = TRIGGER_SCHEMA_VERSION
    trigger_id: str
    session_id: str
    seq: int
    cause_seq: int
    """The event sequence that completed the condition. Combined with the
    trigger id this is the idempotency key, so redelivering the same events
    proposes the same action rather than a second one."""

    media_ts: float
    wall_ts: float = Field(default_factory=time.time)
    reason: str = ""
    trace: dict[str, Any] = Field(default_factory=dict)
    """Why it matched, in enough detail to argue with. A trigger nobody can
    explain is a trigger nobody will trust with an action."""

    action_id: str | None = None
    suppressed: str = ""
    """Non-empty when the condition was met but no action was proposed —
    dry run, cooldown, debounce, a spent budget. Recorded rather than dropped,
    because "it matched and we deliberately did nothing" is a different fact
    from "it never matched"."""

    def to_public(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


__all__ = [
    "MAX_PREDICATES",
    "MAX_SEQUENCE_STEPS",
    "TRIGGER_SCHEMA_VERSION",
    "Comparator",
    "ConditionKind",
    "EventPattern",
    "FieldPredicate",
    "Firing",
    "Trigger",
    "TriggerAction",
    "TriggerCondition",
    "TriggerState",
]
