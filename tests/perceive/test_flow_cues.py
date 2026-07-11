"""flow_cues — pinned timestamps that keep hue-only flow states visible.

Regression for the flagship browser demo's finding: a 3 s recording whose
only changes are color (blue button → gray, white total → red) collapsed
to ONE frame under grayscale phash dedup, so the critic passed a broken
flow. Cue frames are never deduped; these pins are how the loop critic
gets to see what it recorded.
"""
from __future__ import annotations

from watch_skill.perceive.budget import flow_cues


def test_short_recording_gets_dense_pins() -> None:
    cues = flow_cues(3.0)
    assert len(cues) >= 4, "a 3 s flow needs more than a frame or two"
    assert cues[0] > 0.0 and cues[-1] < 3.0
    steps = [b - a for a, b in zip(cues, cues[1:], strict=False)]
    assert max(steps) - min(steps) < 0.02, "pins are evenly spaced"


def test_rate_capped_at_2fps() -> None:
    assert len(flow_cues(30.0)) <= 20  # the default cap
    assert len(flow_cues(5.0, cap=10)) == 10


def test_zero_duration_yields_nothing() -> None:
    assert flow_cues(0.0) == []


def test_cues_cover_the_middle_not_just_edges() -> None:
    cues = flow_cues(4.0)
    assert any(1.0 < t < 3.0 for t in cues), (
        "the transient state lives mid-recording — pins must land there"
    )
