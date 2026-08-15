"""The session clock: measure drift, do not assume it away."""
from __future__ import annotations

import time

import pytest

from watch_skill.live.clock import (
    DEFAULT_WINDOW,
    SessionClock,
    StreamClock,
    aligned_window,
    correlate,
)

# --- one stream ---------------------------------------------------------------


def test_a_stream_records_its_origin_once() -> None:
    clock = StreamClock(name="video")
    clock.observe(0.0, wall_ts=1000.0)
    clock.observe(1.0, wall_ts=1001.0)
    assert clock.first_media_ts == 0.0
    assert clock.first_wall_ts == 1000.0
    assert clock.samples == 2


def test_smooth_progress_is_not_a_discontinuity() -> None:
    clock = StreamClock(name="video")
    for i in range(20):
        assert clock.observe(i * 0.5, wall_ts=1000.0 + i * 0.5) is None
    assert clock.discontinuities == 0


def test_a_forward_jump_is_reported_as_a_gap() -> None:
    clock = StreamClock(name="video")
    clock.observe(0.0, wall_ts=1000.0)
    clock.observe(1.0, wall_ts=1001.0)
    assert clock.observe(6.0, wall_ts=1006.0) == "gap"
    assert clock.discontinuities == 1
    assert clock.gap_seconds == pytest.approx(5.0)


def test_a_backwards_jump_is_a_reset_not_a_gap() -> None:
    """A reconnect restarts the source's timeline; that is not lost time."""
    clock = StreamClock(name="stream")
    clock.observe(30.0, wall_ts=1030.0)
    assert clock.observe(0.0, wall_ts=1031.0) == "reset"
    assert clock.discontinuities == 1
    assert clock.gap_seconds == 0.0, "a reset must not be counted as a gap"


def test_lag_measures_media_falling_behind_the_wall_clock() -> None:
    clock = StreamClock(name="video")
    clock.observe(0.0, wall_ts=1000.0)
    clock.observe(5.0, wall_ts=1008.0)  # 5s of media took 8s of real time
    assert clock.lag_seconds == pytest.approx(3.0, abs=0.01)


def test_an_untouched_stream_reports_zero_rather_than_nonsense() -> None:
    clock = StreamClock(name="audio")
    assert clock.elapsed_media == 0.0
    assert clock.lag_seconds == 0.0


# --- two streams --------------------------------------------------------------


def test_drift_is_measured_between_the_streams() -> None:
    clock = SessionClock(session_id="s")
    clock.observe("video", 10.0)
    clock.observe("audio", 9.4)
    assert clock.drift_seconds() == pytest.approx(0.6, abs=0.001)
    assert clock.in_sync() is True


def test_audio_leading_video_is_negative_drift() -> None:
    clock = SessionClock(session_id="s")
    clock.observe("video", 5.0)
    clock.observe("audio", 6.5)
    assert clock.drift_seconds() < 0


def test_a_large_disagreement_is_reported_out_of_sync() -> None:
    clock = SessionClock(session_id="s")
    clock.observe("video", 20.0)
    clock.observe("audio", 5.0)
    assert clock.in_sync() is False


def test_a_missing_stream_is_unknown_drift_not_zero_drift() -> None:
    """Reporting zero would claim a synchronisation nobody measured."""
    clock = SessionClock(session_id="s")
    clock.observe("video", 10.0)
    assert clock.drift_seconds() is None
    assert clock.in_sync() is None


def test_the_clock_snapshot_names_both_streams() -> None:
    clock = SessionClock(session_id="s")
    clock.observe("video", 3.0)
    clock.observe("audio", 3.1)
    payload = clock.to_dict()
    assert set(payload["streams"]) == {"video", "audio"}
    assert payload["av_drift_seconds"] is not None
    assert payload["in_sync"] is True
    assert payload["sync_tolerance_seconds"] == DEFAULT_WINDOW


def test_wall_time_comes_from_the_session_origin() -> None:
    """Two streams disagreeing by milliseconds still map to one timeline."""
    clock = SessionClock(session_id="s", started_wall=1_700_000_000.0)
    assert clock.wall_for(12.5) == 1_700_000_012.5


# --- correlation --------------------------------------------------------------


class _Obs:
    def __init__(self, media_ts: float, tag: str) -> None:
        self.media_ts = media_ts
        self.tag = tag

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self.tag}@{self.media_ts}>"


def test_aligned_window_never_goes_negative() -> None:
    assert aligned_window(0.5, window=2.0) == (0.0, 2.5)


def test_correlation_returns_nearest_first() -> None:
    """The mechanism behind "what was visible when they said that"."""
    candidates = [_Obs(4.0, "far"), _Obs(7.1, "near"), _Obs(7.6, "mid")]
    hits = correlate(7.0, candidates, window=2.0)
    assert [h.tag for h in hits] == ["near", "mid"]


def test_correlation_excludes_anything_outside_the_window() -> None:
    candidates = [_Obs(0.0, "before"), _Obs(30.0, "after")]
    assert correlate(15.0, candidates, window=2.0) == []


def test_two_observations_inside_one_window_both_survive() -> None:
    candidates = [_Obs(6.5, "a"), _Obs(7.4, "b")]
    assert len(correlate(7.0, candidates, window=2.0)) == 2


def test_correlation_is_deterministic() -> None:
    """An operator must be able to reproduce the ranking by hand."""
    candidates = [_Obs(7.0 + i * 0.1, str(i)) for i in range(10)]
    first = [h.tag for h in correlate(7.35, candidates)]
    for _ in range(5):
        assert [h.tag for h in correlate(7.35, candidates)] == first


# --- integration with a live session ------------------------------------------


def test_a_live_session_publishes_its_clock(state_change_clip) -> None:
    from watch_skill.live import session as live_session

    session = live_session.start_live(str(state_change_clip), fps=2.0)
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            payload = live_session.status(session.session_id)
            if payload.get("clock", {}).get("streams", {}).get("video"):
                break
            time.sleep(0.1)
        clock = live_session.status(session.session_id)["clock"]
        assert clock["streams"]["video"]["samples"] > 0
        # No audio track on this fixture, so drift is unknown — not zero.
        assert clock["av_drift_seconds"] is None
    finally:
        live_session.stop_live(session.session_id)


def test_aligned_evidence_groups_by_stream(audiovisual_clip) -> None:
    from watch_skill.live import session as live_session
    from watch_skill.live.asr import DeterministicASR
    from watch_skill.live.types import LiveEventType

    session = live_session.start_live(
        str(audiovisual_clip), fps=2.0,
        asr_backend=DeterministicASR(
            [{"start": 0.0, "end": 14.0, "text": "the total is wrong"}]
        ),
    )
    try:
        deadline = time.monotonic() + 30
        anchor = None
        while time.monotonic() < deadline:
            events = live_session.observe(session.session_id, limit=200)["events"]
            speech = [e for e in events if e["type"] == LiveEventType.SPEECH.value]
            if speech:
                anchor = speech[0]["media_ts"]
                break
            time.sleep(0.1)
        assert anchor is not None, "no speech to anchor on"

        aligned = live_session.aligned_evidence(session.session_id, anchor,
                                                window=4.0)
        assert aligned["anchor_media_ts"] == pytest.approx(anchor, abs=0.01)
        assert aligned["count"] > 0
        assert "audio" in aligned["streams"], "the anchoring speech is missing"
    finally:
        live_session.stop_live(session.session_id)


def test_aligned_evidence_rejects_an_unknown_session() -> None:
    from watch_skill.live import session as live_session

    with pytest.raises(live_session.LiveError) as raised:
        live_session.aligned_evidence("live_nope", 1.0)
    assert raised.value.code == "live.session_not_found"
