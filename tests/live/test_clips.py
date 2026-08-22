"""Evidence clips: before and after, hashed, and never half-finished.

The load-bearing test kills the builder during finalization and proves the
survivor is either a complete verifiable clip or nothing at all — never a
short file that looks finished.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from watch_skill.live import buffer as buf
from watch_skill.live import clips, db
from watch_skill.live.types import LiveEventType

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


def _wait_for(predicate, timeout: float, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


# --- hashing and manifests ----------------------------------------------------


def test_a_manifest_seals_its_own_contents(tmp_path: Path) -> None:
    manifest = clips.ClipManifest(
        artifact_id="clip_1", session_id="s", event_seq=3,
        media_start=5.0, media_end=15.0, event_media_ts=10.0,
        wall_start=1.0, wall_end=2.0, frame_count=20,
    )
    sealed = manifest.seal()
    assert sealed and len(sealed) == 64
    assert manifest.manifest_sha256 == sealed


def test_tampering_with_a_manifest_invalidates_it(tmp_path: Path) -> None:
    """A hash that survives editing the thing it covers is decoration."""
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"video bytes")
    manifest = clips.ClipManifest(
        artifact_id="clip_1", session_id="s", event_seq=1,
        media_start=0.0, media_end=10.0, event_media_ts=5.0,
        wall_start=1.0, wall_end=2.0, frame_count=10,
        clip_sha256=clips.sha256_file(clip),
    )
    manifest.seal()
    assert manifest.verify(clip)["ok"] is True

    manifest.event_media_ts = 99.0
    result = manifest.verify(clip)
    assert result["ok"] is False
    assert any("manifest hash" in p for p in result["problems"])


def test_tampering_with_the_clip_invalidates_it(tmp_path: Path) -> None:
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"original")
    manifest = clips.ClipManifest(
        artifact_id="clip_1", session_id="s", event_seq=1,
        media_start=0.0, media_end=1.0, event_media_ts=0.5,
        wall_start=1.0, wall_end=2.0, frame_count=2,
        clip_sha256=clips.sha256_file(clip),
    )
    manifest.seal()
    clip.write_bytes(b"tampered")
    result = manifest.verify(clip)
    assert result["ok"] is False
    assert any("clip hash" in p for p in result["problems"])


def test_a_missing_clip_is_reported_not_ignored(tmp_path: Path) -> None:
    manifest = clips.ClipManifest(
        artifact_id="c", session_id="s", event_seq=1, media_start=0.0,
        media_end=1.0, event_media_ts=0.5, wall_start=1.0, wall_end=2.0,
        frame_count=2, clip_sha256="0" * 64,
    )
    manifest.seal()
    assert manifest.verify(tmp_path / "gone.mp4")["ok"] is False


def test_public_output_carries_no_filesystem_path() -> None:
    manifest = clips.ClipManifest(
        artifact_id="clip_x", session_id="s", event_seq=1, media_start=2.0,
        media_end=12.0, event_media_ts=7.0, wall_start=1.0, wall_end=2.0,
        frame_count=20,
    )
    manifest.seal()
    blob = json.dumps(manifest.to_public())
    assert ".mp4" not in blob
    assert str(Path.home()) not in blob
    assert "path" not in manifest.to_public()


def test_the_public_shape_says_whether_it_spans_the_event() -> None:
    """The whole point of a clip: what happened either side of the moment."""
    manifest = clips.ClipManifest(
        artifact_id="c", session_id="s", event_seq=1, media_start=2.0,
        media_end=12.0, event_media_ts=7.0, wall_start=1.0, wall_end=2.0,
        frame_count=20,
    )
    payload = manifest.to_public()
    assert payload["contains_pre_event"] is True
    assert payload["contains_post_event"] is True


# --- building from a live session ---------------------------------------------


@pytest.fixture
def live_session_with_event(state_change_clip: Path):
    """A running session that has produced at least one detected event."""
    from watch_skill.live import session as live_session

    session = live_session.start_live(str(state_change_clip), fps=2.0)
    events = _wait_for(
        lambda: [
            e for e in db.read_events(session.session_id, limit=100)
            if e.type is LiveEventType.SCENE_CHANGE and e.media_ts >= 6.0
        ] or None,
        timeout=30.0,
    )
    yield session, events
    live_session.stop_live(session.session_id)


def test_a_clip_spans_before_and_after_the_event(live_session_with_event) -> None:
    """The headline proof.

    An event detected while the source was still running produces media from
    before the moment anything decided the moment mattered.
    """
    session, events = live_session_with_event
    assert events, "no event to build a clip around"
    event = events[0]

    manifest = clips.build_event_clip(
        session.session_id, event.seq, event.media_ts,
        pre_seconds=4.0, post_seconds=4.0,
    )
    assert manifest.media_start < event.media_ts, "no pre-event evidence"
    assert manifest.media_end > event.media_ts, "no post-event evidence"
    assert manifest.frame_count >= 2

    path = clips.clip_path(session.session_id, event.seq)
    assert path is not None and path.is_file()
    assert manifest.verify(path)["ok"] is True


def test_the_event_timestamp_lies_inside_the_clip_range(
    live_session_with_event,
) -> None:
    session, events = live_session_with_event
    event = events[0]
    manifest = clips.build_event_clip(session.session_id, event.seq,
                                      event.media_ts)
    assert manifest.media_start <= event.media_ts <= manifest.media_end


def test_hashes_verify_independently(live_session_with_event) -> None:
    """Recomputed from the files, not read back from the producer."""
    session, events = live_session_with_event
    event = events[0]
    manifest = clips.build_event_clip(session.session_id, event.seq,
                                      event.media_ts)
    path = clips.clip_path(session.session_id, event.seq)
    assert clips.sha256_file(path) == manifest.clip_sha256
    for artifact_id, digest in manifest.segment_sha256.items():
        segment = buf.resolve(session.session_id, artifact_id)
        if segment and segment.path.is_file():
            assert clips.sha256_file(segment.path) == digest


def test_building_the_same_clip_twice_is_idempotent(
    live_session_with_event,
) -> None:
    session, events = live_session_with_event
    event = events[0]
    first = clips.build_event_clip(session.session_id, event.seq, event.media_ts)
    second = clips.build_event_clip(session.session_id, event.seq, event.media_ts)
    assert first.artifact_id == second.artifact_id
    assert first.clip_sha256 == second.clip_sha256


def test_the_event_gains_a_clip_reference(live_session_with_event) -> None:
    session, events = live_session_with_event
    event = events[0]
    manifest = clips.build_event_clip(session.session_id, event.seq,
                                      event.media_ts)
    refreshed = [e for e in db.read_events(session.session_id, limit=200)
                 if e.seq == event.seq][0]
    kinds = {ref.kind for ref in refreshed.evidence}
    assert "clip" in kinds
    assert any(ref.artifact_id == manifest.artifact_id
               for ref in refreshed.evidence)


def test_insufficient_media_is_a_structured_error(live_session_with_event) -> None:
    """Evidence that was never retained cannot be reconstructed."""
    session, _ = live_session_with_event
    with pytest.raises(clips.ClipError) as raised:
        clips.build_event_clip(session.session_id, 9999, 9999.0)
    assert raised.value.code == "live.clip_insufficient_media"
    assert raised.value.fix


# --- crash during finalization ------------------------------------------------


def test_a_killed_builder_leaves_no_falsely_complete_clip(
    live_session_with_event, tmp_path: Path, isolated_settings: Path
) -> None:
    """The durability proof.

    A builder killed during finalization must leave either nothing or a
    `.partial`. A short `.mp4` under the real name would be indistinguishable
    from a complete clip and would be cited as evidence.
    """
    session, events = live_session_with_event
    event = events[0]

    script = tmp_path / "build.py"
    script.write_text(textwrap.dedent(f"""
        import sys, time
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.live import clips
        # Stall inside finalization, after encoding has started.
        real = clips.sha256_file
        def slow(path, chunk=1 << 20):
            time.sleep(30)
            return real(path, chunk)
        clips.sha256_file = slow
        clips.build_event_clip({session.session_id!r}, {event.seq},
                               {event.media_ts!r})
    """), encoding="utf-8")

    proc = subprocess.Popen(
        [sys.executable, str(script)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(8)
    proc.kill()
    proc.wait(timeout=30)

    final = clips._clip_dir(session.session_id) / f"event_{event.seq}.mp4"
    assert not final.is_file(), (
        "a killed builder left a clip under its final name — it would be "
        "cited as complete evidence"
    )
    assert clips.existing_clip(session.session_id, event.seq) is None

    # Recovery in this process cleans the leftovers and completes the work.
    clips.cleanup_partials(session.session_id)
    assert not list(clips._clip_dir(session.session_id).glob("*.partial"))

    manifest = clips.build_event_clip(session.session_id, event.seq,
                                      event.media_ts)
    assert manifest.verify(clips.clip_path(session.session_id, event.seq))["ok"]
    assert len(list(clips._clip_dir(session.session_id).glob("event_*.mp4"))) == 1, (
        "recovery produced more than one artifact"
    )


def test_a_fresh_process_can_read_the_clip_relationship(
    live_session_with_event, tmp_path: Path, isolated_settings: Path
) -> None:
    session, events = live_session_with_event
    event = events[0]
    manifest = clips.build_event_clip(session.session_id, event.seq,
                                      event.media_ts)

    probe = tmp_path / "probe.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.live import clips, db
        found = clips.existing_clip({session.session_id!r}, {event.seq})
        events = db.read_events({session.session_id!r}, limit=200)
        linked = [e for e in events if e.seq == {event.seq}]
        refs = [r.kind for r in linked[0].evidence] if linked else []
        print(json.dumps({{
            "artifact_id": found.artifact_id if found else None,
            "sha": found.clip_sha256 if found else None,
            "has_clip_ref": "clip" in refs,
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-1500:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["artifact_id"] == manifest.artifact_id
    assert payload["sha"] == manifest.clip_sha256
    assert payload["has_clip_ref"] is True


# --- quota --------------------------------------------------------------------


def test_the_quota_never_evicts_pinned_evidence(live_session_with_event) -> None:
    """Pinned media is what a clip is made of; evicting it loses the clip.

    Identities, not a count. The session is still capturing, so a frame that
    lands inside the pinned window between the two reads is pinned too, and
    counting made that arrival look like a failure -- the assertion read
    `11 == 10` on a CI runner while the property it names was never violated.
    Nothing pinned may disappear; more evidence arriving is not a loss.
    """
    session, events = live_session_with_event
    event = events[0]
    buf.pin_window(session.session_id, event.media_ts, before=3.0, after=3.0)
    pinned_before = {f.artifact_id for f in buf.pinned_frames(session.session_id)}
    clips.enforce_quota(session.session_id, quota_bytes=0)
    pinned_after = {f.artifact_id for f in buf.pinned_frames(session.session_id)}
    assert pinned_before <= pinned_after, (
        f"the quota evicted pinned evidence: "
        f"{sorted(pinned_before - pinned_after)}")


def test_cleanup_partials_is_safe_when_there_are_none(
    live_session_with_event,
) -> None:
    session, _ = live_session_with_event
    assert clips.cleanup_partials(session.session_id) == 0
