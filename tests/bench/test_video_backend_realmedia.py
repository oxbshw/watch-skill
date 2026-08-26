"""Locating a returned frame inside footage nobody authored a truth for.

The generated fixture can be graded because we drew it. Real footage cannot,
so the real-media path derives its ground truth from the file: decode the
window around a probe, find which of those frames came back. That shifts the
risk somewhere new — the instrument can now be *confidently wrong*, by
resolving a still shot to whichever frame happened to score best.

So the property defended here is not accuracy, it is honesty about
resolution: when several frames are indistinguishable the answer widens to an
interval and says `ambiguous`, and it never collapses to a single frame that
nothing actually distinguished.

Nothing here touches a downloaded video. The fixtures are the committed
generated ones, so these run anywhere.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from watch_skill.bench.video_backends.realmedia import (
    INDISTINGUISHABLE_MAE,
    FrameRef,
    build_probes,
    describe_media,
    digest_file,
    localize,
    mean_absolute_difference,
)
from watch_skill.bench.video_backends.runner import summarize_real_media

FIXTURES = Path(__file__).resolve().parents[2] / "benchmarks" / "video_backends" / "fixtures"
VISUAL = FIXTURES / "visual_events.mp4"


def _jpeg(path: Path, value: int, *, noise: int = 0) -> Path:
    """A small solid-colour JPEG, optionally with one corner perturbed."""
    from PIL import Image

    image = Image.new("RGB", (160, 90), (value, value, value))
    if noise:
        for x in range(40):
            for y in range(40):
                image.putpixel((x, y), (min(255, value + noise),) * 3)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, quality=95)
    return path


def _ref(position: int, pts: float, path: Path) -> FrameRef:
    return FrameRef(position=position, pts=pts, path=path,
                    sha256=digest_file(path))


# --- localization -----------------------------------------------------------


def test_a_byte_identical_frame_localizes_exactly(tmp_path) -> None:
    """The certain case: no inference, no tolerance, no ambiguity."""
    window = [
        _ref(0, 1.00, _jpeg(tmp_path / "a.jpg", 10)),
        _ref(1, 1.04, _jpeg(tmp_path / "b.jpg", 120)),
        _ref(2, 1.08, _jpeg(tmp_path / "c.jpg", 240)),
    ]
    returned = _jpeg(tmp_path / "got.jpg", 120)
    result = localize(returned, window, probe=1.02)

    assert result.matched and result.exact_byte_match
    assert result.best_pts == 1.04
    assert result.candidate_count == 1
    assert result.ambiguous is False
    assert result.uncertainty == 0.0
    assert result.signed_estimate == pytest.approx(0.02)


def test_a_still_shot_widens_the_answer_instead_of_guessing(tmp_path) -> None:
    """Frames nothing can tell apart must not be resolved to one of them."""
    window = [
        _ref(0, 2.00, _jpeg(tmp_path / "s0.jpg", 100)),
        _ref(1, 2.04, _jpeg(tmp_path / "s1.jpg", 100)),
        _ref(2, 2.08, _jpeg(tmp_path / "s2.jpg", 100)),
    ]
    # Same content, encoded separately — byte digests differ, pixels do not.
    returned = _jpeg(tmp_path / "still.jpg", 100)
    result = localize(returned, window, probe=2.02)

    assert result.matched
    assert result.ambiguous is True
    assert result.candidate_count == 3
    assert result.pts_low == 2.00 and result.pts_high == 2.08
    assert result.uncertainty and result.uncertainty > 0
    assert "still" in result.note


def test_a_moving_shot_resolves_to_one_frame(tmp_path) -> None:
    """The contrast case: real motion separates neighbours cleanly."""
    window = [
        _ref(0, 3.00, _jpeg(tmp_path / "m0.jpg", 20)),
        _ref(1, 3.04, _jpeg(tmp_path / "m1.jpg", 140)),
        _ref(2, 3.08, _jpeg(tmp_path / "m2.jpg", 250)),
    ]
    returned = _jpeg(tmp_path / "moving.jpg", 140, noise=3)
    result = localize(returned, window, probe=3.02)

    assert result.matched
    assert result.ambiguous is False
    assert result.best_pts == 3.04
    assert result.neighbour_separation is not None
    assert result.neighbour_separation > INDISTINGUISHABLE_MAE


def test_an_empty_window_is_unmatched_not_zero_error(tmp_path) -> None:
    returned = _jpeg(tmp_path / "x.jpg", 50)
    result = localize(returned, [], probe=1.0)
    assert result.matched is False
    assert result.signed_estimate is None
    assert result.abs_lower_bound is None


def test_untrustworthy_timestamps_refuse_to_produce_a_number(tmp_path) -> None:
    """A frame count that disagrees with the PTS list poisons every pairing."""
    window = [
        FrameRef(0, float("nan"), _jpeg(tmp_path / "n0.jpg", 10), "d0"),
        _ref(1, 1.04, _jpeg(tmp_path / "n1.jpg", 120)),
    ]
    result = localize(_jpeg(tmp_path / "got2.jpg", 120), window, probe=1.02)
    assert result.matched is False
    assert result.ambiguous is True
    assert "untrustworthy" in result.note


def test_a_rescaled_frame_still_localizes(tmp_path) -> None:
    """Scaling is not a mismatch — comparison happens at a common width.

    This matters beyond politeness to providers: Watch Skill's own extractor
    scales frames to 512 px, and the baseline is scored with this same
    machinery. A comparison that rejected a rescaled frame could not measure
    the local side at all.
    """
    from PIL import Image

    big = tmp_path / "big.jpg"
    Image.new("RGB", (320, 180), (100, 100, 100)).save(big, quality=95)
    window = [
        _ref(0, 1.0, _jpeg(tmp_path / "small_a.jpg", 100)),
        _ref(1, 1.04, _jpeg(tmp_path / "small_b.jpg", 220)),
    ]
    result = localize(big, window, probe=1.0)
    assert result.matched is True
    assert result.best_pts == 1.0


def test_an_incomparable_aspect_ratio_is_refused(tmp_path) -> None:
    """A frame that is not a rescale of the source cannot be scored at all."""
    from PIL import Image

    tall = tmp_path / "tall.jpg"
    Image.new("RGB", (90, 320), (100, 100, 100)).save(tall, quality=95)
    window = [_ref(0, 1.0, _jpeg(tmp_path / "wide.jpg", 100))]
    result = localize(tall, window, probe=1.0)
    assert result.matched is False
    assert "geometry" in result.note


def test_mean_absolute_difference_is_zero_for_identical_images(tmp_path) -> None:
    a = _jpeg(tmp_path / "i1.jpg", 77)
    b = _jpeg(tmp_path / "i2.jpg", 77)
    assert mean_absolute_difference(a, b) == pytest.approx(0.0, abs=0.5)
    c = _jpeg(tmp_path / "i3.jpg", 200)
    assert mean_absolute_difference(a, c) > 50


# --- probes -----------------------------------------------------------------


def test_probes_are_half_on_the_frame_grid_and_half_off_it() -> None:
    """A probe set of round numbers only answers the easy question."""
    media = {"duration_seconds": 100.0, "avg_frame_rate": 25.0}
    probes = build_probes(media, count=20)
    period = 1 / 25.0

    def on_grid(value: float) -> bool:
        return abs(value / period - round(value / period)) < 1e-6

    aligned = [p for p in probes if on_grid(p)]
    offset = [p for p in probes if not on_grid(p)]
    assert aligned and offset, "both kinds of probe are needed"
    assert len(offset) >= len(probes) // 3


def test_probes_are_whole_milliseconds_because_the_interface_is() -> None:
    """0.1.4 echoes the requested time as `round(seconds * 1000)` in a filename.

    Asking for 25.291666 s and comparing against 25.291666 s would charge the
    provider for our own rounding: it was only ever told 25.292. Probes are
    therefore generated on whole milliseconds so the time compared against is
    the time actually requested.
    """
    for fps in (25.0, 30.0, 60.0, 59.94):
        for probe in build_probes(
            {"duration_seconds": 300.0, "avg_frame_rate": fps}, count=16
        ):
            assert abs(probe * 1000 - round(probe * 1000)) < 1e-9, (fps, probe)


def test_probes_are_unique_and_inside_the_video() -> None:
    """0.1.4 rejects duplicate timestamps outright."""
    for fps in (25.0, 30.0, 60.0, 59.94):
        media = {"duration_seconds": 61.5, "avg_frame_rate": fps}
        probes = build_probes(media, count=30)
        assert len(probes) == len(set(probes)), fps
        assert all(0.0 <= p < 61.5 for p in probes), fps


def test_probes_cover_the_start_and_the_end() -> None:
    media = {"duration_seconds": 120.0, "avg_frame_rate": 30.0}
    probes = build_probes(media, count=20)
    assert min(probes) < 1.0
    assert max(probes) > 100.0


# --- summary ----------------------------------------------------------------


def _loc(probe: float, error: float | None, *, ambiguous: bool = False,
         matched: bool = True, exact: bool = False) -> dict:
    return {
        "probe": probe, "matched": matched, "exact_byte_match": exact,
        "ambiguous": ambiguous,
        "signed_estimate": error,
        "abs_lower_bound": None if error is None else (0.0 if ambiguous else abs(error)),
        "abs_upper_bound": None if error is None else abs(error),
    }


def test_ambiguous_probes_are_kept_out_of_the_timing_statistics() -> None:
    """Letting a still shot into the mean would invent precision."""
    media = {"duration_seconds": 10.0, "avg_frame_rate": 25.0}
    summary = summarize_real_media(
        [
            _loc(1.0, 0.0, exact=True),
            _loc(2.0, 0.02, exact=True),
            _loc(3.0, 0.5, ambiguous=True),
        ],
        media,
    )
    assert summary["resolved"] == 2
    assert summary["ambiguous_still_shot"] == 1
    assert summary["signed_stats"]["count"] == 2
    assert summary["signed_stats"]["max_abs"] == pytest.approx(0.02)


def test_a_probe_with_no_frame_is_counted_as_not_returned() -> None:
    media = {"duration_seconds": 10.0, "avg_frame_rate": 25.0}
    summary = summarize_real_media(
        [_loc(1.0, 0.0, exact=True), _loc(2.0, None, matched=False)], media
    )
    assert summary["returned"] == 1
    assert summary["not_returned"] == 1


def test_the_ceiling_rule_is_only_claimed_when_every_probe_obeys_it() -> None:
    media = {"duration_seconds": 10.0, "avg_frame_rate": 25.0}  # period 40 ms
    obeys = summarize_real_media(
        [_loc(1.0, 0.0), _loc(2.0, 0.02), _loc(3.0, 0.039)], media
    )
    assert obeys["rule_holds"] is True
    assert obeys["direction"]["early"] == 0

    breaks = summarize_real_media(
        [_loc(1.0, 0.0), _loc(2.0, -0.02), _loc(3.0, 0.02)], media
    )
    assert breaks["rule_holds"] is False
    assert breaks["direction"]["early"] == 1


def test_a_summary_with_nothing_resolved_reports_no_statistics() -> None:
    media = {"duration_seconds": 10.0, "avg_frame_rate": 25.0}
    summary = summarize_real_media([_loc(1.0, None, matched=False)], media)
    assert summary["signed_stats"] is None
    assert summary["rule_holds"] is False


# --- media description ------------------------------------------------------


@pytest.mark.skipif(not VISUAL.is_file(), reason="fixtures not generated")
def test_media_description_reads_the_file_not_the_manifest() -> None:
    media = describe_media(VISUAL)
    assert media["duration_seconds"] == pytest.approx(20.4, abs=0.05)
    assert media["avg_frame_rate"] == pytest.approx(50.0)
    assert media["variable_frame_rate"] is False
    assert len(media["sha256"]) == 64
    assert not math.isnan(media["duration_seconds"])
