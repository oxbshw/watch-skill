"""Perception integration: real ffmpeg + scenedetect + phash on a synthesized clip."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")
pytest.importorskip("imagehash", reason="perceive extra not installed")

from agentvision.perceive import perceive, probe  # noqa: E402
from agentvision.perceive.scenes import compute_phash, hamming_distance  # noqa: E402


def test_probe_metadata(sample_video: Path) -> None:
    meta = probe(sample_video)
    assert 11.0 <= meta.duration_seconds <= 13.0
    assert meta.width == 320
    assert meta.height == 240
    assert meta.has_audio is True


def test_perceive_full_clip(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(
        sample_video, tmp_path / "frames dir", run_ocr=False, max_frames=20
    )
    assert result.frames, "no frames extracted"
    assert len(result.frames) <= 20
    # the clip has 3 hard cuts -> at least 2 scenes must be found
    assert result.scene_count >= 2
    assert result.engine in ("scene", "mixed")
    # chronological, indexed, hashed
    timestamps = [f.timestamp_seconds for f in result.frames]
    assert timestamps == sorted(timestamps)
    assert [f.index for f in result.frames] == list(range(len(result.frames)))
    assert all(f.phash for f in result.frames)
    assert all(f.path.is_file() for f in result.frames)
    # dedup: the red scene is static — its frames should have collapsed
    assert result.deduped_count >= 1


def test_perceive_focused_window(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(
        sample_video, tmp_path / "frames", start_seconds=4.0, end_seconds=8.0,
        run_ocr=False, max_frames=10,
    )
    assert result.focused is True
    assert result.frames
    for frame in result.frames:
        assert 3.5 <= frame.timestamp_seconds <= 8.5


def test_perceive_pins_cue_timestamps(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(
        sample_video, tmp_path / "frames", cue_timestamps=[6.0],
        run_ocr=False, max_frames=10,
    )
    cues = [f for f in result.frames if f.reason == "cue"]
    assert len(cues) == 1
    assert abs(cues[0].timestamp_seconds - 6.0) < 0.01


def test_perception_result_serializes(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(sample_video, tmp_path / "frames", run_ocr=False, max_frames=6)
    payload = result.to_dict()
    assert payload["frames"]
    assert isinstance(payload["frames"][0]["path"], str)
    assert payload["metadata"]["width"] == 320


def test_phash_distance_semantics(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(sample_video, tmp_path / "frames", run_ocr=False, max_frames=12)
    distinct = [f for f in result.frames if f.scene_id in (0, 2)]
    if len(distinct) >= 2:
        a, b = distinct[0], distinct[-1]
        if a.scene_id != b.scene_id:
            assert hamming_distance(a.phash, b.phash) > 6


def test_phash_identical_image_is_zero(sample_video: Path, tmp_path: Path) -> None:
    result = perceive(sample_video, tmp_path / "frames", run_ocr=False, max_frames=4)
    frame = result.frames[0]
    assert hamming_distance(compute_phash(frame.path), frame.phash) == 0
