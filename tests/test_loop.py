"""The Loop: critic schema, diff engine, runner persistence + stop conditions,
artifact rendering. Capture is mocked here (real browser capture is covered by
test_capture.py); the critic is injected — no cloud calls."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from agentvision.errors import LoopError  # noqa: E402
from agentvision.loop import runner as runner_mod  # noqa: E402
from agentvision.loop.capture import CaptureResult  # noqa: E402
from agentvision.loop.critic import Critique, Issue, parse_critique  # noqa: E402
from agentvision.loop.diff import align_frames, compare_issues  # noqa: E402
from agentvision.loop.runner import loop_iterate, loop_start, loop_status  # noqa: E402
from agentvision.perceive.types import Frame, PerceptionResult, VideoMetadata  # noqa: E402

# --- critic schema -----------------------------------------------------------


def test_parse_critique_strict_json() -> None:
    raw = json.dumps(
        {
            "verdict": "fail",
            "score": 40,
            "summary": "broken layout",
            "issues": [
                {
                    "timestamp": 2.5,
                    "severity": "major",
                    "description": "button overflows container",
                    "suggested_fix": "add max-width",
                }
            ],
        }
    )
    critique = parse_critique(raw)
    assert critique.verdict == "fail"
    assert critique.issues[0].severity == "major"


def test_parse_critique_extracts_from_prose() -> None:
    raw = 'Here is my assessment:\n{"verdict": "pass", "score": 95, "issues": []}\nDone.'
    assert parse_critique(raw).verdict == "pass"


@pytest.mark.parametrize(
    "raw",
    [
        "no json here at all",
        '{"verdict": "maybe", "score": 50, "issues": []}',   # bad enum
        '{"verdict": "pass", "score": 500, "issues": []}',   # score out of range
    ],
)
def test_parse_critique_rejects_invalid(raw: str) -> None:
    with pytest.raises(Exception):
        parse_critique(raw)


def test_critic_retries_once_on_malformed(monkeypatch: pytest.MonkeyPatch) -> None:
    from agentvision.loop import critic as critic_mod

    outputs = iter(["not json at all", '{"verdict": "pass", "score": 90, "issues": []}'])

    class FakeClient:
        def generate(self, prompt: str, images):
            return next(outputs)

    class FakeVision:
        client = FakeClient()

    monkeypatch.setattr(critic_mod, "get_vision", lambda tier, provider=None, model=None: FakeVision())
    perception = _fake_perception(["aaaa000000000000"], [0.0])
    critique = critic_mod.critique_recording(perception, "page must render")
    assert critique.verdict == "pass"


# --- diff engine -------------------------------------------------------------


def _fake_perception(phashes: list[str], timestamps: list[float]) -> PerceptionResult:
    frames = [
        Frame(
            index=i, timestamp_seconds=ts, path=Path(f"frame_{i}.jpg"),
            scene_id=i, phash=ph, reason="scene-start",
        )
        for i, (ph, ts) in enumerate(zip(phashes, timestamps))
    ]
    meta = VideoMetadata(
        duration_seconds=max(timestamps) + 1 if timestamps else 0,
        width=320, height=240, fps=30.0, codec="h264", has_audio=False,
    )
    return PerceptionResult(source="fake", metadata=meta, frames=frames)


def test_align_frames_matches_similar_hashes() -> None:
    a = _fake_perception(["0000000000000000", "ffffffffffffffff"], [0.0, 5.0])
    b = _fake_perception(["0000000000000001", "fffffffffffffffe"], [0.2, 5.3])
    pairs = align_frames(a, b)
    assert len(pairs) == 2
    assert pairs[0].distance == 1
    assert pairs[0].b_timestamp == 0.2
    assert not pairs[0].changed


def test_align_frames_is_monotonic() -> None:
    # B's first frame matches A's second best — alignment must not go backwards
    a = _fake_perception(["00000000000000ff", "ffffffffffffffff"], [0.0, 5.0])
    b = _fake_perception(["ffffffffffffffff"], [4.8])
    pairs = align_frames(a, b)
    assert [p.b_timestamp for p in pairs] == sorted(p.b_timestamp for p in pairs)


def test_compare_issues_lifecycle() -> None:
    prev = [
        Issue(timestamp=2.0, severity="major", description="red error banner visible at top"),
        Issue(timestamp=6.0, severity="minor", description="footer text overlaps image"),
    ]
    cur = [
        Issue(timestamp=6.2, severity="minor", description="footer text overlaps the image"),
        Issue(timestamp=1.0, severity="critical", description="page is entirely blank"),
    ]
    fixed, unchanged, new = compare_issues(prev, cur)
    assert [i.description for i in fixed] == ["red error banner visible at top"]
    assert len(unchanged) == 1 and "footer" in unchanged[0].description
    assert len(new) == 1 and "blank" in new[0].description


# --- runner ------------------------------------------------------------------


def _install_fake_capture(monkeypatch: pytest.MonkeyPatch, sample_video: Path) -> None:
    def fake_capture(target, out_dir, script=None, duration_seconds=8.0, viewport=None):
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / "capture.mp4"
        shutil.copy2(sample_video, dest)
        return CaptureResult(video_path=dest, kind="file", target=str(target), meta={})

    monkeypatch.setattr(runner_mod, "capture", fake_capture)


def _scripted_critic(verdicts: list[tuple[str, int, list[Issue]]]):
    calls = iter(verdicts)

    def critic(perception, pass_criteria):
        verdict, score, issues = next(calls)
        return Critique(verdict=verdict, score=score, summary=f"scripted {verdict}", issues=issues)

    return critic


def test_loop_start_persists_iteration(
    sample_video: Path, isolated_settings: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_capture(monkeypatch, sample_video)
    issue = Issue(timestamp=1.0, severity="major", description="banner broken")
    state = loop_start(
        "file-target", "no broken banner",
        critic_override=_scripted_critic([("fail", 40, [issue])]),
    )
    assert state.status == "running"
    loop_dir = isolated_settings / "loops" / state.loop_id
    assert (loop_dir / "state.json").is_file()
    assert (loop_dir / "iter_0" / "critique.json").is_file()
    assert Path(state.iterations[0]["video"]).is_file()
    reloaded = loop_status(state.loop_id)
    assert reloaded.iterations[0]["critique"]["score"] == 40


def test_loop_iterate_reports_fixed_and_renders_artifacts(
    sample_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_capture(monkeypatch, sample_video)
    issue = Issue(timestamp=1.0, severity="major", description="banner broken badly")
    critic = _scripted_critic([("fail", 40, [issue]), ("pass", 95, [])])
    state = loop_start("file-target", "banner ok", critic_override=critic)
    state = loop_iterate(state.loop_id, critic_override=critic)

    assert state.status == "passed"
    diff = state.iterations[1]["diff"]
    assert [i["description"] for i in diff["fixed"]] == ["banner broken badly"]
    artifacts = state.iterations[1]["artifacts"]
    assert artifacts is not None
    assert Path(artifacts["mp4"]).is_file()
    assert Path(artifacts["gif"]).is_file()
    assert Path(artifacts["gif"]).stat().st_size > 1000


def test_loop_stops_on_no_progress(
    sample_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_capture(monkeypatch, sample_video)
    issue = Issue(timestamp=1.0, severity="major", description="still broken")
    critic = _scripted_critic(
        [("fail", 50, [issue]), ("fail", 45, [issue]), ("fail", 44, [issue])]
    )
    state = loop_start("t", "criteria", critic_override=critic)
    state = loop_iterate(state.loop_id, critic_override=critic)
    state = loop_iterate(state.loop_id, critic_override=critic)
    assert state.status == "no_progress"


def test_loop_stops_on_max_iterations(
    sample_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_capture(monkeypatch, sample_video)
    critic = _scripted_critic([("fail", 10, []), ("fail", 60, [])])
    state = loop_start("t", "c", max_iterations=2, critic_override=critic)
    state = loop_iterate(state.loop_id, critic_override=critic)
    assert state.status == "max_iterations"


def test_iterate_after_pass_refuses(
    sample_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_capture(monkeypatch, sample_video)
    critic = _scripted_critic([("pass", 100, [])])
    state = loop_start("t", "c", critic_override=critic)
    assert state.status == "passed"
    with pytest.raises(LoopError) as excinfo:
        loop_iterate(state.loop_id, critic_override=critic)
    assert excinfo.value.code == "loop.already_done"


def test_unknown_loop_id_is_structured() -> None:
    with pytest.raises(LoopError) as excinfo:
        loop_status("does-not-exist")
    assert excinfo.value.code == "loop.not_found"
