"""Temporal fusion: correlate deterministically, never state a guess as fact."""
from __future__ import annotations

import time

import pytest

from watch_skill.live.fusion import (
    EntityTrack,
    Inference,
    TemporalFuser,
    _rule_broken_value,
    _rule_error_appeared,
    _rule_number_vanished,
    _rule_spoken_about_visible,
)
from watch_skill.live.types import (
    EvidenceReference,
    LiveEvent,
    LiveEventType,
    StateChange,
    TemporalEntity,
)


def _event(
    seq: int, media_ts: float, kind: LiveEventType, summary: str = "",
    changes: list[StateChange] | None = None,
    entities: list[TemporalEntity] | None = None,
    detector: str = "test", final: bool = True,
) -> LiveEvent:
    return LiveEvent(
        session_id="s", seq=seq, media_ts=media_ts, wall_ts=time.time(),
        type=kind, summary=summary, detector=detector, final=final,
        state_changes=changes or [], entities=entities or [],
        evidence=[EvidenceReference(kind="frame", artifact_id=f"frame_{seq}",
                                    media_ts=media_ts)],
    )


# --- the rule that governs everything -----------------------------------------


def test_observation_and_inference_never_share_a_sentence() -> None:
    """The whole point of the module.

    "the coupon calculation failed" must never be quotable as though a camera
    had recorded it.
    """
    fuser = TemporalFuser(session_id="s")
    fused = fuser.fuse([
        _event(1, 5.0, LiveEventType.VISIBLE_TEXT_CHANGE, "text changed",
               changes=[StateChange(key="total", before="$125.00", after="NaN",
                                    media_ts=5.0)]),
    ])
    assert len(fused) == 1
    event = fused[0]
    assert "total" in event.observation
    assert "NaN" in event.observation
    # The hypothesis lives in its own list, scored and attributed.
    assert event.inferences
    assert all(i.confidence < 1.0 for i in event.inferences)
    assert all(i.basis.startswith("rule:") for i in event.inferences)
    for inference in event.inferences:
        assert inference.text not in event.observation


def test_an_inference_is_always_attributable() -> None:
    change = StateChange(key="total", before="$10", after="undefined")
    inference = _rule_broken_value(change)
    assert inference is not None
    assert inference.basis == "rule:broken_value"
    assert 0.0 < inference.confidence < 1.0


def test_the_public_shape_keeps_the_two_apart() -> None:
    fuser = TemporalFuser(session_id="s")
    payload = fuser.fuse([
        _event(1, 1.0, LiveEventType.VISIBLE_TEXT_CHANGE, "error 502 shown"),
    ])[0].to_public()
    assert "observation" in payload
    assert isinstance(payload["inferences"], list)
    for inference in payload["inferences"]:
        assert set(inference) == {"text", "confidence", "basis"}


# --- deterministic rules ------------------------------------------------------


def test_a_broken_value_is_recognised() -> None:
    for bad in ("NaN", "undefined", "null", "[object Object]"):
        result = _rule_broken_value(StateChange(key="total", before="$5", after=bad))
        assert result is not None, f"{bad} was not recognised"


def test_a_value_that_was_already_broken_is_not_a_new_finding() -> None:
    assert _rule_broken_value(
        StateChange(key="total", before="NaN", after="NaN")
    ) is None


def test_a_vanished_number_is_reported() -> None:
    result = _rule_number_vanished(StateChange(key="total", before="$125.00",
                                               after="unavailable"))
    assert result is not None
    assert result.confidence < 0.75


def test_an_http_status_sharpens_the_inference() -> None:
    server = _rule_error_appeared("Error: request failed with 502")
    assert server is not None
    assert "502" in server.text
    assert "server" in server.text

    client = _rule_error_appeared("error 404 not found")
    assert client is not None
    assert "request" in client.text


def test_ordinary_text_produces_no_error_inference() -> None:
    assert _rule_error_appeared("checkout total $125.00") is None


def test_shared_vocabulary_is_hedged_not_asserted() -> None:
    """Shared words are evidence of topic, not of cause."""
    result = _rule_spoken_about_visible(
        "the checkout total looks wrong", "checkout total NaN"
    )
    assert result is not None
    assert result.confidence <= 0.6
    assert "appears" in result.text


def test_one_shared_word_is_not_enough() -> None:
    assert _rule_spoken_about_visible("the weather today", "checkout total") is None


# --- correlation --------------------------------------------------------------


def test_events_close_in_time_become_one_account() -> None:
    fuser = TemporalFuser(session_id="s", window=2.0)
    fused = fuser.fuse([
        _event(1, 7.0, LiveEventType.SCENE_CHANGE, "scene changed"),
        _event(2, 7.2, LiveEventType.SPEECH, "the total is wrong"),
    ])
    assert len(fused) == 1, "correlated events were not joined"
    assert fused[0].type == "multimodal"
    assert "the total is wrong" in fused[0].observation
    assert "scene changed" in fused[0].observation


def test_events_far_apart_stay_separate() -> None:
    fuser = TemporalFuser(session_id="s", window=2.0)
    fused = fuser.fuse([
        _event(1, 1.0, LiveEventType.SCENE_CHANGE, "first"),
        _event(2, 30.0, LiveEventType.SCENE_CHANGE, "second"),
    ])
    assert len(fused) == 2


def test_a_fused_event_keeps_every_source_and_all_evidence() -> None:
    fuser = TemporalFuser(session_id="s", window=2.0)
    fused = fuser.fuse([
        _event(1, 5.0, LiveEventType.SCENE_CHANGE, "scene", detector="phash"),
        _event(2, 5.1, LiveEventType.VISIBLE_TEXT_CHANGE, "text", detector="ocr"),
        _event(3, 5.2, LiveEventType.SPEECH, "spoken", detector="whisper"),
    ])[0]
    assert set(fused.sources) == {"phash", "ocr", "whisper"}
    assert len(fused.evidence) == 3


def test_a_provisional_input_makes_the_account_provisional() -> None:
    """A citation must not be published against text that may still change."""
    fuser = TemporalFuser(session_id="s")
    fused = fuser.fuse([
        _event(1, 5.0, LiveEventType.SPEECH, "maybe this", final=False),
    ])[0]
    assert fused.provisional is True


def test_repeated_statements_are_said_once() -> None:
    """Correlated events restate each other; two copies read as two findings."""
    fuser = TemporalFuser(session_id="s", window=2.0)
    fused = fuser.fuse([
        _event(1, 5.0, LiveEventType.SCENE_CHANGE, "scene changed"),
        _event(2, 5.1, LiveEventType.SCENE_CHANGE, "scene changed"),
    ])[0]
    assert fused.observation.count("scene changed") == 1


def test_the_same_rule_firing_twice_is_one_hypothesis() -> None:
    fuser = TemporalFuser(session_id="s", window=3.0)
    change = [StateChange(key="total", before="$1", after="NaN")]
    fused = fuser.fuse([
        _event(1, 5.0, LiveEventType.VISIBLE_TEXT_CHANGE, "a", changes=change),
        _event(2, 5.5, LiveEventType.VISIBLE_TEXT_CHANGE, "b", changes=change),
    ])[0]
    texts = [i.text for i in fused.inferences]
    assert len(texts) == len(set(texts))


def test_session_markers_are_not_fused_into_findings() -> None:
    fuser = TemporalFuser(session_id="s")
    fused = fuser.fuse([
        _event(1, 0.0, LiveEventType.SESSION_STARTED, "started"),
        _event(2, 0.1, LiveEventType.SESSION_STOPPED, "stopped"),
    ])
    assert fused == []


def test_fusion_is_deterministic() -> None:
    events = [
        _event(1, 5.0, LiveEventType.SCENE_CHANGE, "scene"),
        _event(2, 5.3, LiveEventType.SPEECH, "spoken"),
        _event(3, 20.0, LiveEventType.VISIBLE_TEXT_CHANGE, "later"),
    ]
    first = [e.to_public() for e in TemporalFuser(session_id="s").fuse(events)]
    for _ in range(3):
        assert [e.to_public() for e in TemporalFuser(session_id="s").fuse(events)] == first


# --- entities -----------------------------------------------------------------


def test_an_entity_track_records_first_and_last_sighting() -> None:
    fuser = TemporalFuser(session_id="s")
    entity = TemporalEntity(entity_id="total", label="total", kind="text")
    fuser.fuse([
        _event(1, 2.0, LiveEventType.VISIBLE_TEXT_CHANGE, "a", entities=[entity]),
        _event(2, 9.0, LiveEventType.VISIBLE_TEXT_CHANGE, "b", entities=[entity]),
    ])
    track = fuser.tracks["total"]
    assert track.first_media_ts == 2.0
    assert track.last_media_ts == 9.0
    assert len(track.observations) == 2


def test_confidence_decays_with_staleness() -> None:
    """An entity last seen 30s ago is not evidence about now."""
    track = EntityTrack(entity_id="x", label="x", last_media_ts=10.0)
    assert track.decay(10.0) == pytest.approx(1.0, abs=0.01)
    assert track.decay(20.0) == pytest.approx(0.5, abs=0.01)
    assert track.decay(40.0) < 0.15


def test_a_stale_entity_drops_out_of_the_active_list() -> None:
    fuser = TemporalFuser(session_id="s")
    fuser.fuse([_event(1, 1.0, LiveEventType.VISIBLE_TEXT_CHANGE, "a",
                       entities=[TemporalEntity(entity_id="e", label="e")])])
    assert fuser.active_entities(1.0)
    assert fuser.active_entities(200.0) == []


def test_a_disappearance_is_recorded_rather_than_forgotten() -> None:
    """"Did X vanish?" must stay answerable after the fact."""
    fuser = TemporalFuser(session_id="s")
    fuser.fuse([
        _event(1, 1.0, LiveEventType.VISIBLE_TEXT_CHANGE, "a",
               entities=[TemporalEntity(entity_id="checkout", label="checkout")],
               changes=[StateChange(key="visible_text", before="",
                                    after="checkout total")]),
        _event(2, 5.0, LiveEventType.VISIBLE_TEXT_CHANGE, "b",
               changes=[StateChange(key="visible_text", before="checkout total",
                                    after="error page")]),
    ])
    vanished = {row["entity_id"] for row in fuser.vanished_entities()}
    assert "checkout" in vanished


def test_observation_history_is_bounded() -> None:
    """A live session runs for hours; per-entity history must not grow forever."""
    fuser = TemporalFuser(session_id="s")
    entity = TemporalEntity(entity_id="e", label="e")
    for i in range(300):
        fuser.observe_entities(
            _event(i, float(i), LiveEventType.VISIBLE_TEXT_CHANGE, entities=[entity])
        )
    assert len(fuser.tracks["e"].observations) <= 50


# --- session integration ------------------------------------------------------


def test_fuse_session_rejects_an_unknown_session() -> None:
    from watch_skill.live.fusion import fuse_session
    from watch_skill.live.session import LiveError

    with pytest.raises(LiveError) as raised:
        fuse_session("live_nope")
    assert raised.value.code == "live.session_not_found"


def test_fuse_session_joins_speech_and_vision(audiovisual_clip) -> None:
    from watch_skill.live import session as live_session
    from watch_skill.live.asr import DeterministicASR
    from watch_skill.live.fusion import fuse_session

    session = live_session.start_live(
        str(audiovisual_clip), fps=2.0,
        asr_backend=DeterministicASR(
            [{"start": 0.0, "end": 14.0, "text": "the error five oh two is showing"}]
        ),
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            events = live_session.observe(session.session_id, limit=200)["events"]
            if any(e["type"] == LiveEventType.SPEECH.value for e in events) and \
                    any(e["type"] == LiveEventType.SCENE_CHANGE.value for e in events):
                break
            time.sleep(0.1)
        report = fuse_session(session.session_id)
        assert report["count"] > 0
        assert report["raw_event_count"] > 0
        for event in report["events"]:
            assert "observation" in event
            assert isinstance(event["inferences"], list)
    finally:
        live_session.stop_live(session.session_id)


def test_an_inference_model_rejects_impossible_confidence() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Inference(text="x", confidence=1.5)
    with pytest.raises(ValidationError):
        Inference(text="x", confidence=-0.1)
