"""The video-backend scorer measures what it claims and refuses to guess.

These test the benchmark's own arithmetic, not the provider. A real
conclusion about Adversal comes only from a real run against the real 0.1.4
service; what is held here is that when such a run happens, the numbers
computed from it mean what the report says they mean.

The rules being defended, in order of how badly a break would mislead:

* An unresolvable measurement is reported as unresolved, never rounded into
  a pass or a fail.
* Missing evidence never scores as correct evidence.
* A frame's identity comes from pixels, so a right timestamp on a wrong
  picture is caught.
* Text normalization touches text and never touches a timestamp.
"""
from __future__ import annotations

import math

import pytest

from watch_skill.bench.video_backends.scoring import (
    DEFAULT_COLOR_TOLERANCE,
    FrameVerdict,
    TimingStats,
    VisualTruth,
    frame_identity_report,
    hamming,
    identify_by_color,
    identify_by_ocr,
    identify_by_phash,
    interval_overlap,
    judge_frame,
    normalize_words,
    ordering_report,
    percentile,
    threshold_report,
    transcript_report,
    word_edit_counts,
)
from watch_skill.bench.video_backends.types import (
    BackendCue,
    BackendFrame,
    TimestampSemantics,
)

FPS = 50
PERIOD = 1.0 / FPS


def _truth() -> VisualTruth:
    """A miniature fixture: two wide events and a three-rung frame ladder."""
    return VisualTruth(
        events={
            "A": {"label": "EVENT_A", "color": [200, 20, 20], "phash": "f" * 16},
            "B": {"label": "EVENT_B", "color": [20, 200, 20], "phash": "0" * 16},
            "L0": {"label": "LADDER_00", "color": [40, 40, 40], "phash": "1" * 16},
            "L1": {"label": "LADDER_01", "color": [40, 40, 140], "phash": "2" * 16},
            "L2": {"label": "LADDER_02", "color": [40, 140, 40], "phash": "3" * 16},
        },
        occurrences=[
            {"occurrence_id": "o0", "event_id": "A", "start": 0.0, "end": 1.0},
            {"occurrence_id": "o1", "event_id": "L0", "start": 1.0, "end": 1.02},
            {"occurrence_id": "o2", "event_id": "L1", "start": 1.02, "end": 1.04},
            {"occurrence_id": "o3", "event_id": "L2", "start": 1.04, "end": 1.06},
            {"occurrence_id": "o4", "event_id": "B", "start": 1.06, "end": 3.0},
            {"occurrence_id": "o5", "event_id": "A", "start": 3.0, "end": 4.0},
        ],
        fps=FPS,
        duration=4.0,
    )


def _frame(index: int, requested: float) -> BackendFrame:
    return BackendFrame(
        index=index,
        timestamp_seconds=requested,
        requested_seconds=requested,
        semantics=TimestampSemantics.REQUESTED,
    )


# --- percentiles ------------------------------------------------------------


def test_percentile_is_nearest_rank_and_returns_a_real_sample() -> None:
    """An interpolated p95 is a number no measurement produced."""
    values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    assert percentile(values, 50) == 5.0
    assert percentile(values, 95) == 10.0
    assert percentile(values, 100) == 10.0
    for pct in (1, 25, 50, 75, 95, 99):
        assert percentile(values, pct) in values


def test_percentile_of_nothing_is_not_a_number_not_zero() -> None:
    """Zero would read as a perfect score for a measurement never taken."""
    assert math.isnan(percentile([], 95))
    assert math.isnan(TimingStats.from_signed([]).p95_abs)
    assert TimingStats.from_signed([]).count == 0


def test_signed_mean_keeps_direction_that_absolute_stats_lose() -> None:
    """A consistent lag and random scatter must not look identical."""
    lag = TimingStats.from_signed([0.01] * 8)
    scatter = TimingStats.from_signed([0.01, -0.01] * 4)
    assert lag.mean_abs == scatter.mean_abs
    assert lag.signed_mean == pytest.approx(0.01)
    assert scatter.signed_mean == pytest.approx(0.0)


# --- identity ---------------------------------------------------------------


def test_a_colour_beyond_tolerance_is_unidentified_not_nearest() -> None:
    """Rounding an unrecognisable frame to the nearest event invents a result."""
    events = _truth().events
    found, drift = identify_by_color((200, 20, 20), events)
    assert found == "A" and drift == 0

    found, drift = identify_by_color((128, 128, 128), events)
    assert found is None, "a frame matching nothing must not be assigned an identity"
    assert drift > DEFAULT_COLOR_TOLERANCE


def test_the_near_duplicate_gap_survives_realistic_encoder_drift() -> None:
    """Twelve levels apart, three levels of drift: still unambiguous."""
    events = {
        "NEAR_A": {"label": "A", "color": [120, 120, 120], "phash": "0" * 16},
        "NEAR_B": {"label": "B", "color": [132, 120, 120], "phash": "1" * 16},
    }
    assert identify_by_color((123, 121, 119), events)[0] == "NEAR_A"
    assert identify_by_color((129, 119, 121), events)[0] == "NEAR_B"


def test_phash_and_ocr_are_opinions_not_the_verdict() -> None:
    events = _truth().events
    assert identify_by_phash("f" * 16, events) == ("A", 0)
    assert identify_by_ocr("junk EVENT_B junk", events) == "B"
    assert identify_by_ocr("nothing recognisable", events) is None
    assert identify_by_ocr(None, events) is None


def test_hamming_refuses_hashes_of_different_widths() -> None:
    with pytest.raises(ValueError, match="same width"):
        hamming("ff", "ffff")


def test_a_right_time_on_a_wrong_picture_is_caught() -> None:
    """The failure a metadata-only check cannot see."""
    truth = _truth()
    judgement = judge_frame(
        _frame(0, 0.5), truth, measured_color=(20, 200, 20)  # B's colour at A's time
    )
    assert judgement.expected_event_id == "A"
    assert judgement.actual_event_id == "B"
    assert judgement.verdict is FrameVerdict.WRONG_EVENT


def test_an_undelivered_frame_is_no_image_not_a_zero_score() -> None:
    truth = _truth()
    judgement = judge_frame(_frame(0, 0.5), truth, measured_color=None)
    assert judgement.verdict is FrameVerdict.NO_IMAGE
    assert judgement.actual_event_id is None
    assert judgement.abs_lower_bound is None, "no image means no error to report"


def test_one_frame_late_is_near_neighbour_and_pinned_exactly() -> None:
    """The ladder: identity resolves to a single frame, so error is exact."""
    truth = _truth()
    judgement = judge_frame(
        _frame(0, 1.01), truth, measured_color=(40, 40, 140)  # L1, asked inside L0
    )
    assert judgement.verdict is FrameVerdict.NEAR_NEIGHBOUR
    assert judgement.uncertainty == 0.0, "a one-frame occurrence pins the error"
    assert judgement.signed_estimate == pytest.approx(0.01)


def test_a_wide_event_yields_a_bound_not_a_point() -> None:
    """Two seconds of one card cannot become a millisecond figure."""
    truth = _truth()
    judgement = judge_frame(_frame(0, 2.0), truth, measured_color=(20, 200, 20))
    assert judgement.verdict is FrameVerdict.CORRECT
    assert judgement.uncertainty > 0.4, "the uncertainty must reflect the event's width"
    assert judgement.abs_lower_bound == 0.0


def test_a_repeated_event_is_attributed_to_the_nearer_appearance() -> None:
    """Charitable on purpose — it can only shrink the error we report."""
    truth = _truth()
    late = judge_frame(_frame(0, 3.5), truth, measured_color=(200, 20, 20))
    assert late.actual_interval == (3.0, 4.0)
    assert late.verdict is FrameVerdict.CORRECT

    early = judge_frame(_frame(0, 0.5), truth, measured_color=(200, 20, 20))
    assert early.actual_interval == (0.0, 1.0)


# --- thresholds -------------------------------------------------------------


def test_an_unresolvable_probe_is_indeterminate_not_within_and_not_outside() -> None:
    """Counting it either way would be a guess dressed as a rate."""
    truth = _truth()
    pinned = judge_frame(_frame(0, 1.01), truth, measured_color=(40, 40, 140))
    wide = judge_frame(_frame(1, 2.0), truth, measured_color=(20, 200, 20))

    rows = {row.threshold_ms: row for row in threshold_report([pinned, wide])}
    assert rows[20].within == 1 and rows[20].indeterminate == 1
    assert rows[20].outside == 0
    for row in rows.values():
        assert row.total == 2
        assert row.within + row.outside + row.indeterminate == row.total


def test_a_probe_provably_outside_a_threshold_is_counted_outside() -> None:
    truth = _truth()
    # Asked at 1.01 (inside L0), got L2 at 1.04 — two frames late, pinned.
    judgement = judge_frame(_frame(0, 1.01), truth, measured_color=(40, 140, 40))
    rows = {row.threshold_ms: row for row in threshold_report([judgement])}
    assert rows[20].outside == 1, "30 ms is provably outside a 20 ms threshold"
    assert rows[50].within == 1


# --- aggregation ------------------------------------------------------------


def test_duplicates_are_only_flagged_when_the_pictures_should_differ() -> None:
    """A static card genuinely produces identical frames; that is not a defect."""
    truth = _truth()
    same_event = [
        judge_frame(_frame(0, 1.5), truth, measured_color=(20, 200, 20)),
        judge_frame(_frame(1, 2.5), truth, measured_color=(20, 200, 20)),
    ]
    report = frame_identity_report(
        same_event, file_digests={0: "deadbeef", 1: "deadbeef"}
    )
    assert report.exact_duplicate_files, "the raw byte-identity is still recorded"
    assert not report.cross_event_duplicate_files, (
        "two probes inside one static event are expected to decode identically"
    )

    different = [
        judge_frame(_frame(0, 0.5), truth, measured_color=(200, 20, 20)),
        judge_frame(_frame(1, 2.5), truth, measured_color=(20, 200, 20)),
    ]
    report = frame_identity_report(different, file_digests={0: "cafe", 1: "cafe"})
    assert report.cross_event_duplicate_files, (
        "one picture returned for two events that look different is the real defect"
    )


def test_an_expected_event_that_never_came_back_is_named() -> None:
    truth = _truth()
    judgements = [judge_frame(_frame(0, 0.5), truth, measured_color=(200, 20, 20))]
    report = frame_identity_report(judgements, expected_event_ids=["A", "B"])
    assert report.missing_expected == ["B"]
    assert report.correct == 1


def test_identity_report_counts_every_frame_exactly_once() -> None:
    truth = _truth()
    judgements = [
        judge_frame(_frame(0, 0.5), truth, measured_color=(200, 20, 20)),
        judge_frame(_frame(1, 0.5), truth, measured_color=(20, 200, 20)),
        judge_frame(_frame(2, 0.5), truth, measured_color=(128, 128, 128)),
        judge_frame(_frame(3, 0.5), truth, measured_color=None),
    ]
    report = frame_identity_report(judgements)
    assert report.total == 4
    assert (report.correct + report.near_neighbour + report.wrong_event
            + report.unidentified + report.no_image) == 4


# --- ordering ---------------------------------------------------------------


def test_rising_timestamps_over_falling_pictures_is_reported() -> None:
    """The corruption that survives every metadata-only check."""
    truth = _truth()
    frames = [_frame(0, 0.5), _frame(1, 2.0)]
    judgements = [
        judge_frame(frames[0], truth, measured_color=(20, 200, 20)),   # B first
        judge_frame(frames[1], truth, measured_color=(200, 20, 20)),   # then A
    ]
    report = ordering_report(frames, judgements)
    assert report.monotonic, "the timestamps themselves are in order"
    assert report.identity_order_matches_time_order is False, (
        "the pictures went backwards and the report has to say so"
    )


def test_inverted_timestamps_are_counted_not_sorted_away() -> None:
    frames = [_frame(0, 2.0), _frame(1, 1.0), _frame(2, 3.0)]
    report = ordering_report(frames)
    assert not report.monotonic
    assert len(report.inversions) == 1
    assert report.inversions[0]["index_a"] == 0


def test_duplicate_timestamps_and_gaps_are_surfaced() -> None:
    frames = [_frame(0, 1.0), _frame(1, 1.0), _frame(2, 9.0)]
    report = ordering_report(frames)
    assert report.duplicate_timestamps == {"1.000000": 2}
    assert report.largest_gap_seconds == pytest.approx(8.0)


def test_frames_without_timestamps_are_excluded_not_treated_as_zero() -> None:
    frames = [
        BackendFrame(index=0, timestamp_seconds=None),
        _frame(1, 1.0),
    ]
    report = ordering_report(frames)
    assert report.frames == 2
    assert report.timestamps_present == 1


# --- transcript -------------------------------------------------------------


def test_normalization_matches_the_repository_s_stated_asr_rules() -> None:
    """Two implementations of one convention must not drift apart.

    The video-backend scorer restates the normalization written down in
    benchmarks/asr_accuracy.py so `src/` need not import from `benchmarks/`.
    This is what keeps that restatement honest.
    """
    import importlib.util
    import sys
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "benchmarks" / "asr_accuracy.py"
    spec = importlib.util.spec_from_file_location("_asr_accuracy_ref", path)
    assert spec and spec.loader
    reference = importlib.util.module_from_spec(spec)
    # `benchmarks/` is not a package, and the dataclasses in that module
    # resolve their annotations through sys.modules — registering it first is
    # what makes a by-path import of a script work at all.
    sys.modules[spec.name] = reference
    try:
        spec.loader.exec_module(reference)
    finally:
        sys.modules.pop(spec.name, None)

    for sample in (
        "The server returned error 502.",
        "It's a NaN, again!",
        "  spaced   out  ",
        "1234 and 0",
        "",
    ):
        assert normalize_words(sample) == reference.normalize(sample), sample

    ref, hyp = normalize_words("the total is 502"), normalize_words("the total is 503")
    assert word_edit_counts(ref, hyp) == reference.edit_distance(ref, hyp)


def test_digits_are_spelled_out_so_formatting_is_not_scored_as_error() -> None:
    assert normalize_words("error 502") == normalize_words("error five zero two")


@pytest.mark.parametrize("token", ["①", "٣", "²", "½", "Ⅶ"])
def test_digit_like_characters_do_not_crash_the_normalizer(token: str) -> None:
    """`str.isdigit()` is true for far more than 0-9.

    Found the hard way: OCR lifted a circled digit off a slide in a real
    video and the spelling table, which only holds ASCII, raised KeyError in
    the middle of scoring. Non-ASCII digit-likes are left as their own token
    rather than spelled out — the mapping to English words only exists for
    ASCII, and inventing one would be worse than leaving the character alone.
    """
    words = normalize_words(f"value {token} here")
    assert "value" in words and "here" in words


def test_edit_counts_separate_dropping_words_from_inventing_them() -> None:
    counts = word_edit_counts(["a", "b", "c"], ["a", "c"])
    assert counts["deletions"] == 1 and counts["insertions"] == 0
    counts = word_edit_counts(["a", "c"], ["a", "b", "c"])
    assert counts["insertions"] == 1 and counts["deletions"] == 0


def test_interval_overlap_is_iou_and_zero_when_disjoint() -> None:
    assert interval_overlap((0.0, 2.0), (0.0, 2.0)) == 1.0
    assert interval_overlap((0.0, 2.0), (3.0, 4.0)) == 0.0
    assert interval_overlap((0.0, 2.0), (1.0, 3.0)) == pytest.approx(1 / 3)


def test_a_dropped_cue_is_named_and_never_silently_absorbed() -> None:
    reference = [
        {"cue_id": "c0", "start": 0.0, "end": 1.0, "text": "hello there"},
        {"cue_id": "c1", "start": 2.0, "end": 3.0, "text": "goodbye now"},
    ]
    report = transcript_report(
        reference, [BackendCue(index=0, start=0.0, end=1.0, text="hello there")]
    )
    assert report.dropped_cues == ["c1"]
    assert report.counts["deletions"] == 2
    assert report.wer == pytest.approx(0.5)


def test_timing_is_scored_on_raw_numbers_while_text_is_normalized() -> None:
    """Normalizing a timestamp would be scoring our own arithmetic."""
    reference = [{"cue_id": "c0", "start": 1.0, "end": 2.0, "text": "error 502"}]
    report = transcript_report(
        reference,
        [BackendCue(index=0, start=1.25, end=2.25, text="Error five zero two!")],
    )
    assert report.wer == 0.0, "punctuation and digit spelling must not count as errors"
    assert report.alignments[0].start_error == pytest.approx(0.25)
    assert report.alignments[0].end_error == pytest.approx(0.25)
    assert report.alignments[0].midpoint_error == pytest.approx(0.25)


def test_duplicate_and_out_of_order_cues_are_reported() -> None:
    reference = [{"cue_id": "c0", "start": 0.0, "end": 1.0, "text": "one"}]
    report = transcript_report(reference, [
        BackendCue(index=0, start=2.0, end=3.0, text="one"),
        BackendCue(index=1, start=0.0, end=1.0, text="one"),
    ])
    assert report.duplicate_cue_texts == {"one": 2}
    assert report.out_of_order_cues == 1


def test_an_empty_transcript_scores_as_total_loss_not_as_absent_data() -> None:
    reference = [{"cue_id": "c0", "start": 0.0, "end": 1.0, "text": "one two three"}]
    report = transcript_report(reference, [])
    assert report.wer == pytest.approx(1.0)
    assert report.dropped_cues == ["c0"]
    assert report.transcript_source is None
