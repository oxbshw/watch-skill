"""The end-to-end live proof.

The one test that decides whether "live" is a real capability or a label:

1. start a deterministic media stream playing in real time;
2. detect a visual/textual state change **before the stream finishes**;
3. read it back through the live event cursor;
4. answer a live question with timestamped evidence;
5. stop and finalize the session;
6. query the finalized memory **from a different process**.

Step 2 is the load-bearing one. A pipeline that ingests the whole file and
then reports would pass every other step while being batch processing.
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

from watch_skill.live import ask
from watch_skill.live import session as live_session
from watch_skill.live.types import LiveEventType, LiveState

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


def _wait_for(predicate, timeout: float, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def test_live_watch_end_to_end(
    state_change_clip: Path, tmp_path: Path, isolated_settings: Path
) -> None:
    started_wall = time.monotonic()
    session = live_session.start_live(
        str(state_change_clip), kind="file_replay", profile="local-lite", fps=2.0,
    )
    assert session.state is LiveState.RUNNING

    # --- 2. an event arrives while the source is still playing --------------
    #
    # The property is "reported while the stream was still running", not
    # "reported within N seconds". Asserting on wall time alone would be a
    # race against machine load; asserting on the source still running is
    # exactly the thing that separates streaming from ingest-then-report, and
    # it holds however slow the machine is.
    seen_while_running: dict[str, object] = {}

    def change_seen():
        batch = live_session.observe(session.session_id, limit=100)
        matches = [
            event for event in batch["events"]
            if event["type"] in (
                LiveEventType.VISIBLE_TEXT_CHANGE.value,
                LiveEventType.SCENE_CHANGE.value,
            )
            and event["media_ts"] >= 6.0  # the second half of the clip
        ]
        if not matches:
            return None
        runner = live_session.running_session(session.session_id)
        seen_while_running["state"] = batch["state"]
        seen_while_running["source_running"] = bool(
            runner and runner._source and runner._source.running
        )
        seen_while_running["at"] = time.monotonic() - started_wall
        return matches

    detected = _wait_for(change_seen, timeout=25.0, interval=0.05)
    assert detected, (
        "no state change was reported at all; saw "
        f"{live_session.observe(session.session_id, limit=100)['events']} "
        f"stats={live_session.status(session.session_id)}"
    )
    assert seen_while_running["source_running"], (
        "the change only surfaced after the source finished "
        f"(at {seen_while_running['at']:.1f}s) — that is batch processing "
        "wearing a live label"
    )
    assert seen_while_running["state"] == LiveState.RUNNING.value

    # --- 3. the cursor is idempotent ---------------------------------------
    #
    # Idempotent means the cursor is a position, not a receipt: reading it
    # again starts from the same place and renumbers nothing. It does not mean
    # the answer stops growing — the session is still running, and an event
    # that arrives between the two reads belongs in the second one.
    #
    # Asserting the two lists were equal said otherwise, and made this a race
    # against the stream it was observing: on a slow Windows runner a fifth
    # event landed between the calls and a correct reply, [1,2,3,4,5], failed
    # against [1,2,3,4]. What must hold is that the overlap is identical.
    first = live_session.observe(session.session_id, limit=5)
    again = live_session.observe(session.session_id, cursor=first["cursor"], limit=5)
    overlap = again["events"][: len(first["events"])]
    assert [e["seq"] for e in first["events"]] == [e["seq"] for e in overlap], (
        "replaying a cursor skipped, reordered or renumbered events: "
        f"{[e['seq'] for e in first['events']]} then {[e['seq'] for e in again['events']]}"
    )
    assert all(
        before["seq"] == after["seq"]
        and before["type"] == after["type"]
        and before["media_ts"] == after["media_ts"]
        for before, after in zip(first["events"], overlap, strict=True)
    ), "replaying a cursor returned different events under the same sequence numbers"
    following = live_session.observe(
        session.session_id, cursor=first["next_cursor"], limit=5
    )
    assert all(
        e["seq"] > first["events"][-1]["seq"] for e in following["events"]
    ), "events repeated across a cursor advance"

    # --- 4. a live question, answered with timestamps -----------------------
    answer = ask.ask_live(session.session_id, "what changed on screen?",
                          scope="session")
    assert answer["evidence"], "the live answer cited nothing"
    assert all(item["media_ts"] >= 0 for item in answer["evidence"])
    assert any(item["available"] for item in answer["evidence"]), \
        "no cited frame was still on disk"

    # --- 5. stop and finalize ----------------------------------------------
    stopped = live_session.stop_live(session.session_id)
    assert stopped["state"] in (LiveState.STOPPED.value, LiveState.FAILED.value)
    assert stopped["state"] == LiveState.STOPPED.value, stopped.get("error")

    # Now that nothing is producing, the same cursor must return the same batch
    # exactly. This is the half of idempotence a running stream cannot show,
    # and the only place it can be asserted without racing the producer.
    settled = live_session.observe(session.session_id, cursor=first["cursor"], limit=5)
    repeated = live_session.observe(session.session_id, cursor=first["cursor"], limit=5)
    assert settled["events"] == repeated["events"], (
        "a cursor replayed against a stopped session returned a different batch"
    )
    assert settled["cursor"] == first["cursor"], "a replay moved the cursor it was given"

    from watch_skill.live.finalize import finalize_session

    video_id = finalize_session(session.session_id)
    assert video_id
    assert finalize_session(session.session_id) == video_id, "finalize is not idempotent"

    # --- 6. a NEW process can query the finalized memory --------------------
    #
    # Release this process's OCR models first. The session is over and they
    # are dead weight; holding them while a second process loads embeddings
    # is what turns a modest machine into an out-of-memory abort.
    import gc

    from watch_skill.index import embeddings as embeddings_module
    from watch_skill.perceive import ocr as ocr_module

    live_session.stop_all()
    ocr_module._engines.clear()
    embeddings_module._models.clear()
    gc.collect()

    probe = tmp_path / "probe.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.index.store import get_video
        from watch_skill.index.retrieval import ask_video
        row = get_video({video_id!r})
        context = ask_video({video_id!r}, "what changed on screen?")
        print(json.dumps({{
            "found": row is not None,
            "title": (row or {{}}).get("title"),
            "hits": len(context["hits"]),
            "freshness": context["freshness"]["state"],
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["found"], "the finalized session is not in the video index"
    assert payload["hits"] > 0, "the finalized session is not searchable"
    assert payload["freshness"] != "stale"


def test_events_carry_both_clocks_and_a_provenance(
    state_change_clip: Path,
) -> None:
    session = live_session.start_live(str(state_change_clip), fps=2.0)
    events = _wait_for(
        lambda: live_session.observe(session.session_id, limit=20)["events"] or None,
        timeout=10.0,
    )
    assert events
    for event in events:
        assert event["media_ts"] >= 0
        assert event["wall_ts"] > 1_600_000_000, "wall clock looks wrong"
        assert event["provenance"] in ("observation", "inference")
        assert "schema_version" in event
    live_session.stop_live(session.session_id)


def test_public_events_never_leak_a_filesystem_path(state_change_clip: Path) -> None:
    """Artifact ids, not paths — tool output must not be a directory listing."""
    session = live_session.start_live(str(state_change_clip), fps=2.0)
    _wait_for(
        lambda: live_session.observe(session.session_id, limit=20)["events"] or None,
        timeout=10.0,
    )
    batch = live_session.observe(session.session_id, limit=50)
    blob = json.dumps(batch)
    live_session.stop_live(session.session_id)
    for needle in (str(Path.home()), ".jpg", "\\\\", "//"):
        if needle in ("//",):
            continue
        assert needle not in blob, f"public event payload leaked {needle!r}"
    for event in batch["events"]:
        for ref in event["evidence"]:
            assert ref["artifact_id"].startswith("frame_")
            assert "path" not in ref


def test_a_session_that_never_started_is_a_structured_error() -> None:
    with pytest.raises(live_session.LiveError) as raised:
        live_session.get_session("live_nope")
    assert raised.value.code == "live.session_not_found"
    assert raised.value.fix


def test_an_unsupported_live_source_fails_before_a_session_exists() -> None:
    """An empty live view is indistinguishable from a quiet one, so this
    must raise rather than produce a session that emits nothing."""
    from watch_skill.live.source import CaptureError

    with pytest.raises(CaptureError) as raised:
        live_session.start_live("device:0", kind="camera")
    assert raised.value.code in ("live.source_unsupported", "live.capture_unavailable")
    assert raised.value.fix
    assert live_session.list_live(active_only=True) == []


def test_a_missing_file_fails_immediately() -> None:
    from watch_skill.live.source import CaptureError

    with pytest.raises(CaptureError) as raised:
        live_session.start_live("no-such-clip.mp4", kind="file_replay")
    assert raised.value.code == "live.source_not_found"


def test_finalizing_a_running_session_is_refused(state_change_clip: Path) -> None:
    from watch_skill.errors import WatchSkillError
    from watch_skill.live.finalize import finalize_session

    session = live_session.start_live(str(state_change_clip), fps=2.0)
    with pytest.raises(WatchSkillError) as raised:
        finalize_session(session.session_id)
    assert raised.value.code == "live.not_stopped"
    live_session.stop_live(session.session_id)
