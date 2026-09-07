"""Every supported way in reads a recording's own interaction moments.

The first version of this behaviour lived in the CLI's `watch` command, which
meant `watch-skill watch` pinned the interactions and nothing else did: not the
MCP tool an agent calls, not the REST route the workspace calls, not the job
queue, not `batch`. DeepWatch ingests through `watch-skill watch --index`, so
the one path that worked was also the only one anybody had looked at.

It lives in the engine now. These tests are about the seam rather than the
behaviour -- that each route arrives at the same function, and that no surface
has grown a second copy of it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.identity import digest_file  # noqa: E402
from watch_skill.perceive.cues import Cue, read_sidecar, write_sidecar  # noqa: E402

SURFACES = Path(__file__).resolve().parents[2] / "src" / "watch_skill" / "surfaces"


@pytest.fixture()
def recording_with_cues(sample_video: Path, tmp_path: Path) -> Path:
    """A copy of the sample clip with a cue in the middle of it."""
    import shutil

    video = tmp_path / "ingest dir" / "capture.mp4"
    video.parent.mkdir(parents=True)
    shutil.copy2(sample_video, video)
    write_sidecar(video, [Cue(6.0, "fill #qty")])
    assert read_sidecar(video) == [6.0]
    return video


@pytest.fixture()
def spy(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, float | None]]:
    """Record every call the engine makes to the shared loader."""
    calls: list[tuple[str, float | None]] = []
    import watch_skill.watch as engine

    real = engine.discover_cues

    def recorded(video_path, duration_seconds=None):  # noqa: ANN001, ANN202
        calls.append((Path(video_path).name, duration_seconds))
        return real(video_path, duration_seconds)

    monkeypatch.setattr(engine, "discover_cues", recorded)
    return calls


def _quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    """No whisper download and no OCR pass; this is about the seam."""
    from watch_skill.config import reset_settings

    monkeypatch.setenv("WATCHSKILL_LOCAL_WHISPER_ENABLED", "false")
    monkeypatch.setenv("WATCHSKILL_OCR_ENABLED", "false")
    reset_settings()


class TestEveryRouteReachesTheLoader:
    def test_the_engine_itself(
        self, recording_with_cues: Path, spy: list, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _quiet(monkeypatch)
        from watch_skill.watch import watch

        result = watch(str(recording_with_cues), use_cache=False, max_frames=6)
        assert spy == [("capture.mp4", pytest.approx(12.0, abs=1.0))]
        pinned = [f.timestamp_seconds for f in result.perception.frames
                  if f.reason == "cue"]
        assert pinned == [6.0], f"the cue did not pin a frame: {pinned}"

    def test_the_cli(
        self, recording_with_cues: Path, spy: list, monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        # The route DeepWatch ingests through: `watch-skill watch <file> --index`.
        _quiet(monkeypatch)
        from typer.testing import CliRunner

        from watch_skill.surfaces.cli.main import app

        result = CliRunner().invoke(app, [
            "watch", str(recording_with_cues), "--no-whisper", "--no-ocr",
            "--out-dir", str(tmp_path / "cli out"), "--max-frames", "6",
        ])
        assert result.exit_code == 0, result.output
        assert [name for name, _ in spy] == ["capture.mp4"]

    def test_the_rest_route(
        self, recording_with_cues: Path, spy: list, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pytest.importorskip("fastapi", reason="api extra not installed")
        from fastapi.testclient import TestClient

        from watch_skill.surfaces.api import create_app

        _quiet(monkeypatch)
        client = TestClient(create_app())
        response = client.post("/v1/watch", json={
            "source": str(recording_with_cues), "budget": 6})
        assert response.status_code == 200, response.text
        assert [name for name, _ in spy] == ["capture.mp4"]

    def test_the_mcp_tool(
        self, recording_with_cues: Path, spy: list, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _quiet(monkeypatch)
        from watch_skill.surfaces.mcp.server import _run_watch

        _run_watch(str(recording_with_cues), None, None, 6, lambda *_a: None)
        assert [name for name, _ in spy] == ["capture.mp4"]

    def test_the_job_queue(
        self, recording_with_cues: Path, spy: list, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _quiet(monkeypatch)
        from watch_skill.jobs.handlers import _watch_job

        class _Context:
            payload = {"source": str(recording_with_cues), "budget": 6}

            def checkpoint(self, *_args: object, **_kwargs: object) -> None:
                return

        _watch_job(_Context())
        assert [name for name, _ in spy] == ["capture.mp4"]


class TestNoSurfaceKeepsItsOwnCopy:
    def test_nothing_under_surfaces_reads_a_sidecar_itself(self) -> None:
        """A second reader is a second set of validation rules to forget.

        The CLI's copy accepted booleans, negatives, NaN and a timestamp past
        the end of the recording, and raised an uncaught AttributeError on the
        two shapes a half-written file actually takes.
        """
        offenders = [
            path.relative_to(SURFACES).as_posix()
            for path in SURFACES.rglob("*.py")
            if "cues.json" in path.read_text(encoding="utf-8")
        ]
        assert offenders == [], (
            "these surfaces read the cue sidecar directly instead of leaving "
            f"it to the engine: {offenders}")


class TestTheBindingIsCheckedOnTheWayIn:
    def test_a_sidecar_from_another_recording_is_not_applied(
        self, recording_with_cues: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        _quiet(monkeypatch)
        from watch_skill.watch import watch

        # The scenario: capture twice into one directory. The video is
        # replaced and the cues are not.
        recording_with_cues.write_bytes(
            (recording_with_cues.parent / "capture.mp4").read_bytes() + b"\0")
        assert digest_file(recording_with_cues)

        result = watch(str(recording_with_cues), use_cache=False, max_frames=6)
        assert [f for f in result.perception.frames if f.reason == "cue"] == []
        assert "cues.stale" in capsys.readouterr().err
