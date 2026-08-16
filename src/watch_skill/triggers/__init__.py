"""Deterministic triggers: fire when the evidence says so, not when a model does.

A trigger is a typed structure compiled to a fixed set of comparisons. There
is no ``eval``, no lambda, no template with code in it, and no model-written
predicate — because the thing a trigger reads is an event log full of text a
webpage wrote, and any of those would turn that log into an execution surface.

The public surface is small on purpose: define a trigger, advance it over the
events it has not seen, and ask it to explain itself. Everything else is
machinery.
"""
from __future__ import annotations

from watch_skill.triggers.db import (
    get_trigger,
    list_firings,
    list_triggers,
    set_state,
)
from watch_skill.triggers.engine import (
    TriggerError,
    create_trigger,
    evaluate,
    explain,
)
from watch_skill.triggers.types import (
    TRIGGER_SCHEMA_VERSION,
    Comparator,
    ConditionKind,
    EventPattern,
    FieldPredicate,
    Firing,
    Trigger,
    TriggerAction,
    TriggerCondition,
    TriggerState,
)

__all__ = [
    "TRIGGER_SCHEMA_VERSION",
    "Comparator",
    "ConditionKind",
    "EventPattern",
    "FieldPredicate",
    "Firing",
    "Trigger",
    "TriggerAction",
    "TriggerCondition",
    "TriggerError",
    "TriggerState",
    "create_trigger",
    "evaluate",
    "explain",
    "get_trigger",
    "list_firings",
    "list_triggers",
    "set_state",
]
