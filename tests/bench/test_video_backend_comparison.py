"""Head-to-head axes are only built where both sides really were measured.

A comparison table is the most quotable thing this benchmark produces, so it
is the most valuable place to be wrong. Two failures matter more than the
rest: inventing an axis where one side was never measured, and calling a tie
a win.

The chart is held to the same standard, because a picture that disagrees with
the table beside it is worse than no picture.
"""
from __future__ import annotations

import pytest

from watch_skill.bench.video_backends.chart import render_chart
from watch_skill.bench.video_backends.comparison import (
    Axis,
    SideResult,
    build_axes,
    reconcile_usage,
)


def _axis(
    ours: float | None,
    theirs: float | None,
    *,
    higher: bool = True,
    unit: str = "%",
) -> Axis:
    return Axis(
        name="test axis", question="?", higher_is_better=higher, unit=unit,
        sample="1 video",
        watch_skill=SideResult("watch_skill", ours, unit) if ours is not None else None,
        provider=SideResult("provider", theirs, unit) if theirs is not None else None,
    )


# --- verdicts ---------------------------------------------------------------


def test_equal_values_are_a_tie_not_a_win() -> None:
    """Both sides shelling out to the same ffmpeg must read as a tie."""
    assert _axis(100.0, 100.0).verdict == "tie"


def test_higher_wins_when_higher_is_better() -> None:
    assert _axis(90.0, 30.0).verdict == "watch_skill"
    assert _axis(30.0, 90.0).verdict == "provider"


def test_lower_wins_when_lower_is_better() -> None:
    """Error metrics must not be read upside down."""
    assert _axis(0.17, 0.85, higher=False).verdict == "watch_skill"
    assert _axis(0.85, 0.17, higher=False).verdict == "provider"


def test_a_missing_side_is_not_comparable_rather_than_a_walkover() -> None:
    assert _axis(90.0, None).verdict == "not_comparable"
    assert _axis(None, 90.0).verdict == "not_comparable"
    assert _axis(None, None).verdict == "not_comparable"


# --- axis construction ------------------------------------------------------


def test_no_axes_are_built_from_an_empty_result() -> None:
    assert build_axes({}) == []


def test_a_transcript_axis_needs_both_transcripts() -> None:
    """Ours measured, theirs absent: no axis, not a win by default."""
    data = {
        "head_to_head": {"transcript": {"wer": 0.0, "mean_overlap": 0.75,
                                        "start_stats": {"median_abs": 0.17}}},
        "transcript": None,
    }
    assert not [a for a in build_axes(data) if "Transcript" in a.name]


def _alignments(errors: list[float]) -> list[dict]:
    return [{"start_error": e} for e in errors]


def test_transcript_axes_appear_when_both_sides_ran() -> None:
    data = {
        "head_to_head": {"transcript": {
            "wer": 0.0, "mean_overlap": 0.747, "engine": "whisper-local (tiny)",
            "start_stats": {"median_abs": 0.171},
            "alignments": _alignments([-0.26, 0.171, 0.132, 0.273]),
        }},
        "transcript": {
            "wer": 0.0, "mean_overlap": 0.525,
            "start_stats": {"median_abs": 0.849},
            "alignments": _alignments([-1.0, -0.849, -1.148, -0.447]),
        },
    }
    names = {a.name: a for a in build_axes(data)}
    assert names["Transcript text accuracy"].verdict == "tie"
    assert names["Transcript interval alignment"].verdict == "watch_skill"


def test_cue_timing_is_a_hit_rate_so_taller_always_means_better() -> None:
    """A raw-error panel drew the worse system's bar on top.

    Inverting the bar instead would have made the geometry disagree with the
    number printed on it, so the axis became a hit rate: the same measurement,
    the right way up.
    """
    data = {
        "head_to_head": {"transcript": {
            "wer": 0.0, "mean_overlap": 0.747, "start_stats": {"median_abs": 0.171},
            "alignments": _alignments([-0.26, 0.171, 0.132, 0.273]),
        }},
        "transcript": {
            "wer": 0.0, "mean_overlap": 0.525, "start_stats": {"median_abs": 0.849},
            "alignments": _alignments([-1.0, -0.849, -1.148, -0.447]),
        },
    }
    axis = next(a for a in build_axes(data) if "Cue starts" in a.name)
    assert axis.higher_is_better is True
    assert axis.watch_skill.value == 100.0
    assert axis.provider.value == 25.0
    assert axis.verdict == "watch_skill"
    # The raw error is not lost — it moves into the note the report prints.
    assert "median" in axis.note.lower()
    assert "0.171" in axis.note and "0.849" in axis.note


def test_no_axis_in_the_chart_is_lower_is_better() -> None:
    """Every panel must read the same way: taller is better, always."""
    from watch_skill.bench.video_backends.comparison import build_axes as build

    data = {
        "head_to_head": {"transcript": {
            "wer": 0.0, "mean_overlap": 0.747, "start_stats": {"median_abs": 0.171},
            "alignments": _alignments([0.1, 0.2]),
        }},
        "transcript": {
            "wer": 0.1, "mean_overlap": 0.525, "start_stats": {"median_abs": 0.849},
            "alignments": _alignments([0.9, 1.1]),
        },
        "real_media": [{"summary": {"probes": 4, "returned": 1},
                        "control": {"returned": 4}}],
    }
    assert all(a.higher_is_better for a in build(data))


def test_frame_delivery_compares_the_provider_against_the_local_control() -> None:
    data = {"real_media": [
        {"summary": {"probes": 16, "returned": 7}, "control": {"returned": 16}},
        {"summary": {"probes": 16, "returned": 3}, "control": {"returned": 15}},
    ]}
    axis = next(a for a in build_axes(data) if "delivery" in a.name)
    # 10 of 32 and 31 of 32, rounded to one decimal by the builder.
    assert axis.provider.value == round(10 / 32 * 100, 1)
    assert axis.watch_skill.value == round(31 / 32 * 100, 1)
    assert axis.verdict == "watch_skill"
    assert "32 requested" in axis.sample


def test_written_analysis_axes_average_only_the_scored_videos() -> None:
    data = {"head_to_head": {"written_analysis": [
        {"video": "a", "watch_skill": {"grounded_rate": 0.89, "citations_per_100_words": 13.6},
         "provider": {"grounded_rate": 0.24, "citations_per_100_words": 0.0}},
        {"video": "b", "watch_skill": {"grounded_rate": 0.91, "citations_per_100_words": 12.9},
         "provider": {"grounded_rate": 0.31, "citations_per_100_words": 0.24}},
        {"video": "c", "error": "not indexed"},
    ]}}
    axes = {a.name: a for a in build_axes(data)}
    grounded = axes["Written analysis, groundedness"]
    assert grounded.watch_skill.value == pytest.approx(90.0, abs=0.1)
    assert grounded.provider.value == pytest.approx(27.5, abs=0.1)
    assert "2 video" in grounded.sample, "the unscored video must not be counted"


def test_frame_identity_axis_says_a_tie_is_expected(monkeypatch) -> None:
    """Same underlying tool on both sides — the note has to explain the tie."""
    data = {
        "frame_identity": {"total": 52, "wrong_event": 0, "unidentified": 0, "no_image": 0},
        "baseline": {"identity": {"total": 52, "wrong_event": 0, "unidentified": 0,
                                  "no_image": 0}},
    }
    axis = next(a for a in build_axes(data) if "Frame identity" in a.name)
    assert axis.verdict == "tie"
    assert "same ffmpeg" in axis.note


# --- usage ------------------------------------------------------------------


def test_usage_keeps_this_run_apart_from_lifetime_totals() -> None:
    """Mixing them produced negative rounding overhead — an impossible number.

    A re-run bills nothing, because submissions deduplicate on the MD5 of the
    bytes, so the per-run delta is zero while the lifetime total is not.
    Subtracting a cumulative figure from a delta is how that became -19.18
    minutes of "rounding" in the first version.
    """
    before = "remaining_minutes: 579\n  used_minutes: 21"
    after = "remaining_minutes: 579\n  used_minutes: 21"
    usage = reconcile_usage(before, after)
    assert usage["this_run_billed_minutes"] == pytest.approx(0.0)
    assert usage["lifetime_billed_minutes"] == pytest.approx(21.0)
    assert usage["remaining_after"] == pytest.approx(579.0)
    overhead = usage["rounding_overhead_minutes"]
    assert overhead is None or overhead >= 0, "billing cannot round downwards"


def test_usage_reports_nothing_rather_than_zero_when_quota_is_unreadable() -> None:
    usage = reconcile_usage("garbage", "also garbage")
    assert usage["this_run_billed_minutes"] is None
    assert usage["lifetime_billed_minutes"] is None
    assert usage["used_minutes_before"] is None


# --- chart ------------------------------------------------------------------


def test_the_chart_is_deterministic() -> None:
    axes = [_axis(90.0, 27.5), _axis(100.0, 100.0)]
    assert render_chart(axes, title="t") == render_chart(axes, title="t")


def test_the_chart_prints_every_value_it_draws() -> None:
    """Panels print the bare number and carry the unit under the name."""
    svg = render_chart([_axis(90.0, 27.5)], title="t")
    assert ">90<" in svg and ">27.5<" in svg
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")


def test_a_lower_is_better_panel_is_marked_rather_than_inverted() -> None:
    """Flipping the geometry would make the bar and its own label disagree."""
    svg = render_chart([_axis(0.171, 0.849, higher=False, unit="s (median)")])
    assert "lower is better" in svg
    assert ">0.171<" in svg and ">0.849<" in svg


def test_the_chart_describes_the_method_not_a_scoreline() -> None:
    """A count of who leads on how many axes reads as a league table.

    This is a preview of a days-old release measured on a handful of axes,
    several of which tie because both sides call the same tool. Printing
    "ahead on 5, behind on 0" would invite the count to be quoted as the
    finding instead of the numbers underneath it.
    """
    svg = render_chart([_axis(90.0, 27.5), _axis(100.0, 100.0), _axis(1.0, 9.0)])
    assert "same files" in svg and "same scorer" in svg
    assert "1 exact tie" in svg
    assert "ahead on" not in svg


def test_the_chart_labels_a_tie_as_a_tie() -> None:
    assert ">tie<" in render_chart([_axis(100.0, 100.0)])


def test_an_axis_missing_a_side_is_not_drawn() -> None:
    """A bar for a measurement that never happened is a lie in picture form."""
    svg = render_chart([_axis(90.0, None)])
    assert "No axis was measured on both sides" in svg


def test_the_chart_escapes_text_it_did_not_write() -> None:
    axis = _axis(1.0, 2.0)
    axis.name = "a <script>alert(1)</script> axis"
    svg = render_chart([axis])
    assert "<script>" not in svg
    assert "&lt;script&gt;" in svg
