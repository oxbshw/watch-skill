"""Compiling a typed pattern into a fixed set of comparisons.

Nothing here can execute anything the caller wrote. A path is walked, a value
is compared with one of thirteen operators, and the result is a bool plus a
short explanation of how it was reached. The explanation is not decoration:
a trigger that proposes an action needs to be able to say why, and "it
matched" is not an answer anybody can check.
"""
from __future__ import annotations

from typing import Any

from watch_skill.triggers.types import (
    Comparator,
    EventPattern,
    FieldPredicate,
)

MISSING = object()


def resolve_path(payload: Any, path: str) -> Any:
    """Walk a dotted path through nested mappings and lists.

    Returns :data:`MISSING` rather than None when the path is not there —
    "the field is absent" and "the field is null" are different facts, and a
    predicate that conflated them would fire on the wrong events.
    """
    current: Any = payload
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return MISSING
            current = current[part]
        elif isinstance(current, (list, tuple)):
            if not part.isdigit():
                return MISSING
            index = int(part)
            if index >= len(current):
                return MISSING
            current = current[index]
        else:
            return MISSING
    return current


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def evaluate_predicate(predicate: FieldPredicate, payload: Any) -> tuple[bool, str]:
    """Apply one comparison. Never raises; a bad comparison is False."""
    observed = resolve_path(payload, predicate.path)
    op = predicate.op

    if op is Comparator.EXISTS:
        return observed is not MISSING, f"{predicate.path} exists"
    if op is Comparator.ABSENT:
        return observed is MISSING, f"{predicate.path} absent"
    if observed is MISSING:
        return False, f"{predicate.path} is not present"

    wanted = predicate.value
    if op is Comparator.EQ:
        return observed == wanted, f"{predicate.path} == {wanted!r}"
    if op is Comparator.NE:
        return observed != wanted, f"{predicate.path} != {wanted!r}"
    if op in (Comparator.GT, Comparator.GTE, Comparator.LT, Comparator.LTE):
        left, right = _as_number(observed), _as_number(wanted)
        if left is None or right is None:
            # A numeric comparison against something that is not a number is
            # False, not an error: the event log carries page-authored values
            # and a trigger must not die because one of them was a word.
            return False, f"{predicate.path} is not numeric ({observed!r})"
        result = {
            Comparator.GT: left > right,
            Comparator.GTE: left >= right,
            Comparator.LT: left < right,
            Comparator.LTE: left <= right,
        }[op]
        return result, f"{predicate.path} {op.value} {right}"
    if op in (Comparator.CONTAINS, Comparator.NOT_CONTAINS):
        if isinstance(observed, (list, tuple)):
            hit = wanted in observed
        else:
            hit = str(wanted).lower() in str(observed).lower()
        result = hit if op is Comparator.CONTAINS else not hit
        return result, f"{predicate.path} {op.value} {wanted!r}"
    if op is Comparator.STARTS_WITH:
        return (str(observed).lower().startswith(str(wanted).lower()),
                f"{predicate.path} starts with {wanted!r}")
    if op in (Comparator.IN, Comparator.NOT_IN):
        hit = observed in list(wanted)
        return (hit if op is Comparator.IN else not hit,
                f"{predicate.path} {op.value} {wanted!r}")
    return False, f"unsupported operator {op!r}"  # pragma: no cover


def matches(pattern: EventPattern, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """Whether one event matches a pattern, and the reasoning.

    Order matters for cost, not correctness: the cheap discriminators (type,
    detector) run first so a busy log is filtered before any path walking.
    """
    trace: dict[str, Any] = {"type_ok": True, "detector_ok": True,
                             "all_of": [], "any_of": [], "none_of": []}

    if pattern.types:
        trace["type_ok"] = payload.get("type") in pattern.types
        if not trace["type_ok"]:
            return False, trace
    if pattern.detectors:
        detector = str(payload.get("detector", ""))
        trace["detector_ok"] = any(
            detector == wanted or detector.startswith(f"{wanted}:")
            for wanted in pattern.detectors
        )
        if not trace["detector_ok"]:
            return False, trace

    for predicate in pattern.all_of:
        ok, why = evaluate_predicate(predicate, payload)
        trace["all_of"].append({"why": why, "ok": ok})
        if not ok:
            return False, trace

    if pattern.any_of:
        results = [evaluate_predicate(p, payload) for p in pattern.any_of]
        trace["any_of"] = [{"why": why, "ok": ok} for ok, why in results]
        if not any(ok for ok, _ in results):
            return False, trace

    for predicate in pattern.none_of:
        ok, why = evaluate_predicate(predicate, payload)
        trace["none_of"].append({"why": why, "ok": ok})
        if ok:
            return False, trace

    return True, trace


__all__ = ["MISSING", "evaluate_predicate", "matches", "resolve_path"]
