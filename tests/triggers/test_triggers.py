"""Triggers: deterministic, replay-safe, and unable to execute anything.

The properties under test are the ones that make it safe to evaluate a rule
over an event log full of text a webpage wrote: no code path from a predicate
to execution, no double-firing on redelivery, and a bounded amount of state
however long a session runs.
"""
from __future__ import annotations

import time

import pytest

from watch_skill.actions import db as actions_db
from watch_skill.live import db as live_db
from watch_skill.live.types import (
    LiveEvent,
    LiveEventType,
    LiveSession,
    LiveSourceKind,
    LiveSourceSpec,
)
from watch_skill.triggers import (
    Comparator,
    ConditionKind,
    EventPattern,
    FieldPredicate,
    TriggerAction,
    TriggerCondition,
    TriggerState,
    create_trigger,
    evaluate,
    explain,
    get_trigger,
    list_firings,
)

SESSION = "live_trg"


@pytest.fixture(autouse=True)
def session():
    live_db.insert_session(LiveSession(
        session_id=SESSION,
        spec=LiveSourceSpec(kind=LiveSourceKind.BROWSER, target="x")))
    return SESSION


def emit(kind: LiveEventType = LiveEventType.ERROR, *, summary: str = "boom",
         media_ts: float = 1.0, detector: str = "browser:console",
         detail: dict | None = None) -> int:
    return live_db.append_event(LiveEvent(
        session_id=SESSION, seq=0, media_ts=media_ts, wall_ts=time.time(),
        type=kind, summary=summary, detector=detector, detail=detail or {}))


def error_pattern(**kwargs) -> EventPattern:
    return EventPattern(types=("error",), **kwargs)


# --- matching ----------------------------------------------------------------


def test_a_match_trigger_fires_on_the_event_that_completes_it() -> None:
    trigger = create_trigger(session_id=SESSION,
                             condition=TriggerCondition(pattern=error_pattern()))
    assert evaluate(trigger.trigger_id) == []

    seq = emit(summary="settlement service unreachable")
    firings = evaluate(trigger.trigger_id)
    assert len(firings) == 1
    assert firings[0].cause_seq == seq
    assert firings[0].trace, "a firing with no trace cannot be argued with"


def test_a_predicate_reads_structured_fields_not_just_the_summary() -> None:
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(pattern=EventPattern(
            all_of=(FieldPredicate(path="detail.browser.detail.status",
                                   op=Comparator.GTE, value=500),))))
    emit(detail={"browser": {"detail": {"status": 404}}})
    assert evaluate(trigger.trigger_id) == []
    emit(detail={"browser": {"detail": {"status": 503}}})
    assert len(evaluate(trigger.trigger_id)) == 1


def test_a_dotted_path_cannot_reach_outside_the_payload() -> None:
    """The predicate language walks mappings and does nothing else.

    A path is only ever a key lookup, so attribute access — the route from a
    field name to arbitrary Python — resolves to MISSING rather than to an
    object. MISSING is distinct from None on purpose: "the field is absent"
    and "the field is null" are different facts.
    """
    from watch_skill.triggers.predicates import MISSING, resolve_path

    payload = {"detail": {"a": 1, "b": None}}
    assert resolve_path(payload, "detail.a") == 1
    assert resolve_path(payload, "detail.b") is None
    assert resolve_path(payload, "detail.missing") is MISSING
    for hostile in ("detail.__class__", "__class__.__mro__",
                    "detail.a.__init__", "detail.a.__class__.__bases__"):
        assert resolve_path(payload, hostile) is MISSING, hostile


# --- replay safety -----------------------------------------------------------


def test_re_evaluating_does_not_fire_twice() -> None:
    """The cursor is what makes this safe to call from a timer and a test."""
    trigger = create_trigger(session_id=SESSION,
                             condition=TriggerCondition(pattern=error_pattern()))
    emit()
    assert len(evaluate(trigger.trigger_id)) == 1
    assert evaluate(trigger.trigger_id) == []
    assert evaluate(trigger.trigger_id) == []
    assert len(list_firings(trigger.trigger_id)) == 1


def test_a_trigger_resumes_from_its_cursor_rather_than_from_the_start() -> None:
    """Durable state, read back rather than remembered.

    Nothing is cached in this process between calls — `evaluate` reads the
    cursor from the database every time — so a second pass must see only the
    events that arrived after the first one.
    """
    trigger = create_trigger(session_id=SESSION,
                             condition=TriggerCondition(pattern=error_pattern()))
    first_seq = emit(media_ts=1.0)
    first = evaluate(trigger.trigger_id)
    assert [f.cause_seq for f in first] == [first_seq]

    second_seq = emit(media_ts=2.0)
    third_seq = emit(media_ts=3.0)
    second = evaluate(trigger.trigger_id)
    assert [f.cause_seq for f in second] == [second_seq, third_seq], (
        "the second pass did not resume exactly where the first stopped")

    causes = [f.cause_seq for f in list_firings(trigger.trigger_id)]
    assert sorted(causes) == [first_seq, second_seq, third_seq]
    assert len(causes) == len(set(causes)), "an event fired more than once"


# --- suppression -------------------------------------------------------------


def test_once_only_fires_once_however_many_events_arrive() -> None:
    trigger = create_trigger(session_id=SESSION, once=True,
                             condition=TriggerCondition(pattern=error_pattern()))
    emit(media_ts=1.0)
    assert len(evaluate(trigger.trigger_id)) == 1
    emit(media_ts=2.0)
    emit(media_ts=3.0)
    later = evaluate(trigger.trigger_id)
    assert all(f.suppressed for f in later), "a once-only trigger fired twice"


def test_cooldown_records_the_match_it_declined_to_act_on() -> None:
    """'It matched and we deliberately did nothing' is not 'it never matched'."""
    trigger = create_trigger(session_id=SESSION, cooldown_seconds=3600.0,
                             condition=TriggerCondition(pattern=error_pattern()))
    emit(media_ts=1.0)
    first = evaluate(trigger.trigger_id)
    assert first and not first[0].suppressed

    emit(media_ts=2.0)
    second = evaluate(trigger.trigger_id)
    assert second and second[0].suppressed == "cooldown"


def test_a_firing_budget_stops_a_storm() -> None:
    trigger = create_trigger(
        session_id=SESSION, max_firings_per_window=2, firing_window_seconds=3600.0,
        condition=TriggerCondition(pattern=error_pattern()))
    for index in range(12):
        emit(media_ts=float(index))
    firings = evaluate(trigger.trigger_id)
    acted = [f for f in firings if not f.suppressed]
    assert len(acted) == 2, f"a storm produced {len(acted)} actionable firings"
    assert any(f.suppressed == "rate_limited" for f in firings), (
        f"suppression reasons were {sorted({f.suppressed for f in firings})}")


def test_an_expired_trigger_stops_evaluating() -> None:
    trigger = create_trigger(session_id=SESSION,
                             expires_at=time.time() - 1.0,
                             condition=TriggerCondition(pattern=error_pattern()))
    emit()
    assert evaluate(trigger.trigger_id) == []
    assert get_trigger(trigger.trigger_id).state is TriggerState.EXPIRED


def test_a_disabled_trigger_does_nothing() -> None:
    from watch_skill.triggers import set_state

    trigger = create_trigger(session_id=SESSION,
                             condition=TriggerCondition(pattern=error_pattern()))
    set_state(trigger.trigger_id, TriggerState.DISABLED, "operator paused it")
    emit()
    assert evaluate(trigger.trigger_id) == []


# --- conditions --------------------------------------------------------------


def test_count_needs_the_threshold_inside_the_window() -> None:
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(kind=ConditionKind.COUNT, threshold=3,
                                   window_seconds=10.0,
                                   pattern=error_pattern()))
    emit(media_ts=1.0)
    emit(media_ts=2.0)
    assert evaluate(trigger.trigger_id) == []
    emit(media_ts=3.0)
    assert len(evaluate(trigger.trigger_id)) == 1


def test_count_ignores_events_that_have_aged_out_of_the_window() -> None:
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(kind=ConditionKind.COUNT, threshold=3,
                                   window_seconds=5.0, pattern=error_pattern()))
    emit(media_ts=1.0)
    emit(media_ts=2.0)
    emit(media_ts=100.0)      # far outside the window with the first two
    assert evaluate(trigger.trigger_id) == [], (
        "events outside the window were counted toward the threshold")


def test_a_sequence_needs_its_steps_in_order() -> None:
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(
            kind=ConditionKind.SEQUENCE, window_seconds=30.0,
            steps=(EventPattern(types=("browser_event",)),
                   EventPattern(types=("error",)))))
    # The wrong order must not fire.
    emit(LiveEventType.ERROR, media_ts=1.0)
    assert evaluate(trigger.trigger_id) == []
    emit(LiveEventType.BROWSER_EVENT, media_ts=2.0, detector="browser:navigation")
    assert evaluate(trigger.trigger_id) == []
    emit(LiveEventType.ERROR, media_ts=3.0)
    assert len(evaluate(trigger.trigger_id)) == 1


def test_absence_fires_because_of_something_that_did_not_happen() -> None:
    """Absence is measured in *media* time, not wall time.

    A stopped session has not had time pass in its media, and firing on the
    wall clock would report an absence in a stream that simply is not
    playing. So the window only elapses when other events carry the media
    clock past it.
    """
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(kind=ConditionKind.ABSENCE,
                                   window_seconds=5.0,
                                   pattern=error_pattern()))
    emit(LiveEventType.BROWSER_EVENT, media_ts=1.0, detector="browser:navigation")
    assert evaluate(trigger.trigger_id) == [], "fired before the window elapsed"

    # The media clock moves past the window with still no matching error.
    emit(LiveEventType.BROWSER_EVENT, media_ts=9.0, detector="browser:navigation")
    evaluate(trigger.trigger_id)
    firings = evaluate(trigger.trigger_id)
    assert len(firings) == 1
    assert firings[0].trace.get("absence") is True

    # And a matching event re-arms it: the thing we were waiting not to see
    # has now been seen.
    emit(media_ts=10.0)
    evaluate(trigger.trigger_id)
    assert evaluate(trigger.trigger_id) == []


# --- the boundary ------------------------------------------------------------


def test_a_firing_proposes_an_action_and_never_performs_one() -> None:
    """The strongest thing a trigger can do is ask."""
    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(pattern=error_pattern()),
        action=TriggerAction(kind="http_request", summary="restart the worker",
                             inputs={"url": "http://127.0.0.1:9/restart"},
                             requires_approval=True))
    emit()
    firings = evaluate(trigger.trigger_id)
    assert len(firings) == 1
    action = actions_db.get_action(firings[0].action_id)
    assert action is not None
    assert action.state.value == "awaiting_approval", (
        f"a trigger produced an action in state {action.state.value}")
    assert action.requires_approval is True


def test_redelivering_the_same_cause_proposes_one_action() -> None:
    """Exactly-once proposal, enforced by the idempotency key."""
    from watch_skill.triggers import db as trg_db

    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(pattern=error_pattern()),
        action=TriggerAction(kind="http_request", summary="restart",
                             inputs={"url": "http://127.0.0.1:9/restart"}))
    emit()
    first = evaluate(trigger.trigger_id)
    assert len(first) == 1

    # Rewind the cursor, exactly as a duplicate delivery or a crash-restart
    # replay would, and evaluate the same event again.
    state = trg_db.evaluation_state(trigger.trigger_id) or {}
    state["cursor_seq"] = 0
    trg_db.save_evaluation_state(trigger.trigger_id, state)
    second = evaluate(trigger.trigger_id)

    actions = [a for a in actions_db.list_actions(limit=100)
               if a.loop_id == trigger.trigger_id or a.proposed_by.endswith(
                   trigger.trigger_id)]
    ids = {a.action_id for a in actions}
    assert len(ids) == 1, f"a replayed event proposed {len(ids)} actions"
    if second:
        assert second[0].action_id == first[0].action_id


def test_evaluation_state_stays_bounded_over_a_long_session() -> None:
    """A trigger that ran all day must not have grown all day."""
    from watch_skill.triggers import db as trg_db

    trigger = create_trigger(
        session_id=SESSION,
        condition=TriggerCondition(kind=ConditionKind.COUNT, threshold=1000,
                                   window_seconds=3600.0,
                                   pattern=error_pattern()))
    for index in range(400):
        emit(media_ts=float(index))
        if index % 50 == 0:
            evaluate(trigger.trigger_id)
    evaluate(trigger.trigger_id)

    state = trg_db.evaluation_state(trigger.trigger_id) or {}
    hits = state.get("hits") or []
    assert len(hits) <= 256, f"evaluation state grew to {len(hits)} entries"


def test_explain_reports_what_matched_and_what_was_suppressed() -> None:
    trigger = create_trigger(session_id=SESSION, cooldown_seconds=3600.0,
                             condition=TriggerCondition(pattern=error_pattern()))
    emit(media_ts=1.0)
    evaluate(trigger.trigger_id)
    emit(media_ts=2.0)
    evaluate(trigger.trigger_id)

    report = explain(trigger.trigger_id)
    assert report["trigger"]["trigger_id"] == trigger.trigger_id
    assert report["firings"], "explain returned no history"
    assert report["suppressed"], "a suppressed match was not reported as one"
    assert report["evaluation"]["fire_count"] == 1
    assert report["evaluation"]["cursor_seq"] > 0


def test_a_condition_with_the_wrong_shape_is_refused_at_definition_time() -> None:
    with pytest.raises(ValueError, match="needs a pattern"):
        TriggerCondition(kind=ConditionKind.COUNT, pattern=None)
    with pytest.raises(ValueError, match="2 to"):
        TriggerCondition(kind=ConditionKind.SEQUENCE,
                         steps=(EventPattern(types=("error",)),))
