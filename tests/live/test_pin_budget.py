"""A pin is a promise to keep evidence. It has to be a finite one.

Eviction only removes unpinned segments, and nothing ever unpinned anything, so
a pin was permanent. A session that detects something every few seconds pins its
whole buffer, the retention window quietly stops applying, and the disk grows
for as long as the session runs.

The shape of the failure is what makes it worth a gate: it is invisible in the
ordinary case and unbounded in the interesting one. A quiet session pins little
and looks fine. A busy session -- the one worth watching, the one that produced
the events -- keeps everything, and the reason it is keeping so much is exactly
the reason there is so much of it.

Every test here writes rows into the buffer directly: no capture, no ffmpeg, no
timing. Each fails against the unbounded implementation.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec, LiveState


@pytest.fixture(autouse=True)
def _isolated(isolated_settings: Path):
    """Every test gets its own live database and media root."""
    return isolated_settings


def make_session() -> LiveSession:
    session = LiveSession(
        session_id=f"live_{uuid.uuid4().hex[:12]}",
        spec=LiveSourceSpec(kind=LiveSourceKind.SCREEN, target="test"),
        state=LiveState.RUNNING,
    )
    db.insert_session(session)
    return session


def add_frames(session_id: str, timestamps: list[float], size: int = 1024) -> None:
    """Write real files of a known size, so a byte budget means something."""
    frames_dir = buf.session_dir(session_id) / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for media_ts in timestamps:
        path = frames_dir / f"f_{media_ts:.3f}.jpg"
        path.write_bytes(b"\x00" * size)
        buf.record(session_id, "frame", path, media_ts)


def pinned_at(session_id: str) -> list[float]:
    """The media timestamps still held, oldest first."""
    return [segment.media_ts for segment in buf.pinned_frames(session_id)]


# --- the bound itself ---------------------------------------------------------


def test_a_quiet_session_keeps_everything_it_pins() -> None:
    """The ordinary case is untouched: a budget nobody reaches changes nothing."""
    session = make_session()
    add_frames(session.session_id, [1.0, 2.0, 3.0, 4.0, 5.0])

    buf.pin_window(session.session_id, 3.0, before=1.0, after=1.0)

    assert pinned_at(session.session_id) == [2.0, 3.0, 4.0]


def test_pinning_stops_growing_once_the_budget_is_reached() -> None:
    session = make_session()
    # Ten frames of 1 KiB, and room for four of them.
    add_frames(session.session_id, [float(n) for n in range(10)], size=1024)
    budget = 4 * 1024

    for moment in range(10):
        buf.pin_window(session.session_id, float(moment), before=0.0, after=0.0,
                       budget=budget)

    assert buf.pinned_bytes(session.session_id) <= budget, (
        "a busy session pinned its whole buffer, so retention stopped applying")


def test_the_newest_window_is_the_one_that_survives() -> None:
    """Oldest pins are released first: recent evidence is what a person asks for."""
    session = make_session()
    add_frames(session.session_id, [float(n) for n in range(10)], size=1024)
    budget = 3 * 1024

    for moment in range(10):
        buf.pin_window(session.session_id, float(moment), before=0.0, after=0.0,
                       budget=budget)

    held = pinned_at(session.session_id)
    assert held, "the budget released everything, including the moment just pinned"
    assert max(held) == 9.0, "the newest moment was released before older ones"


def test_the_moment_just_pinned_is_never_the_one_dropped() -> None:
    """Refusing to hold what just happened would be the wrong way round."""
    session = make_session()
    add_frames(session.session_id, [float(n) for n in range(6)], size=1024)

    # A budget smaller than a single window, so the bound is under maximum
    # pressure and the newest window still has to survive it.
    buf.pin_window(session.session_id, 5.0, before=0.0, after=0.0, budget=1)

    assert 5.0 in pinned_at(session.session_id)


def test_releasing_a_pin_is_not_deleting_it() -> None:
    """A released segment becomes ordinary buffer and ages out normally."""
    session = make_session()
    add_frames(session.session_id, [1.0, 2.0, 3.0], size=1024)

    buf.pin_window(session.session_id, 1.0, before=0.0, after=0.0, budget=10 * 1024)
    buf.release_oldest_pins(session.session_id, budget=0)

    frames_dir = buf.session_dir(session.session_id) / "frames"
    assert (frames_dir / "f_1.000.jpg").is_file(), "releasing a pin deleted the file"
    assert buf.resolve(session.session_id,
                       buf.frames_between(session.session_id, 0.5, 1.5)[0].artifact_id
                       ) is not None


def test_a_released_segment_can_then_be_evicted() -> None:
    """The whole point: what is released rejoins the retention window."""
    session = make_session()
    add_frames(session.session_id, [1.0, 2.0, 3.0], size=1024)
    buf.pin_window(session.session_id, 1.0, before=0.0, after=0.0, budget=10 * 1024)

    # Pinned, so retention cannot touch it.
    assert buf.evict(session.session_id, keep_seconds=1.0, now_media_ts=100.0) == 2

    buf.release_oldest_pins(session.session_id, budget=0)
    assert buf.evict(session.session_id, keep_seconds=1.0, now_media_ts=100.0) == 1


def test_pinned_bytes_reports_what_is_actually_held() -> None:
    session = make_session()
    add_frames(session.session_id, [1.0, 2.0, 3.0], size=2048)

    assert buf.pinned_bytes(session.session_id) == 0
    buf.pin_window(session.session_id, 2.0, before=1.0, after=1.0,
                   budget=buf.PIN_BUDGET_BYTES)
    assert buf.pinned_bytes(session.session_id) == 3 * 2048


def test_expired_segments_are_not_counted_against_the_budget() -> None:
    """A row whose file is gone holds no disk, so it may not crowd out one that does.

    The old frames are aged out first, which also settles the neighbouring
    question the wrong way round: evidence that has already expired cannot be
    pinned at all, and a budget that counted those rows would refuse to hold a
    live one on behalf of files that no longer exist.
    """
    session = make_session()
    add_frames(session.session_id, [1.0, 2.0, 3.0], size=1024)
    add_frames(session.session_id, [50.0], size=1024)

    # Age out the early frames, leaving the recent one live.
    assert buf.evict(session.session_id, keep_seconds=5.0, now_media_ts=51.0) == 3

    buf.pin_window(session.session_id, 50.0, before=0.0, after=0.0, budget=1024)
    assert pinned_at(session.session_id) == [50.0]
    assert buf.pinned_bytes(session.session_id) == 1024


def test_evidence_that_aged_out_cannot_be_pinned_afterwards() -> None:
    """Pinning is a promise about what is here, not a way to recall what is not."""
    session = make_session()
    add_frames(session.session_id, [1.0], size=1024)
    buf.evict(session.session_id, keep_seconds=1.0, now_media_ts=100.0)

    assert buf.pin_window(session.session_id, 1.0, before=0.0, after=0.0) == 0
    assert pinned_at(session.session_id) == []


def test_the_budget_has_a_default_and_it_is_finite() -> None:
    assert isinstance(buf.PIN_BUDGET_BYTES, int)
    assert 0 < buf.PIN_BUDGET_BYTES < 8 * 1024 * 1024 * 1024


def test_two_sessions_have_separate_budgets() -> None:
    """One noisy session may not evict another's evidence."""
    first = make_session()
    second = make_session()
    add_frames(first.session_id, [float(n) for n in range(6)], size=1024)
    add_frames(second.session_id, [1.0], size=1024)

    buf.pin_window(second.session_id, 1.0, before=0.0, after=0.0, budget=1024)
    for moment in range(6):
        buf.pin_window(first.session_id, float(moment), before=0.0, after=0.0,
                       budget=1024)

    assert pinned_at(second.session_id) == [1.0]
