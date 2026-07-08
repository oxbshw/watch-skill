"""B1 — pluggable loop framework: registry, typed starters, producers, monitor.

Everything here is offline: producers get fake capture layers, critics are
injected. The live demos (real render / real browser / real vision) are the
examples under examples/08-loop-types, run separately.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.errors import LoopError  # noqa: E402
from watch_skill.loop import framework as fw  # noqa: E402
from watch_skill.loop import runner as runner_mod  # noqa: E402
from watch_skill.loop.capture import CaptureResult  # noqa: E402
from watch_skill.loop.critic import Critique, Issue  # noqa: E402
from watch_skill.loop.monitor import loop_monitor  # noqa: E402
from watch_skill.loop.runner import LoopState  # noqa: E402

# --- registry ----------------------------------------------------------------

def test_builtin_loop_types_registered() -> None:
    assert fw.loop_type_names() == ["game", "ui", "video-gen"]


def test_unknown_loop_type_is_structured_error() -> None:
    with pytest.raises(LoopError) as exc:
        fw.get_loop_type("nope")
    assert exc.value.code == "loop.unknown_type"


# --- state compat ------------------------------------------------------------

def test_pre_v07_state_json_loads_with_defaults(tmp_path, monkeypatch) -> None:
    """A v0.6 state.json (no loop_type/extra) must load as a ui loop."""
    from watch_skill.config import get_settings

    loop_dir = get_settings().loops_dir / "legacy00000001"
    loop_dir.mkdir(parents=True)
    legacy = {
        "loop_id": "legacy00000001", "target": "https://x", "pass_criteria": "c",
        "script": None, "max_iterations": 5, "duration_seconds": 8.0,
        "status": "running", "iterations": [],
    }
    (loop_dir / "state.json").write_text(json.dumps(legacy), encoding="utf-8")
    state = LoopState.load("legacy00000001")
    assert state.loop_type == "ui" and state.extra == {}


# --- video-gen producer --------------------------------------------------------

def _video_gen_state(tmp_path: Path, cmd: str, output: Path) -> LoopState:
    return LoopState(
        loop_id="t", target=cmd, pass_criteria="c", script=None,
        max_iterations=3, duration_seconds=0.0, loop_type="video-gen",
        extra={"generator_cmd": cmd, "output": str(output), "spec": "s",
               "timeout_seconds": 60},
    )


def test_video_gen_producer_runs_cmd_and_adopts_output(tmp_path: Path) -> None:
    output = tmp_path / "render dir" / "out.mp4"
    output.parent.mkdir()
    cmd = (
        f'"{sys.executable}" -c "from pathlib import Path; '
        f"Path(r'{output}').write_bytes(b'fakevideo')\""
    )
    result = fw._produce_video_gen(_video_gen_state(tmp_path, cmd, output), tmp_path / "iter")
    assert result.kind == "video-gen"
    assert result.video_path.is_file()
    assert result.video_path.read_bytes() == b"fakevideo"


def test_video_gen_producer_rejects_missing_output(tmp_path: Path) -> None:
    output = tmp_path / "never.mp4"
    cmd = f'"{sys.executable}" -c "pass"'  # succeeds but writes nothing
    with pytest.raises(LoopError) as exc:
        fw._produce_video_gen(_video_gen_state(tmp_path, cmd, output), tmp_path / "iter")
    assert exc.value.code == "loop.generator_no_output"


def test_video_gen_producer_surfaces_generator_failure(tmp_path: Path) -> None:
    output = tmp_path / "never.mp4"
    cmd = f'"{sys.executable}" -c "import sys; sys.exit(3)"'
    with pytest.raises(LoopError) as exc:
        fw._produce_video_gen(_video_gen_state(tmp_path, cmd, output), tmp_path / "iter")
    assert exc.value.code == "loop.generator_failed"


def test_video_gen_producer_deletes_stale_render(tmp_path: Path) -> None:
    """A leftover render from the previous iteration must not pass for new."""
    output = tmp_path / "out.mp4"
    output.write_bytes(b"stale")
    cmd = f'"{sys.executable}" -c "pass"'  # writes nothing
    with pytest.raises(LoopError) as exc:
        fw._produce_video_gen(_video_gen_state(tmp_path, cmd, output), tmp_path / "iter")
    assert exc.value.code == "loop.generator_no_output"  # stale file was removed


# --- game producer -------------------------------------------------------------

def test_game_producer_launches_and_terminates_run_cmd(tmp_path: Path, monkeypatch) -> None:
    captured: dict = {}

    def fake_capture_ok(target, out_dir, script=None, duration_seconds=10.0, viewport=None):
        out = Path(out_dir) / "capture.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"rec")
        captured["target"] = target
        return CaptureResult(video_path=out, kind="screen", target=target)

    monkeypatch.setattr(fw, "capture", fake_capture_ok)
    state = LoopState(
        loop_id="g", target="screen:", pass_criteria="c", script=None,
        max_iterations=3, duration_seconds=1.0, loop_type="game",
        extra={"run_cmd": f'"{sys.executable}" -c "import time; time.sleep(30)"',
               "warmup_seconds": 0.2},
    )
    result = fw._produce_game(state, tmp_path / "iter")
    assert result.kind == "game"
    assert captured["target"] == "screen:"
    # the process was terminated (no zombie left waiting 30s) — implied by return


def test_game_producer_fails_fast_when_cmd_dies(tmp_path: Path) -> None:
    state = LoopState(
        loop_id="g", target="screen:", pass_criteria="c", script=None,
        max_iterations=3, duration_seconds=1.0, loop_type="game",
        extra={"run_cmd": f'"{sys.executable}" -c "import sys; sys.exit(1)"',
               "warmup_seconds": 0.3},
    )
    with pytest.raises(LoopError) as exc:
        fw._produce_game(state, tmp_path / "iter")
    assert exc.value.code == "loop.game_start_failed"


# --- typed starters end-to-end through the runner ------------------------------

def _fail_then_pass_critic():
    replies = iter([
        Critique(verdict="fail", score=30, summary="bad",
                 issues=[Issue(timestamp=0.0, severity="critical", description="wrong text")]),
        Critique(verdict="pass", score=95, summary="good", issues=[]),
    ])
    return lambda perception, criteria: next(replies)


def test_loop_video_gen_iterates_to_pass(tmp_path: Path, monkeypatch, sample_video: Path) -> None:
    """Full loop_video_gen -> loop_iterate flow with a real tiny video file."""
    output = tmp_path / "gen.mp4"
    cmd = (
        f'"{sys.executable}" -c "import shutil; '
        f"shutil.copy2(r'{sample_video}', r'{output}')\""
    )
    state = runner_mod.loop_video_gen(
        spec="must show three scenes", generator_cmd=cmd, output=str(output),
        critic_override=_fail_then_pass_critic(),
    )
    assert state.loop_type == "video-gen"
    assert state.status == "running"
    state = runner_mod.loop_iterate(state.loop_id, critic_override=lambda p, c: Critique(
        verdict="pass", score=95, summary="good", issues=[]))
    assert state.status == "passed"
    assert state.iterations[-1]["diff"] is not None
    assert state.iterations[-1]["artifacts"] is not None  # before/after rendered


# --- monitor -------------------------------------------------------------------

def _make_fake_videos(folder: Path, names: list[str], sample_video: Path) -> None:
    import shutil

    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copy2(sample_video, folder / name)


def test_monitor_folder_emits_event_and_stops(tmp_path: Path, sample_video: Path) -> None:
    folder = tmp_path / "drop folder"
    _make_fake_videos(folder, ["a.mp4", "b.mp4", "c.mp4"], sample_video)
    verdicts = iter([
        Critique(verdict="pass", score=90, summary="", issues=[]),
        Critique(verdict="fail", score=20, summary="error screen",
                 issues=[Issue(timestamp=1.5, severity="critical", description="red error banner")]),
        Critique(verdict="pass", score=90, summary="", issues=[]),
    ])
    seen_events: list[dict] = []
    result = loop_monitor(
        str(folder), "a red error screen", max_checks=5,
        on_event=seen_events.append,
        critic_override=lambda p, c: next(verdicts),
    )
    assert result.triggered is True
    assert result.checks_run == 2  # stopped at the event
    assert len(result.events) == 1 and seen_events == result.events
    event = result.events[0]
    assert event["condition"] == "a red error screen"
    assert event["detections"][0]["description"] == "red error banner"
    assert Path(result.events_path).is_file()
    line = json.loads(Path(result.events_path).read_text(encoding="utf-8").splitlines()[0])
    assert line["monitor_id"] == result.monitor_id


def test_monitor_condition_becomes_never_criteria(tmp_path: Path, sample_video: Path) -> None:
    folder = tmp_path / "f"
    _make_fake_videos(folder, ["a.mp4"], sample_video)
    seen: dict = {}

    def critic(perception, criteria):
        seen["criteria"] = criteria
        return Critique(verdict="pass", score=90, summary="", issues=[])

    loop_monitor(str(folder), "a demo error screen shows", max_checks=1, critic_override=critic)
    assert seen["criteria"] == "The recording must never show: a demo error screen shows"


def test_monitor_empty_folder_is_structured_error(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(LoopError) as exc:
        loop_monitor(str(empty), "x", max_checks=2, critic_override=lambda p, c: None)
    assert exc.value.code == "loop.monitor_empty"


def test_monitor_broken_callback_does_not_kill_watch(tmp_path: Path, sample_video: Path) -> None:
    folder = tmp_path / "f"
    _make_fake_videos(folder, ["a.mp4"], sample_video)

    def bad_callback(event):
        raise RuntimeError("webhook down")

    result = loop_monitor(
        str(folder), "err", max_checks=1, on_event=bad_callback,
        critic_override=lambda p, c: Critique(
            verdict="fail", score=10, summary="boom",
            issues=[Issue(timestamp=0.0, severity="major", description="boom")]),
    )
    assert result.triggered is True  # event still recorded despite the callback
