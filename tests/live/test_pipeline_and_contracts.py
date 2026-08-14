"""Bounded queues, capability honesty, and cursor semantics."""
from __future__ import annotations

import threading
import time

import pytest

from watch_skill.errors import WatchSkillError
from watch_skill.live.capabilities import KINDS, capability_for, capability_matrix
from watch_skill.live.pipeline import BoundedStage, CircuitBreaker, Overflow, Pipeline
from watch_skill.live.types import LiveCursor, LiveProfile, LiveSourceSpec

# --- queues are bounded, and say what they dropped ---------------------------


def test_a_drop_oldest_stage_never_exceeds_its_capacity() -> None:
    stage = BoundedStage(name="vision", capacity=4)
    for i in range(1000):
        stage.put(i)
    assert stage.depth <= 4
    assert stage.dropped == 996, "drops must be counted, not hidden"


def test_drop_oldest_keeps_the_newest() -> None:
    """Live perception wants the current frame, not a backlog."""
    stage = BoundedStage(name="vision", capacity=3)
    for i in range(10):
        stage.put(i)
    assert stage.drain_latest() == 9


def test_drain_latest_counts_what_it_skipped() -> None:
    stage = BoundedStage(name="vision", capacity=8)
    for i in range(5):
        stage.put(i)
    assert stage.drain_latest() == 4
    assert stage.dropped == 4
    assert stage.depth == 0


def test_a_blocking_stage_does_not_silently_discard() -> None:
    stage = BoundedStage(name="persist", capacity=2, overflow=Overflow.BLOCK)
    assert stage.put("a") and stage.put("b")
    assert stage.put("c", timeout=0.1) is False, "a full blocking stage must report it"
    assert stage.dropped == 1


def test_a_slow_consumer_cannot_stall_a_fast_one() -> None:
    """The property that keeps audio alive while vision is behind."""
    pipeline = Pipeline()
    slow = pipeline.stage("slow", 4)
    fast = pipeline.stage("fast", 64, Overflow.BLOCK)
    fast_seen: list[int] = []
    release = threading.Event()

    pipeline.consume(slow, lambda _item: release.wait(5.0))
    pipeline.consume(fast, fast_seen.append)
    try:
        for i in range(50):
            slow.put(i)
            fast.put(i)
        deadline = time.time() + 5
        while len(fast_seen) < 50 and time.time() < deadline:
            time.sleep(0.02)
        assert len(fast_seen) == 50, "the fast stage was blocked by the slow one"
        assert slow.dropped > 0, "the slow stage should have shed load"
    finally:
        release.set()
        pipeline.stop(timeout=2)


def test_a_raising_handler_does_not_kill_the_pipeline() -> None:
    pipeline = Pipeline()
    stage = pipeline.stage("flaky", 32, Overflow.BLOCK)
    seen: list[int] = []

    def handler(item: int) -> None:
        if item == 2:
            raise ValueError("one bad frame")
        seen.append(item)

    pipeline.consume(stage, handler)
    try:
        for i in range(6):
            stage.put(i)
        deadline = time.time() + 5
        while len(seen) < 5 and time.time() < deadline:
            time.sleep(0.02)
        assert seen == [0, 1, 3, 4, 5]
        assert any(e["stage"] == "flaky" for e in pipeline.errors)
    finally:
        pipeline.stop(timeout=2)


def test_circuit_breaker_opens_and_recovers() -> None:
    breaker = CircuitBreaker(threshold=2, cooldown=0.2)
    assert not breaker.open
    assert breaker.record_failure() is False
    assert breaker.record_failure() is True
    assert breaker.open
    time.sleep(0.25)
    assert not breaker.open, "the breaker never reset after its cooldown"


# --- capabilities are never optimistic ---------------------------------------


def test_every_capability_reports_how_it_was_established() -> None:
    matrix = capability_matrix()
    assert {c["kind"] for c in matrix["capabilities"]} == set(KINDS)
    for capability in matrix["capabilities"]:
        assert capability["status"] in ("available", "unavailable", "degraded", "untested")
        assert capability["verified"] in ("machine_tested", "probed", "not_tested")
        if capability["status"] == "available":
            assert capability["verified"] != "not_tested", (
                f"{capability['kind']} claims to be available without anyone "
                "having checked"
            )


def test_an_unavailable_capability_says_how_to_fix_it() -> None:
    for kind in KINDS:
        capability = capability_for(kind)
        if capability.status == "unavailable":
            assert capability.repair or capability.limitations, (
                f"{kind} is unavailable with no repair and no explanation"
            )


def test_an_unknown_capture_kind_is_honestly_unknown() -> None:
    capability = capability_for("telepathy")
    assert capability.status == "unavailable"
    assert capability.verified == "not_tested"


def test_webrtc_is_reported_unimplemented_rather_than_available() -> None:
    """A protocol with no code behind it must never read as supported."""
    capability = capability_for("webrtc")
    assert capability.status == "unavailable"
    assert any("not implemented" in limit for limit in capability.limitations)


# --- cursors ------------------------------------------------------------------


def test_a_cursor_round_trips() -> None:
    cursor = LiveCursor(session_id="live_abc", seq=12)
    assert LiveCursor.decode(cursor.encode(), "live_abc").seq == 12


def test_an_empty_cursor_starts_at_the_beginning() -> None:
    assert LiveCursor.decode("", "live_abc").seq == 0


def test_a_bare_integer_cursor_is_accepted() -> None:
    assert LiveCursor.decode("7", "live_abc").seq == 7


def test_a_cursor_from_another_session_is_refused() -> None:
    """Resetting to zero would flood the caller with events they already saw."""
    with pytest.raises(WatchSkillError) as raised:
        LiveCursor.decode("live_other:5", "live_abc")
    assert raised.value.code == "live.cursor_session_mismatch"


def test_a_malformed_cursor_is_structured() -> None:
    with pytest.raises(WatchSkillError) as raised:
        LiveCursor.decode("garbage", "live_abc")
    assert raised.value.code == "live.bad_cursor"


# --- specs --------------------------------------------------------------------


def test_a_spec_rejects_an_impossible_frame_rate() -> None:
    from pydantic import ValidationError

    from watch_skill.live.types import LiveSourceKind

    with pytest.raises(ValidationError):
        LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x.mp4", fps=0)
    with pytest.raises(ValidationError):
        LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x.mp4", fps=120)


def test_the_default_profile_is_local() -> None:
    """A profile that needs egress must never be reachable by accident."""
    from watch_skill.live.types import LiveSourceKind

    spec = LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x.mp4")
    assert spec.profile is LiveProfile.LOCAL_LITE
    assert all("cloud" not in profile.value for profile in LiveProfile)


def test_live_budget_permits_no_egress_by_default() -> None:
    from watch_skill.live.types import LiveBudget

    budget = LiveBudget()
    assert budget.max_egress_frames == 0
    assert budget.max_usd == 0.0
