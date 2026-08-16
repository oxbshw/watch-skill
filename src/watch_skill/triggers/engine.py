"""Evaluating triggers against a session's event log.

Evaluation is a pure function of (durable state, the events after the cursor).
That is what makes it replay-safe: running it twice over the same events
produces the same firings, because the second run starts from a cursor the
first one advanced and because a firing is keyed by the event that caused it.

Rate limiting is deliberately layered, and each layer answers a different
question:

``debounce``     the same thing is still happening — wait for it to settle
``cooldown``     we just acted — give the action time to take effect
``per window``   something is wrong upstream — do not amplify it
``once`` / total this rule has said what it had to say
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.triggers import db
from watch_skill.triggers.predicates import matches
from watch_skill.triggers.types import (
    ConditionKind,
    Firing,
    Trigger,
    TriggerAction,
    TriggerCondition,
    TriggerState,
)

MAX_EVENTS_PER_PASS = 500
"""Storm protection. A trigger evaluating an unbounded backlog in one call
would hold the machine for as long as the backlog is long; the cursor makes
stopping early free, so it stops early."""

MAX_WINDOW_ENTRIES = 1000
"""Bound on remembered matches inside a count window. A trigger cannot grow
without limit, whatever the event rate."""

MAX_FAILURES_BEFORE_DEAD_LETTER = 3


class TriggerError(WatchSkillError):
    """A trigger could not be created or evaluated."""

    default_code = "triggers.failed"


def create_trigger(
    *,
    session_id: str,
    condition: TriggerCondition,
    action: TriggerAction | None = None,
    name: str = "",
    dry_run: bool = False,
    once: bool = False,
    debounce_seconds: float = 0.0,
    cooldown_seconds: float = 0.0,
    max_firings_per_window: int = 0,
    firing_window_seconds: float = 60.0,
    max_firings_total: int = 0,
    expires_at: float | None = None,
) -> Trigger:
    trigger = Trigger(
        trigger_id=f"trg_{uuid.uuid4().hex[:12]}",
        session_id=session_id,
        name=name,
        condition=condition,
        action=action,
        dry_run=dry_run,
        once=once,
        debounce_seconds=debounce_seconds,
        cooldown_seconds=cooldown_seconds,
        max_firings_per_window=max_firings_per_window,
        firing_window_seconds=firing_window_seconds,
        max_firings_total=max_firings_total,
        expires_at=expires_at,
    )
    return db.insert_trigger(trigger)


def evaluate(trigger_id: str, *, now: float | None = None,
             limit: int = MAX_EVENTS_PER_PASS) -> list[Firing]:
    """Advance one trigger over the events it has not seen. Idempotent.

    Returns the firings produced by *this* pass. Calling again immediately
    returns nothing, because the cursor moved — which is exactly what makes
    it safe to call from a timer, a webhook, and a test at the same time.
    """
    from watch_skill.live import db as live_db

    trigger = db.get_trigger(trigger_id)
    if trigger is None:
        raise TriggerError(
            f"no trigger {trigger_id!r} exists",
            code="triggers.not_found",
            fix="`watch-skill triggers list` shows triggers on this machine",
            details={"trigger_id": trigger_id},
        )
    state = db.evaluation_state(trigger_id) or {}
    now = now if now is not None else time.time()

    if trigger.state is not TriggerState.ENABLED:
        return []
    if trigger.expires_at is not None and now > trigger.expires_at:
        db.set_state(trigger_id, TriggerState.EXPIRED, "expired")
        return []

    events = live_db.read_events(trigger.session_id,
                                 after_seq=state.get("cursor_seq", 0),
                                 limit=min(limit, MAX_EVENTS_PER_PASS))
    if not events:
        # An absence condition still needs evaluating when nothing arrived —
        # that is the entire point of it.
        if trigger.condition.kind is ConditionKind.ABSENCE:
            return _evaluate_absence(trigger, state, now)
        return []

    produced: list[Firing] = []
    for event in events:
        payload = event.to_public()
        state["cursor_seq"] = event.seq
        fired = _consider(trigger, state, event, payload, now)
        if fired is not None:
            produced.append(fired)
        if trigger.condition.kind is ConditionKind.ABSENCE:
            # Any matching event resets the absence clock: the thing we were
            # waiting not to see has been seen.
            ok, _trace = matches(trigger.condition.pattern, payload)
            if ok:
                state["armed_media_ts"] = event.media_ts
    db.save_evaluation_state(trigger_id, _bounded(state))
    return produced


def _consider(trigger: Trigger, state: dict[str, Any], event: Any,
              payload: dict[str, Any], now: float) -> Firing | None:
    kind = trigger.condition.kind
    if kind is ConditionKind.ABSENCE:
        return None
    if kind is ConditionKind.MATCH:
        ok, trace = matches(trigger.condition.pattern, payload)
        if not ok:
            return None
        return _fire(trigger, state, event.seq, event.media_ts, now,
                     "an event matched the pattern", {"match": trace})
    if kind is ConditionKind.COUNT:
        return _consider_count(trigger, state, event, payload, now)
    return _consider_sequence(trigger, state, event, payload, now)


def _consider_count(trigger: Trigger, state: dict[str, Any], event: Any,
                    payload: dict[str, Any], now: float) -> Firing | None:
    condition = trigger.condition
    ok, trace = matches(condition.pattern, payload)
    if not ok:
        return None
    window: list[float] = list(state.get("window", []))
    window.append(event.media_ts)
    # Media time, not wall time. A file replayed at 2x would otherwise make
    # "five errors in a minute" mean something different from what it says.
    cutoff = event.media_ts - condition.window_seconds
    window = [ts for ts in window if ts >= cutoff][-MAX_WINDOW_ENTRIES:]
    state["window"] = window
    if len(window) < condition.threshold:
        return None
    state["window"] = []  # a fired window does not immediately re-fire
    return _fire(trigger, state, event.seq, event.media_ts, now,
                 f"{len(window)} matching events within "
                 f"{condition.window_seconds:g}s",
                 {"match": trace, "count": len(window)})


def _consider_sequence(trigger: Trigger, state: dict[str, Any], event: Any,
                       payload: dict[str, Any], now: float) -> Firing | None:
    condition = trigger.condition
    index = int(state.get("step_index", 0))
    started = state.get("step_started_ts")
    if index > 0 and started is not None \
            and event.media_ts - started > condition.window_seconds:
        # The window closed before the sequence completed. Start over rather
        # than accepting a step that arrived far too late.
        index, started = 0, None
    ok, trace = matches(condition.steps[index], payload)
    if not ok:
        state["step_index"], state["step_started_ts"] = index, started
        return None
    if index == 0:
        started = event.media_ts
    index += 1
    if index < len(condition.steps):
        state["step_index"], state["step_started_ts"] = index, started
        return None
    state["step_index"], state["step_started_ts"] = 0, None
    return _fire(trigger, state, event.seq, event.media_ts, now,
                 f"the {len(condition.steps)}-step sequence completed within "
                 f"{condition.window_seconds:g}s",
                 {"match": trace, "steps": len(condition.steps)})


def _evaluate_absence(trigger: Trigger, state: dict[str, Any],
                      now: float) -> list[Firing]:
    """Fire because something did NOT happen.

    Anchored to the newest event's media time rather than to the wall clock:
    a session that has stopped producing events has not necessarily had
    time pass in its media, and firing on wall time would report an absence
    in a stream that simply is not playing.
    """
    from watch_skill.live import db as live_db

    condition = trigger.condition
    latest = live_db.read_events(trigger.session_id, limit=1,
                                 after_seq=max(0, state.get("cursor_seq", 0) - 1))
    newest_ts = latest[-1].media_ts if latest else state.get("armed_media_ts", 0.0)
    armed = float(state.get("armed_media_ts", 0.0))
    if newest_ts - armed < condition.window_seconds:
        return []
    firing = _fire(trigger, state, state.get("cursor_seq", 0), newest_ts, now,
                   f"nothing matched for {condition.window_seconds:g}s of media",
                   {"absence": True, "armed_at": armed, "now_media_ts": newest_ts})
    state["armed_media_ts"] = newest_ts
    db.save_evaluation_state(trigger.trigger_id, _bounded(state))
    return [firing] if firing else []


def _fire(trigger: Trigger, state: dict[str, Any], cause_seq: int,
          media_ts: float, now: float, reason: str,
          trace: dict[str, Any]) -> Firing | None:
    """Turn a met condition into a firing, or record why it was suppressed.

    Suppression is written down. "It matched and we deliberately did nothing"
    and "it never matched" look identical from the outside otherwise, and the
    difference is exactly what someone debugging a quiet trigger needs.
    """
    suppressed = _suppression(trigger, state, now)
    firing = Firing(
        trigger_id=trigger.trigger_id, session_id=trigger.session_id, seq=0,
        cause_seq=cause_seq, media_ts=media_ts, wall_ts=now,
        reason=reason, trace=trace, suppressed=suppressed,
    )
    recorded = db.record_firing(firing)
    if recorded is None:
        return None  # this cause already fired; redelivery must not duplicate
    state["last_matched_at"] = now
    if suppressed:
        return recorded
    state["last_fired_at"] = now
    state["fire_count"] = int(state.get("fire_count", 0)) + 1
    if trigger.action is not None:
        _propose(trigger, recorded)
    if trigger.once:
        db.set_state(trigger.trigger_id, TriggerState.DISABLED, "once")
    return recorded


def _suppression(trigger: Trigger, state: dict[str, Any], now: float) -> str:
    if trigger.dry_run:
        return "dry_run"
    last_matched = state.get("last_matched_at")
    if trigger.debounce_seconds and last_matched is not None \
            and now - last_matched < trigger.debounce_seconds:
        return "debounce"
    last_fired = state.get("last_fired_at")
    if trigger.cooldown_seconds and last_fired is not None \
            and now - last_fired < trigger.cooldown_seconds:
        return "cooldown"
    if trigger.max_firings_total and \
            int(state.get("fire_count", 0)) >= trigger.max_firings_total:
        return "max_firings_total"
    if trigger.max_firings_per_window:
        recent = db.firings_since(trigger.trigger_id,
                                  now - trigger.firing_window_seconds)
        if recent >= trigger.max_firings_per_window:
            return "rate_limited"
    return ""


def _propose(trigger: Trigger, firing: Firing) -> None:
    """Create the proposal for a firing. Never performs anything.

    A failure here does not lose the firing — it is already recorded — but it
    is counted, and a trigger that cannot propose repeatedly is dead-lettered
    rather than retried forever in silence.
    """
    from watch_skill.actions.runner import propose

    action = trigger.action
    if action is None or not action.kind:  # pragma: no cover - guarded above
        return
    prefix = trigger.idempotency_prefix or trigger.trigger_id
    try:
        proposed = propose(
            kind=action.kind,
            inputs=dict(action.inputs),
            summary=action.summary or f"proposed by trigger {trigger.name or trigger.trigger_id}",
            proposed_by=f"trigger:{trigger.trigger_id}",
            # The causing event is part of the key, so the same event can
            # only ever produce one proposal however many times it is seen.
            idempotency_key=f"{prefix}:{firing.cause_seq}",
            requires_approval=action.requires_approval,
            session_id=trigger.session_id,
        )
    except Exception as exc:  # noqa: BLE001 - a failing proposal is data, not a crash
        state = db.evaluation_state(trigger.trigger_id) or {}
        failures = int(state.get("failures", 0)) + 1
        state["failures"] = failures
        if failures >= MAX_FAILURES_BEFORE_DEAD_LETTER:
            db.set_state(trigger.trigger_id, TriggerState.DEAD_LETTER,
                         f"could not propose an action {failures} times: {exc}")
        db.save_evaluation_state(trigger.trigger_id, _bounded(state))
        return
    db.attach_action(trigger.trigger_id, firing.seq, proposed.action_id)
    # Also on the object the caller is about to receive. Persisting it and
    # not returning it would make every caller re-query to answer "what did
    # this firing propose?", and the ones that forgot would quietly report
    # that a firing proposed nothing.
    firing.action_id = proposed.action_id


def _bounded(state: dict[str, Any]) -> dict[str, Any]:
    """Fill in defaults and cap anything that could grow."""
    window = list(state.get("window") or [])[-MAX_WINDOW_ENTRIES:]
    return {
        "cursor_seq": int(state.get("cursor_seq", 0)),
        "fire_count": int(state.get("fire_count", 0)),
        "last_fired_at": state.get("last_fired_at"),
        "last_matched_at": state.get("last_matched_at"),
        "armed_media_ts": float(state.get("armed_media_ts", 0.0)),
        "window": window,
        "step_index": int(state.get("step_index", 0)),
        "step_started_ts": state.get("step_started_ts"),
        "failures": int(state.get("failures", 0)),
        "dead_letter_reason": str(state.get("dead_letter_reason", "")),
    }


def explain(trigger_id: str, limit: int = 20) -> dict[str, Any]:
    """Everything about a trigger, including what it did and did not do."""
    trigger = db.get_trigger(trigger_id)
    if trigger is None:
        raise TriggerError(
            f"no trigger {trigger_id!r} exists",
            code="triggers.not_found",
            fix="`watch-skill triggers list` shows triggers on this machine",
        )
    state = db.evaluation_state(trigger_id) or {}
    firings = db.list_firings(trigger_id, limit=limit)
    return {
        "schema_version": 1,
        "trigger": trigger.to_public(),
        "evaluation": {
            "cursor_seq": state.get("cursor_seq", 0),
            "fire_count": state.get("fire_count", 0),
            "last_fired_at": state.get("last_fired_at"),
            "failures": state.get("failures", 0),
            "dead_letter_reason": state.get("dead_letter_reason", ""),
        },
        "firings": [firing.to_public() for firing in firings],
        "suppressed": [f.to_public() for f in firings if f.suppressed],
    }


__all__ = [
    "MAX_EVENTS_PER_PASS",
    "MAX_WINDOW_ENTRIES",
    "TriggerError",
    "create_trigger",
    "evaluate",
    "explain",
]
