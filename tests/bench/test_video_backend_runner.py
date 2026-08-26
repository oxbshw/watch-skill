"""The runner records what happened, including the parts that did not happen.

Two things are held here. First, the committed ground truth is internally
consistent — a manifest that contradicts itself would make every measurement
downstream meaningless, and it is cheap to keep checking. Second, a stage
that never ran is written down as a stage that never ran: not omitted, not
zeroed, not inferred from the stage before it.

The fake backends below stand in for the transport only. They prove the
runner's bookkeeping; nothing about Adversal is concluded from them.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from watch_skill.bench.video_backends.runner import (
    BenchmarkResult,
    load_manifest,
    run_pipeline,
    timestamp_semantics_finding,
    verify_fixture,
    write_raw,
)
from watch_skill.bench.video_backends.scoring import VisualTruth, judge_frame
from watch_skill.bench.video_backends.types import (
    BackendDescription,
    BackendFrame,
    Outcome,
    OutcomeStatus,
    TimestampSemantics,
)

FIXTURES = Path(__file__).resolve().parents[2] / "benchmarks" / "video_backends" / "fixtures"
pytestmark = pytest.mark.skipif(
    not (FIXTURES / "manifest.json").is_file(),
    reason="fixtures not generated — run benchmarks/video_backends/make_fixtures.py",
)


# --- ground truth -----------------------------------------------------------


def test_the_manifest_describes_a_timeline_with_no_holes_and_no_overlaps() -> None:
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    occurrences = fixture["occurrences"]
    assert occurrences[0]["start"] == 0.0
    for earlier, later in zip(occurrences, occurrences[1:], strict=False):
        assert earlier["end"] == pytest.approx(later["start"]), (
            "a gap or overlap would make 'the event on screen at T' ambiguous"
        )
    assert occurrences[-1]["end"] == pytest.approx(
        fixture["media"]["duration_seconds"]
    )


def test_every_occurrence_is_a_whole_number_of_frames() -> None:
    """'The cut is at 3.000 s' has to be true, not true to half a frame."""
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    fps = fixture["fps"]
    for occurrence in fixture["occurrences"]:
        for edge in ("start", "end"):
            frames = occurrence[edge] * fps
            assert frames == pytest.approx(round(frames), abs=1e-6), occurrence


def test_the_ground_truth_was_verified_against_the_encoded_video() -> None:
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    verification = fixture["verification"]
    assert len(verification["checks"]) == len(fixture["occurrences"])
    assert verification["worst_observed_drift"] <= verification[
        "tolerance_max_channel_drift"
    ]


def test_distinguishable_events_are_far_enough_apart_in_colour() -> None:
    """Identification must never come down to encoder noise."""
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    events = fixture["events"]
    drift = fixture["verification"]["worst_observed_drift"]
    closest = min(
        max(abs(a - b) for a, b in zip(events[x]["color"], events[y]["color"],
                                       strict=True))
        for x in events for y in events if x < y
    )
    assert closest > 2 * drift, (
        f"closest colour pair is {closest} apart but frames drift by {drift}"
    )


def test_the_perceptual_hash_channel_is_actually_independent() -> None:
    """Cards that hash alike make the cross-check a coin toss."""
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    separation = fixture["phash_separation"]
    assert separation["min_bits"] >= separation["required_min_bits"]
    assert separation["min_bits"] > 0


def test_the_fixture_exercises_every_property_it_claims() -> None:
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    claimed = set(fixture["properties"])
    tagged = {p for o in fixture["occurrences"] for p in o["properties"]}
    assert "frame-ladder" in tagged
    assert "short-lived" in tagged
    assert "near-duplicate" in tagged
    assert "boundary-start" in tagged and "boundary-end" in tagged
    assert "repeat-appearance" in tagged
    assert "frame-exact-ladder" in claimed

    repeated = [
        event for event in fixture["events"]
        if sum(1 for o in fixture["occurrences"] if o["event_id"] == event) > 1
    ]
    assert repeated, "no event appears twice — the repeat test would be vacuous"


def test_probe_timestamps_are_unique_and_inside_the_video() -> None:
    """0.1.4 rejects duplicate timestamps outright, so the list must be a set."""
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    probes = fixture["probe_timestamps"]
    assert len(probes) == len(set(probes))
    assert all(0 <= p < fixture["media"]["duration_seconds"] for p in probes)


def test_the_speech_fixture_has_known_non_overlapping_cues() -> None:
    manifest = load_manifest(FIXTURES)
    speech = manifest["fixtures"].get("speech_events")
    if speech is None:
        pytest.skip("speech fixture not generated (no system TTS voice)")
    cues = speech["cues"]
    assert cues[0]["start"] >= 1.0, "the fixture must open with silence"
    for earlier, later in zip(cues, cues[1:], strict=False):
        assert later["start"] > earlier["end"], "cues must not overlap"
    gaps = [
        round(later["start"] - earlier["end"], 3)
        for earlier, later in zip(cues, cues[1:], strict=False)
    ]
    assert min(gaps) <= 0.2, "no closely spaced pair — that property is untested"


def test_verify_fixture_notices_a_manifest_that_has_drifted(tmp_path) -> None:
    fixture = load_manifest(FIXTURES)["fixtures"]["visual_events"]
    tampered = {**fixture, "sha256": "0" * 64}
    report = verify_fixture(FIXTURES, tampered)
    assert report["present"] is True
    assert report["matches_manifest"] is False


def test_a_missing_fixture_is_reported_rather_than_assumed(tmp_path) -> None:
    report = verify_fixture(tmp_path, {"file": "nope.mp4", "sha256": "x"})
    assert report["present"] is False
    assert report["matches_manifest"] is False


# --- timestamp semantics ----------------------------------------------------


def _truth() -> VisualTruth:
    return VisualTruth(
        events={
            f"L{i}": {"label": f"L{i}", "color": [10 * i, 0, 0], "phash": "0" * 16}
            for i in range(5)
        },
        occurrences=[
            {"occurrence_id": f"o{i}", "event_id": f"L{i}",
             "start": round(i * 0.02, 3), "end": round((i + 1) * 0.02, 3)}
            for i in range(5)
        ],
        fps=50,
        duration=0.1,
    )


def _judge(requested: float, actual_rung: int):
    truth = _truth()
    return judge_frame(
        BackendFrame(
            index=0, timestamp_seconds=requested, requested_seconds=requested,
            semantics=TimestampSemantics.REQUESTED,
        ),
        truth,
        measured_color=(10 * actual_rung, 0, 0),
    )


def test_a_ceiling_extractor_is_identified_as_one() -> None:
    """Asked mid-frame, given the next frame: that is a ceiling, and it shows."""
    judgements = [_judge(0.01, 1), _judge(0.03, 2), _judge(0.05, 3)]
    finding = timestamp_semantics_finding(judgements, fps=50)
    assert finding["established"]
    assert finding["ceiling_matches"] == 3
    assert finding["floor_matches"] == 0
    assert "ceiling" in finding["rule"]


def test_a_floor_extractor_is_identified_as_one() -> None:
    judgements = [_judge(0.01, 0), _judge(0.03, 1), _judge(0.05, 2)]
    finding = timestamp_semantics_finding(judgements, fps=50)
    assert finding["floor_matches"] == 3
    assert finding["ceiling_matches"] == 0
    assert "floor" in finding["rule"]


def test_an_inconsistent_extractor_is_not_given_a_rule() -> None:
    """Half floor, half ceiling is not a semantics — say so."""
    judgements = [_judge(0.01, 0), _judge(0.03, 2), _judge(0.05, 3)]
    finding = timestamp_semantics_finding(judgements, fps=50)
    assert finding["semantics"].startswith("unknown")


def test_semantics_is_not_claimed_without_a_pinned_probe() -> None:
    finding = timestamp_semantics_finding([], fps=50)
    assert finding["established"] is False


# --- pipeline bookkeeping ---------------------------------------------------


class _RefusingBackend:
    """Answers the first call and never gets a second."""

    name = "fake"

    def __init__(self, status: OutcomeStatus) -> None:
        self.status = status
        self.calls: list[str] = []

    def describe(self) -> BackendDescription:
        return BackendDescription(
            name="fake", version="0.0.0", version_source="test", transport="none"
        )

    def submit(self, video, *, output_dir, timestamps=None, **options) -> Outcome:
        self.calls.append("submit")
        return Outcome(status=self.status, detail="refused")

    def poll(self, handle):  # pragma: no cover - must never be reached
        self.calls.append("poll")
        return Outcome(status=OutcomeStatus.OK)

    def fetch_frames(self, handle, *, output_dir):  # pragma: no cover
        self.calls.append("fetch_frames")
        return Outcome(status=OutcomeStatus.OK)

    def fetch_transcript(self, handle, *, output_dir):  # pragma: no cover
        self.calls.append("fetch_transcript")
        return Outcome(status=OutcomeStatus.OK)


@pytest.mark.parametrize("status", [
    OutcomeStatus.AUTH_REQUIRED,
    OutcomeStatus.QUOTA_EXHAUSTED,
    OutcomeStatus.INVALID_INPUT,
])
def test_a_refused_submit_leaves_later_stages_not_attempted(status, tmp_path) -> None:
    """Not zero, not failed — not attempted, which is a different fact."""
    backend = _RefusingBackend(status)
    record, transcript = run_pipeline(
        backend, tmp_path / "v.mp4", {"cues": []}, tmp_path
    )
    assert record["completed"] is False
    assert transcript is None
    assert backend.calls == ["submit"], "nothing may be called after a refusal"

    stages = {stage["stage"]: stage for stage in record["stages"]}
    assert stages["submit"]["status"] == status.value
    for later in ("poll", "extract_frames", "transcribe"):
        assert stages[later]["status"] == "not_attempted"
        assert status.value in stages[later]["reason"]


def test_a_submit_with_no_handle_does_not_proceed_on_a_guess(tmp_path) -> None:
    class _OkButNoHandle(_RefusingBackend):
        def submit(self, video, *, output_dir, timestamps=None, **options):
            self.calls.append("submit")
            return Outcome(status=OutcomeStatus.OK, provider_job_id=None)

    backend = _OkButNoHandle(OutcomeStatus.OK)
    record, _ = run_pipeline(backend, tmp_path / "v.mp4", {"cues": []}, tmp_path)
    assert record["completed"] is False
    assert backend.calls == ["submit"]


# --- raw output -------------------------------------------------------------


def test_the_raw_file_is_sanitized_on_the_way_out(tmp_path) -> None:
    home = str(Path.home())
    result = BenchmarkResult(
        started_at="2026-01-01T00:00:00+00:00",
        backend={"name": "x", "version": "0.1.4", "notes": [
            f"wrote to {home}/.adversal/jobs.json with api_key=sk-live-abcdef123456",
        ]},
    )
    destination = write_raw(result, tmp_path / "raw" / "benchmark.json")
    text = destination.read_text(encoding="utf-8")
    assert home not in text
    assert "sk-live-abcdef123456" not in text
    assert "<home>" in text
    # Still valid JSON, still a record.
    assert json.loads(text)["backend"]["version"] == "0.1.4"


def test_the_raw_file_round_trips_as_json(tmp_path) -> None:
    result = BenchmarkResult(started_at="2026-01-01T00:00:00+00:00")
    destination = write_raw(result, tmp_path / "benchmark.json")
    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert payload["schema"] == "watch-skill/video-backend-benchmark/1"
    assert payload["not_measured"] == []
