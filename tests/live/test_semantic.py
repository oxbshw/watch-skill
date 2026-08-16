"""Semantic vision: select few frames, validate output, stay advisory."""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from watch_skill.live.semantic import (
    MAX_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
    DeterministicSemanticBackend,
    FrameCandidate,
    SelectionState,
    SemanticRuntime,
    build_semantic_backend,
    parse_observation,
    should_interpret,
)


def _candidate(media_ts: float, **kwargs) -> FrameCandidate:
    return FrameCandidate(path=Path("f.jpg"), media_ts=media_ts, **kwargs)


def _settle(runtime: SemanticRuntime, timeout: float = 10.0) -> None:
    """Wait until the queue is empty and no call is in flight.

    Interpretation moved onto one worker thread behind a queue, so polling
    `_inflight` alone races: immediately after `consider` the worker may not
    have picked the frame up yet, and the poll falls straight through.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        with runtime._lock:
            idle = not runtime._queue and not runtime._inflight
        if idle:
            return
        time.sleep(0.02)
    raise AssertionError("the semantic runtime never went idle")


# --- selection: the module's whole reason for existing -------------------------


def test_a_model_is_not_called_once_per_frame() -> None:
    """The property that makes live semantics affordable at all."""
    state = SelectionState()
    calls = 0
    for i in range(300):  # 30s of 10fps video
        decide, _ = should_interpret(
            _candidate(i * 0.1, scene_changed=True, visible_text=f"text {i}"),
            state, budget_remaining=1000,
        )
        calls += int(decide)
    assert calls <= 12, f"{calls} model calls for 30s of video"
    assert state.considered == 300


def test_the_cadence_floor_beats_every_interest_signal() -> None:
    """An agent asking repeatedly must not be a way around the floor."""
    state = SelectionState()
    assert should_interpret(_candidate(10.0, scene_changed=True), state, 100)[0]
    for offset in (0.1, 0.5, MIN_INTERVAL_SECONDS - 0.01):
        decide, reason = should_interpret(
            _candidate(10.0 + offset, question_pending=True, trigger_interest=True,
                       scene_changed=True),
            state, 100,
        )
        assert decide is False
        assert reason == "min_interval"


def test_a_static_screen_is_still_interpreted_eventually() -> None:
    """Reporting nothing for minutes is indistinguishable from being broken."""
    state = SelectionState()
    should_interpret(_candidate(0.0, scene_changed=True), state, 100)
    decide, reason = should_interpret(
        _candidate(MAX_INTERVAL_SECONDS + 1.0), state, 100
    )
    assert decide is True
    assert reason == "max_interval"


def test_an_unchanged_view_is_not_re_interpreted() -> None:
    """Two frames of a blinking cursor mean the same thing."""
    state = SelectionState()
    first = _candidate(0.0, text_changed=True, visible_text="Checkout total $125")
    assert should_interpret(first, state, 100)[0]
    state.last_signature = first.signature

    again = _candidate(5.0, text_changed=True, visible_text="checkout  TOTAL  $125 ")
    decide, reason = should_interpret(again, state, 100)
    assert decide is False
    assert reason == "unchanged_view"
    assert state.skipped_duplicate == 1


def test_a_question_earns_an_interpretation() -> None:
    state = SelectionState()
    decide, reason = should_interpret(
        _candidate(MIN_INTERVAL_SECONDS + 1e9), state, 100
    )
    assert decide is True  # max_interval also fires here
    state = SelectionState(last_interpreted_ts=0.0)
    decide, reason = should_interpret(
        _candidate(5.0, question_pending=True), state, 100
    )
    assert decide and reason == "question_pending"


def test_the_budget_stops_interpretation_and_says_so() -> None:
    """"Nothing changed" and "we ran out of money" must not look alike."""
    state = SelectionState()
    decide, reason = should_interpret(
        _candidate(100.0, scene_changed=True), state, budget_remaining=0
    )
    assert decide is False
    assert reason == "budget_exhausted"
    assert state.skipped_budget == 1


def test_an_unremarkable_frame_is_skipped_with_a_reason() -> None:
    state = SelectionState(last_interpreted_ts=0.0)
    decide, reason = should_interpret(_candidate(5.0), state, 100)
    assert decide is False
    assert reason == "no_change"


# --- schema validation --------------------------------------------------------


def test_well_formed_output_is_parsed() -> None:
    raw = ('{"scene": "a checkout page", "entities": ["total"], '
           '"actions": ["loading"], "ui_state": "error", "anomaly": "total is NaN", '
           '"uncertainty": "cannot read the tax line", "confidence": 0.8}')
    obs = parse_observation(raw, 5.0, provider="ollama", model="llava")
    assert obs.scene == "a checkout page"
    assert obs.anomaly == "total is NaN"
    assert obs.confidence == pytest.approx(0.8)
    assert obs.degraded is False


def test_json_wrapped_in_prose_is_still_parsed() -> None:
    """Models add preambles; refusing them would waste a good answer."""
    obs = parse_observation('Sure!\n```json\n{"scene": "a page"}\n```', 1.0)
    assert obs.scene == "a page"
    assert obs.degraded is False


def test_prose_instead_of_json_becomes_degraded_not_a_guess() -> None:
    obs = parse_observation("I think it is a checkout page.", 1.0)
    assert obs.degraded is True
    assert obs.degraded_reason == "no_json_in_response"
    assert obs.confidence == 0.0
    assert obs.scene == "", "a degraded reading must not invent an observation"


def test_broken_json_becomes_degraded() -> None:
    obs = parse_observation('{"scene": "a page",}', 1.0)
    assert obs.degraded is True
    assert "invalid_json" in obs.degraded_reason


def test_a_json_array_is_refused() -> None:
    obs = parse_observation('["a", "b"]', 1.0)
    assert obs.degraded is True
    assert obs.degraded_reason == "json_was_not_an_object"


def test_out_of_range_confidence_is_clamped_not_rejected() -> None:
    assert parse_observation('{"confidence": 5}', 1.0).confidence == 1.0
    assert parse_observation('{"confidence": -3}', 1.0).confidence == 0.0


def test_oversized_lists_are_capped() -> None:
    """A model returning fifty entities must not become fifty entities."""
    import json

    raw = json.dumps({"entities": [f"e{i}" for i in range(50)]})
    assert len(parse_observation(raw, 1.0).entities) <= 6


def test_a_string_where_a_list_was_asked_for_is_accepted() -> None:
    assert parse_observation('{"entities": "total"}', 1.0).entities == ["total"]


# --- output is advisory -------------------------------------------------------


def test_every_observation_is_marked_advisory_with_its_provenance() -> None:
    """A description of a picture must never read as a measurement of one."""
    payload = parse_observation('{"scene": "x"}', 1.0, provider="ollama",
                                model="llava").to_public()
    assert payload["advisory"] is True
    assert payload["provenance"]["kind"] == "model_inference"
    assert payload["provenance"]["provider"] == "ollama"


# --- the runtime --------------------------------------------------------------


def test_the_runtime_never_blocks_the_caller() -> None:
    """Capture must not wait on a model."""
    backend = DeterministicSemanticBackend(
        [{"start": 0, "end": 100, "scene": "slow"}], delay=1.5
    )
    runtime = SemanticRuntime(backend=backend, on_observation=lambda *_: None)
    started = time.monotonic()
    assert runtime.consider(_candidate(10.0, scene_changed=True, visible_text="a"))
    assert time.monotonic() - started < 0.3, "consider() blocked on the model"


def test_the_keyframe_queue_is_small_and_bounded() -> None:
    """Backpressure is a short queue, never an unbounded one."""
    backend = DeterministicSemanticBackend(
        [{"start": 0, "end": 1000, "scene": "x"}], delay=1.0
    )
    runtime = SemanticRuntime(backend=backend, on_observation=lambda *_: None,
                              queue_limit=2)
    # Far enough apart to clear the cadence floor every time, so what is being
    # measured is the queue and not the selector.
    accepted = [runtime.consider(
        _candidate(i * 10.0, scene_changed=True, visible_text=f"v{i}"))
        for i in range(6)]
    assert any(accepted), "nothing was ever queued"
    with runtime._lock:
        assert len(runtime._queue) <= 2, "the queue grew past its limit"
    stats = runtime.stats()
    assert stats["queue_limit"] == 2
    # Every frame that was selected and then not interpreted is accounted for.
    assert stats["dropped_queue_full"] + stats["dropped_superseded"] > 0
    assert all("dropped_because" in drop for drop in stats["drops"])


def test_a_more_informative_frame_takes_the_slot_and_the_loser_is_recorded() -> None:
    """When frames compete, the better one wins — visibly, not silently."""
    backend = DeterministicSemanticBackend(
        [{"start": 0, "end": 1000, "scene": "x"}], delay=1.0
    )
    runtime = SemanticRuntime(backend=backend, on_observation=lambda *_: None,
                              queue_limit=1)
    runtime.consider(_candidate(10.0, scene_changed=True, visible_text="a"))
    runtime.consider(_candidate(20.0, trigger_interest=True, visible_text="b"))
    # A waiting question outranks a bare trigger nudge, so it evicts it.
    runtime.consider(_candidate(30.0, question_pending=True, visible_text="c"))
    drops = runtime.stats()["drops"]
    assert any(d["dropped_because"] == "superseded_by_better_frame"
               for d in drops), f"no supersede recorded: {drops}"


def test_a_late_answer_is_published_as_evidence_not_discarded() -> None:
    """Lateness costs the present tense, never the evidence.

    The old contract dropped an out-of-order result outright. That threw away
    a true statement about a real frame for the sole crime of arriving after a
    newer one, which is exactly what makes a slow model useless.
    """
    from watch_skill.live.semantic import Freshness, SemanticObservation

    published: list[SemanticObservation] = []

    class Backend:
        name = "late"

        def interpret(self, frames, media_ts, question=""):
            return SemanticObservation(media_ts=media_ts, scene="an old frame")

    runtime = SemanticRuntime(
        backend=Backend(),
        on_observation=lambda obs, reason: published.append(obs),
    )
    # A newer reading has already been applied.
    runtime._latest_applied_ts = 50.0
    runtime.consider(_candidate(10.0, scene_changed=True, visible_text="old"))
    _settle(runtime)

    assert len(published) == 1, "the late observation was discarded"
    late = published[0]
    assert late.media_ts == 10.0
    assert late.superseded is True
    assert late.freshness == Freshness.STALE_FOR_ACTION
    assert late.may_trigger_current_state_action is False
    assert late.to_public()["freshness"] == "stale_for_action"


def test_a_failing_backend_opens_the_circuit_and_degrades() -> None:
    class Broken:
        name = "broken"

        def interpret(self, frames, media_ts, question=""):
            raise RuntimeError("provider exploded")

    runtime = SemanticRuntime(backend=Broken(), on_observation=lambda *_: None)
    for i in range(4):
        runtime.consider(_candidate(i * 10.0, scene_changed=True,
                                    visible_text=f"t{i}"))
        _settle(runtime)

    assert runtime.failures >= 3
    assert runtime.breaker.open
    assert runtime.status()["status"] == "degraded"
    assert runtime.consider(_candidate(100.0, scene_changed=True)) is False
    assert runtime.last_skip_reason == "circuit_open"


def test_no_backend_is_degraded_not_broken() -> None:
    runtime = SemanticRuntime(backend=None, on_observation=lambda *_: None)
    assert runtime.consider(_candidate(1.0, scene_changed=True)) is False
    assert runtime.status() == {"status": "degraded", "reason": "no_semantic_backend"}


def test_observations_reach_the_callback_with_their_reason() -> None:
    seen: list[tuple] = []
    runtime = SemanticRuntime(
        backend=DeterministicSemanticBackend(
            [{"start": 0, "end": 100, "scene": "a red error page",
              "anomaly": "the total shows NaN", "confidence": 0.9}]
        ),
        on_observation=lambda obs, reason: seen.append((obs, reason)),
    )
    runtime.consider(_candidate(10.0, scene_changed=True, visible_text="err"))
    deadline = time.time() + 5
    while not seen and time.time() < deadline:
        time.sleep(0.02)

    assert seen, "the observation never reached the callback"
    observation, reason = seen[0]
    assert observation.scene == "a red error page"
    assert observation.anomaly == "the total shows NaN"
    assert reason == "scene_change"
    assert observation.model == "deterministic-semantic", (
        "a fixture reading must name itself"
    )


def test_the_budget_is_enforced_across_calls() -> None:
    backend = DeterministicSemanticBackend([{"start": 0, "end": 999, "scene": "x"}])
    runtime = SemanticRuntime(backend=backend, on_observation=lambda *_: None,
                              budget=2)
    accepted = 0
    for i in range(10):
        if runtime.consider(_candidate(i * 10.0, scene_changed=True,
                                       visible_text=f"t{i}")):
            accepted += 1
        deadline = time.time() + 5
        while runtime._inflight and time.time() < deadline:
            time.sleep(0.01)
    assert accepted == 2
    assert runtime.budget_remaining == 0
    assert runtime.stats()["skipped_budget"] > 0


# --- policy -------------------------------------------------------------------


def test_semantics_are_off_unless_asked_for() -> None:
    """A feature that quietly starts spending is one nobody consented to."""
    assert build_semantic_backend(enabled=False) is None


def test_a_denied_egress_policy_yields_no_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from watch_skill.policy import Decision

    class Denying:
        def check(self, channel, provider=None):
            return Decision(allowed=False, channel=channel, reason="offline")

    monkeypatch.setattr("watch_skill.policy.get_policy", lambda: Denying())
    assert build_semantic_backend(enabled=True, provider="openai") is None


def test_a_permitted_policy_yields_a_provider_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from watch_skill.policy import Decision

    class Allowing:
        def check(self, channel, provider=None):
            return Decision(allowed=True, channel=channel, reason="ok")

    monkeypatch.setattr("watch_skill.policy.get_policy", lambda: Allowing())
    backend = build_semantic_backend(enabled=True, provider="ollama")
    assert backend is not None
    assert "ollama" in backend.name


# --- session integration ------------------------------------------------------


def test_a_live_session_publishes_advisory_semantic_events(
    state_change_clip: Path,
) -> None:
    from watch_skill.live import session as live_session

    session = live_session.start_live(str(state_change_clip), fps=2.0)
    runner = live_session.running_session(session.session_id)
    assert runner is not None
    # Inject rather than configure: the point is the event shape, and a real
    # provider is neither available nor desirable in the offline suite.
    from watch_skill.live.semantic import SemanticRuntime as RT

    published: list = []
    runner._semantic = RT(
        backend=DeterministicSemanticBackend(
            [{"start": 0, "end": 999, "scene": "a green ready screen",
              "confidence": 0.8}]
        ),
        on_observation=lambda obs, reason: (
            published.append(obs), runner._on_semantic(obs, reason)
        ),
    )
    try:
        deadline = time.monotonic() + 25
        events: list = []
        while time.monotonic() < deadline:
            events = [
                e for e in live_session.observe(session.session_id, limit=200)["events"]
                if e["detector"].startswith("semantic:")
            ]
            if events:
                break
            time.sleep(0.2)
        assert events, "no semantic event was published"
        event = events[0]
        assert event["provenance"] == "inference", (
            "a model reading must not be recorded as an observation"
        )
    finally:
        live_session.stop_live(session.session_id)


def test_semantic_status_appears_in_live_status(state_change_clip: Path) -> None:
    from watch_skill.live import session as live_session

    session = live_session.start_live(str(state_change_clip), fps=2.0)
    try:
        detectors = live_session.status(session.session_id)["detectors"]
        assert "semantic" in detectors
        assert detectors["semantic"]["status"] == "degraded"
        assert detectors["semantic"]["reason"] == "no_semantic_backend"
    finally:
        live_session.stop_live(session.session_id)

