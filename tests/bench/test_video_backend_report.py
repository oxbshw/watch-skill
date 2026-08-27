"""The report says only what was measured, and the verdict follows the gates.

A benchmark's last chance to mislead is the write-up. These hold the two
ways that happens: printing a number for a path that never ran, and letting
a verdict drift away from the gates that were supposed to decide it.

Determinism is tested too. The rendered report is committed next to the raw
JSON it came from, so "re-render and diff" has to be a real check rather
than a nice idea.
"""
from __future__ import annotations

import pytest

from watch_skill.bench.video_backends.report import VERDICTS, render
from watch_skill.bench.video_backends.runner import BenchmarkResult, evidence_matrix
from watch_skill.bench.video_backends.verdict import (
    CORE_EVIDENCE,
    GateResult,
    decide,
    evaluate,
)


def _healthy() -> BenchmarkResult:
    """A result in which every gate can pass — the control case."""
    result = BenchmarkResult(
        started_at="2026-01-01T00:00:00+00:00",
        finished_at="2026-01-01T00:05:00+00:00",
        environment={"os": "TestOS 1", "machine": "AMD64", "python": "3.11.15"},
        backend={
            "name": "test-backend", "version": "0.1.4",
            "version_source": "package metadata", "transport": "stdio",
            "server_name": "Test", "server_version": "1.0",
            "protocol_version": "2025-11-25", "tools": ["a", "b"], "notes": [],
        },
        fixture={
            "name": "visual_events", "present": True, "matches_manifest": True,
            "duration_seconds": 20.4, "fps": 50, "probe_count": 52,
            "occurrences": 40, "events": 39, "properties": ["hard-cuts"],
        },
        frame_identity={
            "total": 52, "correct": 52, "near_neighbour": 0, "wrong_event": 0,
            "unidentified": 0, "no_image": 0, "missing_expected": [],
            "duplicate_identities": {}, "exact_duplicate_files": {},
            "cross_event_duplicate_files": {}, "unexpected": [],
            "channel_agreement": {"colour_and_phash_agree": 52,
                                  "colour_and_phash_differ": 0},
            "correct_rate": 1.0,
        },
        frame_thresholds=[
            {"threshold_ms": 20, "within": 52, "outside": 0, "indeterminate": 0,
             "total": 52, "within_rate": 1.0}
        ],
        frame_resolved_stats={
            "count": 24, "signed_mean": 0.0, "mean_abs": 0.0, "median_abs": 0.0,
            "p95_abs": 0.0, "max_abs": 0.0, "min_abs": 0.0,
        },
        frame_resolved_count=24,
        timestamp_semantics={
            "established": True, "resolved_probes": 24, "floor_matches": 24,
            "ceiling_matches": 0,
            "rule": "the frame returned is the frame being displayed at the "
                    "requested time (floor)",
            "semantics": "decoded frame containing the requested time",
            "on_grid_probes": 24, "on_grid_correct": 24,
            "consequence": "exact at every probe.",
            "reported_timestamp_is": "the decoded presentation time",
        },
        ordering={
            "frames": 52, "timestamps_present": 52, "monotonic": True,
            "inversions": [], "duplicate_timestamps": {},
            "largest_gap_seconds": 2.25, "gap_after_index": 48,
            "identity_order_matches_time_order": True,
        },
        repeatability={
            "runs": 3, "frame_counts": [52, 52, 52], "frame_counts_stable": True,
            "timestamps_stable": True, "identities_stable": True,
            "ordering_stable": True, "transcript_texts_stable": True,
            "cue_counts": [0, 0, 0], "volatile_fields": ["request_id"],
            "differing_fields": [], "byte_identical_across_runs": True,
        },
        pipeline={"completed": True, "stages": []},
        transcript={
            "wer": 0.05, "reference_words": 100, "hypothesis_words": 99,
            "counts": {"substitutions": 3, "insertions": 1, "deletions": 1,
                       "hits": 96},
            "normalization": "lowercase; punctuation dropped",
            "cue_count_reference": 4, "cue_count_hypothesis": 4,
            "dropped_cues": [], "duplicate_cue_texts": {}, "out_of_order_cues": 0,
            "alignments": [], "start_stats": None, "end_stats": None,
            "midpoint_stats": None, "mean_overlap": 0.91,
            "transcript_source": "captions",
        },
        failures=[],
        latency={"video_duration_seconds": 20.4, "frames_requested": 52,
                 "exact_frame_path_median": 7.6, "realtime_factor": 0.37,
                 "mcp_calls": 24, "note": "one subprocess per call"},
        usage={"measured": {"processing_minutes_consumed": 0, "why": "nothing billed"},
               "provider_reported": None, "documented_pricing": None,
               "inferred": None},
        not_measured=[],
    )
    result.failures = [
        _probe("no_source", "invalid_input", classified=True),
        _probe("missing_file", "invalid_input", classified=True),
    ]
    return result


def _probe(name: str, status: str, *, classified: bool):
    from watch_skill.bench.video_backends.runner import FailureProbe

    return FailureProbe(
        name=name, intent="an invalid request", tool="process_video",
        arguments={}, status=status, latency_seconds=1.0,
        message_excerpt="Provide exactly one source", classified=classified,
    )


def _gates_for(result: BenchmarkResult):
    data = result.to_dict()
    rows = evidence_matrix({
        "frames_measured": bool(data.get("frame_identity")),
        "pipeline_completed": bool(data.get("pipeline", {}).get("completed")),
    })
    return evaluate(data, rows)


# --- gates ------------------------------------------------------------------


def test_a_clean_result_qualifies() -> None:
    verdict, reasons = decide(_gates_for(_healthy()))
    assert verdict == "QUALIFIED"
    assert reasons


def test_an_unmeasured_required_gate_blocks_qualification() -> None:
    """The discipline: not qualified because nobody ran the hard part."""
    result = _healthy()
    result.transcript = None
    result.pipeline = {"completed": False, "stages": []}

    gates = _gates_for(result)
    transcript_gate = next(g for g in gates if g.name == "transcript alignment usable")
    assert transcript_gate.result is GateResult.NOT_ESTABLISHED

    verdict, reasons = decide(gates)
    assert verdict == "NOT YET QUALIFIED"
    assert any("Not established" in reason for reason in reasons)


def test_a_wrong_frame_fails_the_identity_gate() -> None:
    result = _healthy()
    result.frame_identity["wrong_event"] = 3
    gates = _gates_for(result)
    gate = next(g for g in gates if g.name == "frame identity")
    assert gate.result is GateResult.FAIL
    assert decide(gates)[0] == "NOT YET QUALIFIED"


def test_pictures_out_of_order_fail_even_when_timestamps_rise() -> None:
    result = _healthy()
    result.ordering["identity_order_matches_time_order"] = False
    gates = _gates_for(result)
    gate = next(g for g in gates if g.name == "frame order integrity")
    assert gate.result is GateResult.FAIL


def test_run_to_run_evidence_drift_fails_determinism() -> None:
    result = _healthy()
    result.repeatability["differing_fields"] = ["frame_timestamps"]
    gates = _gates_for(result)
    gate = next(g for g in gates if g.name == "nondeterminism containable")
    assert gate.result is GateResult.FAIL


def test_an_invalid_request_answered_as_success_is_disqualifying() -> None:
    result = _healthy()
    result.failures = [_probe("no_source", "ok", classified=True)]
    gates = _gates_for(result)
    gate = next(g for g in gates
                if g.name == "failures do not masquerade as success")
    assert gate.result is GateResult.FAIL
    assert decide(gates)[0] == "NOT YET QUALIFIED"


def test_unstructured_errors_are_a_limitation_not_a_disqualification() -> None:
    """Prose that is plainly an error is milder than an error that looks OK."""
    result = _healthy()
    result.failures = [_probe("malformed_input", "unknown", classified=False)]
    gates = _gates_for(result)

    masquerade = next(g for g in gates
                      if g.name == "failures do not masquerade as success")
    distinguishable = next(g for g in gates
                           if g.name == "errors structurally distinguishable")
    assert masquerade.result is GateResult.PASS
    assert distinguishable.result is GateResult.FAIL
    assert distinguishable.required is False
    assert decide(gates)[0] == "QUALIFIED WITH LIMITATIONS"


def test_too_few_resolved_probes_leaves_timing_unestablished() -> None:
    """A bound computed from three samples is not a bound."""
    result = _healthy()
    result.frame_resolved_count = 2
    gates = _gates_for(result)
    gate = next(g for g in gates if g.name == "timestamp error bounded")
    assert gate.result is GateResult.NOT_ESTABLISHED


def test_every_gate_is_one_of_three_outcomes() -> None:
    for gate in _gates_for(_healthy()):
        assert gate.result in tuple(GateResult)
        assert gate.detail, f"{gate.name} must explain itself"
        assert gate.principle


def test_the_verdict_is_always_one_of_the_three_permitted_strings() -> None:
    for mutate in (
        lambda r: None,
        lambda r: r.frame_identity.__setitem__("wrong_event", 1),
        lambda r: setattr(r, "transcript", None),
        lambda r: setattr(r, "repeatability", {}),
    ):
        result = _healthy()
        mutate(result)
        assert decide(_gates_for(result))[0] in VERDICTS


# --- evidence matrix --------------------------------------------------------


def test_a_value_recovered_from_prose_is_never_called_native() -> None:
    """Regex over an English sentence is not an interface contract."""
    rows = evidence_matrix({"frames_measured": True, "pipeline_completed": True})
    by_name = {row["requirement"]: row for row in rows}
    for requirement in ("content identity", "provider-native IDs", "provenance"):
        assert by_name[requirement]["classification"] != "native", requirement
        assert by_name[requirement]["basis"]


def test_unmeasured_evidence_is_labelled_unmeasured_not_unavailable() -> None:
    """Two different claims: we could not look, versus it is not there."""
    rows = evidence_matrix({"frames_measured": False, "pipeline_completed": False})
    by_name = {row["requirement"]: row for row in rows}
    assert by_name["transcript"]["classification"].startswith("not measured")
    assert by_name["confidence"]["classification"] == "unavailable"


def test_the_core_evidence_set_is_what_a_backend_alone_can_supply() -> None:
    rows = {row["requirement"] for row in evidence_matrix({})}
    assert CORE_EVIDENCE <= rows
    # Watch Skill hashes the local file itself, so these are not the backend's
    # to provide and must not gate its qualification.
    assert "source identity" not in CORE_EVIDENCE
    assert "content identity" not in CORE_EVIDENCE


# --- rendering --------------------------------------------------------------


def test_rendering_is_deterministic() -> None:
    result = _healthy()
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    first = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    second = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert first == second
    assert first.endswith("\n")


def test_the_report_refuses_a_verdict_outside_the_three() -> None:
    result = _healthy()
    with pytest.raises(ValueError, match="verdict must be one of"):
        render(result, verdict="LOOKS GOOD TO ME", verdict_reasons=[])


def test_no_transcript_number_is_printed_when_no_transcript_was_obtained() -> None:
    """The failure mode that turns a gap into a claim."""
    result = _healthy()
    result.transcript = None
    result.pipeline = {"completed": False, "stages": []}
    result.not_measured = [
        {"path": "transcript accuracy", "reason": "no completed job"},
    ]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)

    assert "**Not measured in this run.**" in out
    # The fallback must not assert *why* the job was missing. An earlier
    # version blamed a missing account, which stayed in the report long after
    # the run was authenticated and every backend path had been exercised.
    assert "authenticated account" not in out
    assert "WER" not in out.split("## Failure semantics")[0].split("## Transcript")[1]
    assert "## What was not measured" in out
    assert "transcript accuracy" in out


def test_expected_but_undelivered_frames_are_named_in_the_report() -> None:
    result = _healthy()
    result.frame_identity["missing_expected"] = ["LADDER_00"]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert "LADDER_00" in out


def test_byte_duplicates_within_one_event_are_not_reported_as_a_defect() -> None:
    result = _healthy()
    result.frame_identity["exact_duplicate_files"] = {"aa": [1, 2], "bb": [3, 4]}
    result.frame_identity["cross_event_duplicate_files"] = {}
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    section = out.split("## Frame timestamp precision")[0]
    assert "the duplicate that would be a defect: **0**" in section
    assert "expected" in section


def test_the_report_carries_the_verdict_and_the_gate_table() -> None:
    result = _healthy()
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert f"**Verdict: {verdict}**" in out
    assert "## Qualification gates" in out
    for gate in gates:
        assert gate.name in out


def _real_sample(*, resolved: int, ambiguous: int, rule_holds: bool) -> dict:
    return {
        "label": "clip", "source": "clip.mp4", "source_kind": "local file",
        "media": {"duration_seconds": 356.0, "width": 1920, "height": 1080,
                  "avg_frame_rate": 25.0, "variable_frame_rate": False},
        "probes": [1.0, 2.0], "status": "auth_required", "frames_returned": 20,
        "wall_seconds": 31.2, "localizations": [],
        "summary": {
            "probes": resolved + ambiguous, "returned": resolved + ambiguous,
            "not_returned": 0, "localized_byte_exact": resolved,
            "ambiguous_still_shot": ambiguous, "resolved": resolved,
            "frame_period_seconds": 0.04,
            "signed_stats": {"count": resolved, "signed_mean": 0.02,
                             "mean_abs": 0.02, "median_abs": 0.02,
                             "p95_abs": 0.04, "max_abs": 0.04, "min_abs": 0.0},
            "thresholds": [{"threshold_ms": 50, "within": resolved, "outside": 0,
                            "indeterminate": ambiguous,
                            "total": resolved + ambiguous}],
            "direction": {"late": resolved, "early": 0, "exact": 0,
                          "within_one_frame_and_never_early": resolved},
            "rule_holds": rule_holds, "note": "derived from the file",
        },
        "detail": "",
    }


def test_real_footage_reports_ambiguity_rather_than_hiding_it() -> None:
    """A still shot that cannot be localized must be visible in the report."""
    result = _healthy()
    result.real_media = [_real_sample(resolved=14, ambiguous=6, rule_holds=True)]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)

    assert "## Real footage" in out
    assert "ambiguous (still shot) | 6" in out
    assert "localized byte-exactly | 14" in out
    assert "the same ceiling rule" in out


def test_real_footage_says_so_when_the_rule_does_not_hold() -> None:
    result = _healthy()
    result.real_media = [_real_sample(resolved=10, ambiguous=0, rule_holds=False)]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert "does **not** hold uniformly" in out


def test_a_real_sample_that_failed_is_named_not_dropped() -> None:
    result = _healthy()
    result.real_media = [{"label": "clip", "source_kind": "url",
                          "error": "RuntimeError: ffprobe is not on PATH"}]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert "Did not run" in out
    assert "ffprobe is not on PATH" in out


def test_real_footage_does_not_change_the_verdict_gates() -> None:
    """Real footage confirms; the gates were defined on the authored fixture.

    Letting a confirmatory sample move the verdict would be exactly the
    after-the-fact threshold-shifting the gates exist to prevent.
    """
    without = decide(_gates_for(_healthy()))[0]
    with_real = _healthy()
    with_real.real_media = [_real_sample(resolved=0, ambiguous=20, rule_holds=False)]
    assert decide(_gates_for(with_real))[0] == without


def test_the_report_regenerates_from_the_raw_json_it_was_written_from() -> None:
    """"Every number is reproducible from raw/" has to be checkable, not claimed.

    Re-render from the serialized result and require the bytes to match. This
    is what makes the committed RESULTS.md auditable months later without the
    provider, an account, or the fixtures.
    """
    import json

    from watch_skill.bench.video_backends.runner import result_from_raw

    original = _healthy()
    original.real_media = [_real_sample(resolved=14, ambiguous=6, rule_holds=True)]
    gates = _gates_for(original)
    verdict, reasons = decide(gates)
    first = render(original, verdict=verdict, verdict_reasons=reasons, gates=gates)

    revived = result_from_raw(json.loads(json.dumps(original.to_dict())))
    revived_gates = _gates_for(revived)
    revived_verdict, revived_reasons = decide(revived_gates)

    assert revived_verdict == verdict
    assert render(
        revived, verdict=revived_verdict, verdict_reasons=revived_reasons,
        gates=revived_gates,
    ) == first


def test_a_revived_result_serializes_back_to_the_same_json() -> None:
    import json

    from watch_skill.bench.video_backends.runner import result_from_raw

    payload = _healthy().to_dict()
    assert result_from_raw(json.loads(json.dumps(payload))).to_dict() == payload


def test_the_local_control_is_shown_beside_the_provider() -> None:
    """A stall is only a provider finding if the same machine could do it."""
    result = _healthy()
    sample = _real_sample(resolved=7, ambiguous=0, rule_holds=True)
    sample["status"] = "transport_error"
    sample["control"] = {"engine": "watch-skill", "requested": 16, "returned": 16,
                         "failed": 0, "wall_seconds": 6.5, "summary": {}}
    result.real_media = [sample]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)

    assert "Local control" in out
    assert "| frames delivered | 7 | 16 |" in out
    assert "## Reliability" in out
    assert "This source stalled" in out


def test_no_reliability_section_when_nothing_stalled() -> None:
    result = _healthy()
    result.real_media = [_real_sample(resolved=16, ambiguous=0, rule_holds=True)]
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    assert "## Reliability" not in out


def test_a_completed_run_never_claims_the_backend_was_unreachable() -> None:
    """The stale-text bug this test exists to prevent.

    The report carried sentences from an early unauthenticated pass — that no
    job reached the backend, that provider frames and transcripts went
    untested for want of an account — and kept printing them after the run
    that measured all of it. The generator read hardcoded strings instead of
    the result, so re-rendering could not fix it.
    """
    result = _healthy()
    result.pipeline = {"completed": True, "stages": [
        {"stage": "submit", "status": "ok"},
        {"stage": "extract_frames", "status": "ok"},
        {"stage": "transcribe", "status": "ok"},
    ]}
    result.head_to_head = {"usage": {
        "this_run_billed_minutes": 0.0, "lifetime_billed_minutes": 21.0,
        "lifetime_submitted_minutes": 19.18, "rounding_overhead_minutes": 1.82,
        "jobs_in_registry": 4, "remaining_after": 579.0,
    }}
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)

    for stale in (
        "no job reached the backend",
        "needed an authenticated account",
        "needs an authenticated session",
        "nothing was billed",
        "0 processing minutes",
    ):
        assert stale not in out, f"stale pre-auth text survived: {stale!r}"

    # And the cost figures must be the provider's own, not a hardcoded zero.
    assert "21 provider minutes" in out
    assert "19.18 minutes of source" in out
    assert "579" in out


def test_the_gates_intro_reflects_whether_gates_were_established() -> None:
    """It hardcoded "several of them need an authenticated run" regardless."""
    result = _healthy()
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    established = [g for g in gates if g.result.value != "not_established"]
    if len(established) == len(gates):
        assert "every gate had the evidence it needed" in out
        assert "need an authenticated run" not in out


def test_cost_columns_stay_separate_so_nothing_inferred_reads_as_measured() -> None:
    result = _healthy()
    gates = _gates_for(result)
    verdict, reasons = decide(gates)
    out = render(result, verdict=verdict, verdict_reasons=reasons, gates=gates)
    for label in ("| measured |", "| provider-reported |", "| documented pricing |",
                  "| inferred |"):
        assert label in out
