"""Persistent temporal entities: what was true, and when we thought so.

The properties under test are the ones that make an entity store worth having
rather than a dictionary: history survives updates, a model cannot overwrite a
measurement, contradictions are recorded rather than resolved by silence, and
two processes observing the same thing converge on one entity.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from watch_skill.entities import (
    Confidence,
    EntityError,
    EntityKind,
    EvidenceLink,
    attribute_history,
    attributes_at,
    compile_context,
    conflicts_for,
    current_attributes,
    find_by_alias,
    get_entity,
    observe,
    resolve,
    state_at,
    state_now,
)
from watch_skill.entities.types import (
    MAX_ATTRIBUTE_LENGTH,
    MAX_ATTRIBUTES_PER_ENTITY,
    normalize_alias,
)

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


# --- identity ----------------------------------------------------------------


def test_the_same_thing_observed_twice_is_one_entity() -> None:
    first = observe(label="Order A-4417", attributes={"status": "failed"})
    second = observe(label="Order A-4417", attributes={"owner": "ops"})
    assert first["entity_id"] == second["entity_id"]
    assert first["created"] is True
    assert second["created"] is False


def test_aliases_resolve_to_the_same_entity() -> None:
    created = observe(label="Order A-4417", aliases=["A-4417", "order 4417"],
                      attributes={"status": "failed"})
    for alias in ("Order A-4417", "A-4417", "order 4417"):
        found = resolve(alias)
        assert found is not None and found.entity_id == created["entity_id"], alias


def test_alias_matching_folds_case_and_whitespace_but_not_punctuation() -> None:
    """Conservative on purpose.

    Merging "order-4417" with "order 4417" is a judgement about a domain
    Watch Skill knows nothing about, and a wrong merge is unrecoverable —
    two things' histories become one.
    """
    assert normalize_alias("  Order   A-4417 ") == "order a-4417"
    assert normalize_alias("ORDER a-4417") == normalize_alias("order  A-4417")
    assert normalize_alias("order-4417") != normalize_alias("order 4417")


def test_an_observation_without_a_label_is_refused() -> None:
    with pytest.raises(EntityError) as excinfo:
        observe(label="   ", attributes={"a": 1})
    assert excinfo.value.code == "entities.label_required"


# --- bi-temporal history -----------------------------------------------------


def test_an_update_closes_the_old_interval_rather_than_overwriting_it() -> None:
    created = observe(label="Widget", attributes={"status": "failed"})
    entity_id = created["entity_id"]
    time.sleep(0.02)
    observe(label="Widget", attributes={"status": "confirmed"})

    open_now = current_attributes(entity_id)
    assert len(open_now) == 1
    assert open_now[0].value == "confirmed"
    assert open_now[0].valid_to is None

    changes = attribute_history(entity_id, "status")
    assert [c.value for c in changes] == ["failed", "confirmed"]
    assert changes[0].valid_to is not None, "the old value was overwritten"
    assert changes[0].superseded_by == changes[1].attribute_id
    # The intervals must abut exactly: a gap would make a state-at-time query
    # in between return nothing, and an overlap would return two values.
    assert changes[0].valid_to == changes[1].valid_from


def test_state_at_a_past_instant_returns_what_was_believed_then() -> None:
    """The query the whole design exists for."""
    created = observe(label="Dashboard", attributes={"alert": "none"})
    entity_id = created["entity_id"]
    time.sleep(0.05)
    midpoint = time.time()
    time.sleep(0.05)
    observe(label="Dashboard", attributes={"alert": "disk full"})

    now = state_now(entity_id)
    assert now["attributes"][0]["value"] == "disk full"

    then = state_at(entity_id, midpoint)
    assert then["attributes"][0]["value"] == "none", (
        "a past query returned the present value")
    assert then["existed"] is True


def test_a_query_before_the_entity_existed_says_so_rather_than_raising() -> None:
    created = observe(label="Latecomer", attributes={"a": 1})
    before = state_at(created["entity_id"], time.time() - 3600)
    assert before["attributes"] == []
    assert before["existed"] is False


def test_re_observing_an_unchanged_value_does_not_grow_the_history() -> None:
    """Otherwise 'when did this actually change' becomes unanswerable."""
    created = observe(label="Steady", attributes={"status": "ok"})
    for _ in range(5):
        result = observe(label="Steady", attributes={"status": "ok"})
        assert result["attributes_unchanged"] == ["status"]
    assert len(attribute_history(created["entity_id"], "status")) == 1


def test_only_one_interval_is_ever_open_for_an_attribute() -> None:
    created = observe(label="Single", attributes={"x": 1})
    for value in range(2, 8):
        observe(label="Single", attributes={"x": value})
    open_rows = [a for a in attribute_history(created["entity_id"], "x")
                 if a.valid_to is None]
    assert len(open_rows) == 1, f"{len(open_rows)} values were current at once"


# --- conflicts ---------------------------------------------------------------


def test_a_model_cannot_overwrite_a_measurement() -> None:
    """The rule worth being strict about.

    A language model disagreeing with a DOM read is a fact about the model.
    Letting it win would make the store's contents whatever the model last
    hallucinated.
    """
    created = observe(label="Status", attributes={"text": "confirmed"},
                      confidence=Confidence.MEASURED, source="browser:dom")
    entity_id = created["entity_id"]

    result = observe(label="Status", attributes={"text": "probably failed"},
                     confidence=Confidence.INFERRED, score=0.99,
                     source="semantic:llava")

    assert current_attributes(entity_id)[0].value == "confirmed"
    assert result["attributes_written"] == []
    # And the disagreement is recorded, not discarded — it is a finding.
    assert result["conflicts"], "a contradiction was silently dropped"
    conflict = result["conflicts"][0]
    assert conflict["resolution"] == "inferred_cannot_override_deterministic"
    assert conflict["candidate_value"] == "probably failed"
    assert conflict["incumbent_value"] == "confirmed"
    assert conflicts_for(entity_id)


def test_a_measurement_supersedes_an_inference() -> None:
    created = observe(label="Reading", attributes={"count": 7},
                      confidence=Confidence.INFERRED, score=0.9)
    result = observe(label="Reading", attributes={"count": 9},
                     confidence=Confidence.MEASURED, source="browser:dom")
    assert current_attributes(created["entity_id"])[0].value == 9
    assert result["conflicts"][0]["resolution"] == "superseded"


def test_between_equal_kinds_the_higher_score_wins_and_ties_keep_incumbent() -> None:
    created = observe(label="Scored", attributes={"v": "a"},
                      confidence=Confidence.RECOGNIZED, score=0.6)
    entity_id = created["entity_id"]

    observe(label="Scored", attributes={"v": "b"},
            confidence=Confidence.RECOGNIZED, score=0.8)
    assert current_attributes(entity_id)[0].value == "b"

    # An equal-scoring rival does not churn the value: alternating between
    # two equally-supported readings produces a history that is pure noise.
    tie = observe(label="Scored", attributes={"v": "c"},
                  confidence=Confidence.RECOGNIZED, score=0.8)
    assert current_attributes(entity_id)[0].value == "b"
    assert tie["conflicts"][0]["resolution"] == "kept_incumbent"


# --- evidence and bounds -----------------------------------------------------


def test_every_attribute_carries_the_evidence_that_produced_it() -> None:
    created = observe(
        label="Cited", attributes={"status": "failed"},
        session_id="live_x", media_ts=12.5, source="browser:dom",
        evidence=[EvidenceLink(session_id="live_x", kind="frame",
                               artifact_id="frame_abc", media_ts=12.5,
                               event_seq=42)])
    attribute = current_attributes(created["entity_id"])[0]
    assert attribute.media_ts == 12.5
    assert attribute.source == "browser:dom"
    assert attribute.evidence[0].artifact_id == "frame_abc"
    assert attribute.evidence[0].event_seq == 42


def test_an_oversized_value_is_truncated_and_says_so() -> None:
    created = observe(label="Huge", attributes={"blob": "x" * 50_000})
    value = current_attributes(created["entity_id"])[0].value
    assert len(value) <= MAX_ATTRIBUTE_LENGTH + 20
    assert value.endswith("[truncated]"), "truncation was silent"


def test_the_attribute_count_is_capped_and_the_rejection_is_reported() -> None:
    payload = {f"attr_{i}": i for i in range(MAX_ATTRIBUTES_PER_ENTITY + 20)}
    result = observe(label="Sprawling", attributes=payload)
    assert len(result["rejected"]) >= 20
    assert result["rejected"][0]["reason"] == "attribute_limit"
    assert len(current_attributes(result["entity_id"])) <= MAX_ATTRIBUTES_PER_ENTITY


def test_compiled_context_is_bounded_and_prefers_measurements() -> None:
    """A prompt-bound summary must not silently eat a context window."""
    observe(label="Rich", attributes={f"m{i}": i for i in range(10)},
            confidence=Confidence.MEASURED)
    created = observe(label="Rich", attributes={f"g{i}": i for i in range(10)},
                      confidence=Confidence.INFERRED, score=0.5)

    context = compile_context(created["entity_id"], max_attributes=5)
    assert context["included"] == 5
    assert context["truncated"] is True
    assert context["total_attributes"] == 20
    # If something has to be dropped, the model's opinions go first.
    assert all(line.startswith("m") for line in context["lines"]), context["lines"]

    tight = compile_context(created["entity_id"], max_chars=40)
    assert tight["chars"] <= 40


# --- cross-session and cross-process ----------------------------------------


def test_an_entity_accumulates_the_sessions_it_was_seen_in() -> None:
    created = observe(label="Recurring", attributes={"a": 1},
                      session_id="live_one")
    observe(label="Recurring", attributes={"b": 2}, session_id="live_two")
    entity = get_entity(created["entity_id"])
    assert entity.sessions == ["live_one", "live_two"]
    assert entity.first_seen <= entity.last_seen


def test_entities_and_their_history_survive_the_process(
    isolated_settings: Path,
) -> None:
    """Written down, not remembered."""
    created = observe(label="Durable", attributes={"status": "failed"},
                      confidence=Confidence.MEASURED, source="browser:dom")
    time.sleep(0.02)
    midpoint = time.time()
    time.sleep(0.02)
    observe(label="Durable", attributes={"status": "confirmed"},
            confidence=Confidence.MEASURED, source="browser:dom")

    probe = isolated_settings.parent / "probe_entities.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.entities import resolve, state_now, state_at, history

        entity = resolve("Durable")
        print(json.dumps({{
            "entity_id": entity.entity_id,
            "now": [a["value"] for a in state_now(entity.entity_id)["attributes"]],
            "then": [a["value"] for a in
                     state_at(entity.entity_id, {midpoint!r})["attributes"]],
            "changes": [c["value"] for c in
                        history(entity.entity_id, "status")["changes"]],
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])

    assert payload["entity_id"] == created["entity_id"]
    assert payload["now"] == ["confirmed"]
    assert payload["then"] == ["failed"], (
        "a fresh process could not read the past state")
    assert payload["changes"] == ["failed", "confirmed"]


def test_concurrent_observers_converge_on_one_entity() -> None:
    """Two threads seeing the same thing must not create two entities."""
    import threading

    results: list[str] = []
    errors: list[str] = []

    def worker(index: int) -> None:
        try:
            results.append(observe(
                label="Contended", attributes={f"w{index}": index},
                session_id=f"live_{index}")["entity_id"])
        except Exception as exc:  # noqa: BLE001 - recorded and asserted below
            errors.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors[:3]
    assert len(set(results)) == 1, f"{len(set(results))} entities for one thing"
    assert find_by_alias("Contended") is not None


def test_a_state_at_query_matches_the_interval_boundaries_exactly() -> None:
    created = observe(label="Boundary", attributes={"v": "first"})
    entity_id = created["entity_id"]
    time.sleep(0.02)
    observe(label="Boundary", attributes={"v": "second"})

    changes = attribute_history(entity_id, "v")
    boundary = changes[0].valid_to

    # At the instant of the change the new value is already in force, and one
    # tick earlier the old one still is. Half-open intervals, so no instant
    # ever has two answers.
    assert [a.value for a in attributes_at(entity_id, boundary)] == ["second"]
    assert [a.value for a in attributes_at(entity_id, boundary - 0.001)] == ["first"]


def test_kind_is_upgraded_from_unknown_but_never_downgraded() -> None:
    created = observe(label="Typed", attributes={"a": 1})
    assert get_entity(created["entity_id"]).kind is EntityKind.UNKNOWN
    observe(label="Typed", attributes={"b": 2}, kind=EntityKind.UI_ELEMENT)
    assert get_entity(created["entity_id"]).kind is EntityKind.UI_ELEMENT
    observe(label="Typed", attributes={"c": 3}, kind=EntityKind.UNKNOWN)
    assert get_entity(created["entity_id"]).kind is EntityKind.UI_ELEMENT, (
        "a later unknown reading erased a known kind")
