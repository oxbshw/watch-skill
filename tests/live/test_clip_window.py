"""Waiting for a clip window, and knowing when waiting cannot help.

Four callers wanted "a clip around this moment" and four had written the same
loop to get it: wait until the *newest* buffered frame passes the far edge of
the window, then stitch. That is not the condition they needed. It is the
condition under which the answer stops being able to change — every frame
captured afterwards has a larger media timestamp, so once the newest is past
the end of the window, a window that is still short is short for good.

Read as success, it fails in exactly one direction and only on fast machines:
if the source starts slowly, the very first frame can arrive already past the
far edge. The wait then returns immediately, the clip is requested over a
range that was never captured, and the builder returns ``None`` with no reason.
A slower machine captures a frame before the moment and everything passes, so
the defect presents as a flaky test rather than as the missing evidence it is.

Every test here is built from rows written directly into the buffer: no
browser, no ffmpeg, no timing. Each one fails against the old implementation,
and the assertions say which of the three causes applies, because "no clip" and
"no clip because capture began after the moment" send a reader to different
places.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec, LiveState


@pytest.fixture(autouse=True)
def _isolated(isolated_settings: Path):
    """Every test gets its own live database and media root."""
    return isolated_settings


def make_session(state: LiveState = LiveState.RUNNING) -> LiveSession:
    session = LiveSession(
        session_id=f"live_{uuid_suffix()}",
        spec=LiveSourceSpec(kind=LiveSourceKind.SCREEN, target="test"),
        state=state,
    )
    db.insert_session(session)
    return session


def uuid_suffix() -> str:
    import uuid

    return uuid.uuid4().hex[:12]


def add_frames(session_id: str, timestamps: list[float]) -> list[Path]:
    """Write real (tiny) files, because a row whose file is gone is not usable."""
    written = []
    frames_dir = buf.session_dir(session_id) / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for media_ts in timestamps:
        path = frames_dir / f"f_{media_ts:.3f}.jpg"
        path.write_bytes(b"\xff\xd8\xff\xd9")
        buf.record(session_id, "frame", path, media_ts)
        written.append(path)
    return written


# --- the condition itself -----------------------------------------------------


def test_a_usable_window_returns_its_frames_and_no_reason() -> None:
    session = make_session()
    add_frames(session.session_id, [1.0, 1.5, 2.0, 2.5, 3.0])

    frames, why = buf.await_clip_window(session.session_id, 1.0, 3.0, timeout=1.0)

    assert why is None
    assert [round(f.media_ts, 2) for f in frames] == [1.0, 1.5, 2.0, 2.5, 3.0]


def test_a_delayed_first_frame_is_named_rather_than_waited_out() -> None:
    """The regression, stated directly.

    Capture began at 5.0 and the moment is at 0.7. The old loop saw a newest
    frame of 8.0, decided the window was ready, and handed back nothing. There
    is no amount of waiting that helps, and the message has to say so or the
    reader will go and raise the buffer setting, which also will not help.
    """
    session = make_session()
    add_frames(session.session_id, [5.0, 5.5, 6.0, 8.0])

    started = time.monotonic()
    frames, why = buf.await_clip_window(session.session_id, -2.3, 3.7, timeout=30.0)
    elapsed = time.monotonic() - started

    assert frames == []
    assert why is not None
    assert "no frame was ever captured" in why
    assert "5.00s" in why, f"the reason does not say when capture began: {why}"
    # It must not burn the timeout discovering something already knowable.
    assert elapsed < 2.0, f"waited {elapsed:.1f}s for an answer that was final"


def test_an_evicted_window_is_a_different_sentence_from_an_uncaptured_one() -> None:
    """A setting can fix one of these and cannot fix the other."""
    session = make_session()
    add_frames(session.session_id, [1.0, 1.5, 2.0, 9.0, 9.5])
    # Sweep everything older than 5s relative to a newest of 9.5.
    buf.evict(session.session_id, keep_seconds=5.0, now_media_ts=9.5)

    frames, why = buf.await_clip_window(session.session_id, 1.0, 2.0, timeout=1.0)

    assert frames == []
    assert why is not None
    assert "evicted" in why
    assert "buffer window is shorter" in why


def test_a_window_with_one_frame_says_stitching_needs_two() -> None:
    session = make_session()
    add_frames(session.session_id, [1.0, 9.0])

    frames, why = buf.await_clip_window(session.session_id, 0.8, 1.2, timeout=1.0)

    assert len(frames) == 1
    assert why is not None and "at least two" in why


# --- the four terminations ----------------------------------------------------


def test_it_waits_while_frames_may_still_land_in_the_window() -> None:
    """A window still open must be waited for, not refused immediately."""
    session = make_session()
    add_frames(session.session_id, [1.0])

    def fill_later() -> None:
        time.sleep(0.5)
        add_frames(session.session_id, [1.2, 1.4, 1.6])

    filler = threading.Thread(target=fill_later, daemon=True)
    filler.start()
    try:
        frames, why = buf.await_clip_window(session.session_id, 0.9, 2.0, timeout=10.0)
    finally:
        filler.join(timeout=5.0)

    assert why is None
    assert len(frames) >= 2


def test_an_early_source_end_stops_the_wait_at_once() -> None:
    """A stopped source will never produce the far side; waiting is a lie."""
    session = make_session(state=LiveState.STOPPED)
    add_frames(session.session_id, [1.0])

    started = time.monotonic()
    frames, why = buf.await_clip_window(session.session_id, 0.9, 6.0, timeout=30.0)
    elapsed = time.monotonic() - started

    assert why is not None
    assert "the source stopped" in why
    assert elapsed < 2.0, f"waited {elapsed:.1f}s for a source that had stopped"


def test_a_cancelled_wait_says_it_was_cancelled() -> None:
    session = make_session()
    add_frames(session.session_id, [1.0])
    cancel = threading.Event()

    def cancel_soon() -> None:
        time.sleep(0.3)
        cancel.set()

    canceller = threading.Thread(target=cancel_soon, daemon=True)
    canceller.start()
    try:
        started = time.monotonic()
        frames, why = buf.await_clip_window(
            session.session_id, 0.9, 6.0, timeout=30.0, cancel=cancel)
        elapsed = time.monotonic() - started
    finally:
        canceller.join(timeout=5.0)

    assert why is not None and "cancelled" in why
    assert elapsed < 3.0, f"cancellation took {elapsed:.1f}s to be noticed"


def test_a_cancel_already_set_returns_without_waiting() -> None:
    session = make_session()
    add_frames(session.session_id, [1.0])
    cancel = threading.Event()
    cancel.set()

    started = time.monotonic()
    _frames, why = buf.await_clip_window(
        session.session_id, 0.9, 6.0, timeout=30.0, cancel=cancel)
    elapsed = time.monotonic() - started

    assert why is not None and "cancelled" in why
    assert elapsed < 1.0


def test_the_timeout_is_a_backstop_and_says_what_it_waited_for() -> None:
    """A running source that simply never produces the far side."""
    session = make_session()
    add_frames(session.session_id, [1.0])

    started = time.monotonic()
    _frames, why = buf.await_clip_window(session.session_id, 0.9, 6.0, timeout=1.0)
    elapsed = time.monotonic() - started

    assert why is not None
    assert "waited 1.0s" in why
    assert 0.9 <= elapsed < 4.0, f"the deadline was not honoured: {elapsed:.1f}s"


# --- what the buffer holds ----------------------------------------------------


def test_a_row_whose_file_is_gone_is_not_a_usable_frame() -> None:
    """Eviction unlinks before it marks, so a half-swept window looked whole."""
    session = make_session()
    paths = add_frames(session.session_id, [1.0, 1.5, 2.0])
    for path in paths[:2]:
        path.unlink()

    frames, why = buf.await_clip_window(session.session_id, 0.9, 2.1, timeout=1.0)

    assert len(frames) == 1
    assert why is not None and "at least two" in why, why


def test_a_restarted_source_keeps_the_earlier_window_answerable() -> None:
    """A reconnect resets nothing the buffer already holds."""
    session = make_session()
    add_frames(session.session_id, [1.0, 1.5, 2.0])
    db.update_session(session.session_id, state=LiveState.STOPPED)
    db.update_session(session.session_id, state=LiveState.RUNNING)
    add_frames(session.session_id, [6.0, 6.5])

    frames, why = buf.await_clip_window(session.session_id, 0.9, 2.1, timeout=1.0)

    assert why is None
    assert len(frames) == 3


def test_the_wait_reads_a_bounded_number_of_frames() -> None:
    """A long window must not pull the whole session into memory."""
    session = make_session()
    add_frames(session.session_id, [i * 0.1 for i in range(1, 900)])

    frames, why = buf.await_clip_window(session.session_id, 0.0, 90.0, timeout=1.0)

    assert why is None
    assert len(frames) <= 600, f"the wait materialised {len(frames)} frames"


def test_oldest_and_newest_bound_what_can_be_asked_for() -> None:
    session = make_session()
    add_frames(session.session_id, [2.0, 4.0, 7.5])

    assert buf.oldest_frame_media_ts(session.session_id) == pytest.approx(2.0)
    assert buf.newest_frame_media_ts(session.session_id) == pytest.approx(7.5)
    assert buf.oldest_frame_media_ts("live_nothing") is None


# --- spanning the moment ------------------------------------------------------


def test_a_window_that_does_not_span_the_moment_is_not_satisfied() -> None:
    """Two frames after a failure make a clip that cannot explain it.

    Stitchability and usefulness are different conditions. A caller asking for
    evidence *around* a moment needs something on each side of it, and waiting
    only for "enough frames to stitch" hands back the half that arrives first —
    which, for a failure, is the half that comes after.
    """
    session = make_session()
    add_frames(session.session_id, [6.0, 6.5, 7.0])

    frames, why = buf.await_clip_window(
        session.session_id, 1.0, 9.0, timeout=1.0, require_span_at=5.0)

    assert len(frames) == 3
    assert why is not None
    assert "would not span the moment" in why
    assert "before 5.00s" in why, why


def test_the_same_window_is_satisfied_without_the_span_requirement() -> None:
    """The stronger condition is opt-in; stitching alone still succeeds."""
    session = make_session()
    add_frames(session.session_id, [6.0, 6.5, 7.0])

    frames, why = buf.await_clip_window(session.session_id, 1.0, 9.0, timeout=1.0)

    assert why is None
    assert len(frames) == 3


def test_a_spanning_window_is_satisfied() -> None:
    session = make_session()
    add_frames(session.session_id, [4.0, 4.5, 6.0, 6.5])

    frames, why = buf.await_clip_window(
        session.session_id, 1.0, 9.0, timeout=1.0, require_span_at=5.0)

    assert why is None
    assert any(frame.media_ts < 5.0 for frame in frames)
    assert any(frame.media_ts >= 5.0 for frame in frames)


def test_a_window_missing_the_far_side_names_that_side() -> None:
    session = make_session()
    add_frames(session.session_id, [2.0, 3.0, 4.0, 20.0])

    _frames, why = buf.await_clip_window(
        session.session_id, 1.0, 9.0, timeout=1.0, require_span_at=5.0)

    assert why is not None
    assert "none at or after 5.00s" in why, why


# --- the condition these replaced --------------------------------------------


def old_wait(session_id: str, until_media_ts: float, timeout: float) -> bool:
    """The loop all four callers had written, reproduced exactly.

    Kept as a counter-control rather than described in a comment: a claim that
    the old condition was wrong is worth only as much as a test that runs it.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        newest = buf.newest_frame_media_ts(session_id)
        if newest is not None and newest >= until_media_ts:
            return True
        time.sleep(0.05)
    return False


def test_the_old_condition_calls_an_uncaptured_window_ready() -> None:
    """The exact defect, run rather than asserted about.

    Capture begins at 5.0; the moment is at 0.7 and the window is 0.7 ± 3.0.
    The old loop asks whether the newest frame has passed 3.7. It has — the
    first frame ever captured is already past it — so the loop reports ready
    and the caller stitches a window containing nothing.

    On a slower machine a frame lands before 0.7 and the same code passes,
    which is why this arrived as a flaky test rather than as missing evidence.
    """
    session = make_session()
    add_frames(session.session_id, [5.0, 5.5, 6.0, 8.0])

    # The old condition: satisfied, immediately, and wrong.
    assert old_wait(session.session_id, 3.7, timeout=2.0) is True

    # What it licensed the caller to do, and what they got for it.
    assert buf.frames_between(session.session_id, -2.3, 3.7, limit=300) == []

    # The condition that was actually needed, on the same buffer.
    frames, why = buf.await_clip_window(session.session_id, -2.3, 3.7, timeout=2.0)
    assert frames == []
    assert why is not None and "no frame was ever captured" in why


def test_the_old_condition_also_missed_a_swept_window() -> None:
    """The second way the far edge says nothing about the near one."""
    session = make_session()
    add_frames(session.session_id, [1.0, 1.5, 2.0, 9.0, 9.5])
    buf.evict(session.session_id, keep_seconds=5.0, now_media_ts=9.5)

    assert old_wait(session.session_id, 2.0, timeout=2.0) is True

    frames, why = buf.await_clip_window(session.session_id, 1.0, 2.0, timeout=1.0)
    assert frames == []
    assert why is not None and "evicted" in why


# --- the builder's contract ---------------------------------------------------


def test_clip_around_raises_with_a_cause_instead_of_returning_none() -> None:
    """Three callers had `assert clip` and no way to say what went wrong."""
    from watch_skill.live.clips import ClipError

    session = make_session()
    add_frames(session.session_id, [5.0, 5.5, 6.0, 8.0])

    with pytest.raises(ClipError) as caught:
        buf.clip_around(session.session_id, 0.7, before=3.0, after=3.0, timeout=2.0)

    assert caught.value.code == "live.clip_insufficient_media"
    assert "no frame was ever captured" in str(caught.value)
    assert "5.00s" in str(caught.value)
    assert caught.value.details["window"] == [pytest.approx(-2.3), pytest.approx(3.7)]


def test_clip_around_is_cancellable() -> None:
    from watch_skill.live.clips import ClipError

    session = make_session()
    add_frames(session.session_id, [1.0])
    cancel = threading.Event()
    cancel.set()

    with pytest.raises(ClipError) as caught:
        buf.clip_around(session.session_id, 3.0, before=1.0, after=1.0,
                        timeout=30.0, cancel=cancel)

    assert "cancelled" in str(caught.value)
