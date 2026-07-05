"""End-to-end watch() on a local synthesized clip + report contract."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.errors import AcquisitionError, PerceptionError  # noqa: E402
from watch_skill.report import render_report  # noqa: E402
from watch_skill.watch import watch  # noqa: E402


def _run(sample_video: Path, tmp_path: Path, **kwargs):
    return watch(
        str(sample_video),
        out_dir=tmp_path / "work dir with spaces",
        run_ocr=False,
        allow_local_whisper=False,  # keyless, modelless test environment
        allow_cloud_stt=False,
        **kwargs,
    )


def test_watch_local_file(sample_video: Path, tmp_path: Path) -> None:
    result = _run(sample_video, tmp_path)
    assert result.acquisition.acquirer == "local"
    assert result.perception is not None and result.perception.frames
    assert result.metadata.duration_seconds > 10
    assert not result.transcript  # whisper disabled, no captions


def test_watch_report_contract(sample_video: Path, tmp_path: Path) -> None:
    result = _run(sample_video, tmp_path)
    report = render_report(result)
    assert "# watch-skill: video report" in report
    assert "## Frames" in report
    assert "## Transcript" in report
    assert "t=00:" in report  # timestamps present
    assert "No transcript available" in report
    assert str(result.work_dir) in report


def test_watch_focused_validates_window(sample_video: Path, tmp_path: Path) -> None:
    with pytest.raises(PerceptionError):
        _run(sample_video, tmp_path, start_seconds=100.0)
    with pytest.raises(PerceptionError):
        _run(sample_video, tmp_path, start_seconds=5.0, end_seconds=4.0)


def test_watch_missing_file_is_structured(tmp_path: Path) -> None:
    with pytest.raises(AcquisitionError) as excinfo:
        watch(str(tmp_path / "nope.mp4"), out_dir=tmp_path / "w")
    assert excinfo.value.code == "acquire.file_not_found"


def test_watch_screen_source_points_at_loop(tmp_path: Path) -> None:
    with pytest.raises(AcquisitionError) as excinfo:
        watch("screen:", out_dir=tmp_path / "w")
    assert excinfo.value.code == "acquire.capture_required"
