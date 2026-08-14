"""macOS scene detection must not import PySceneDetect's AVFoundation stack."""
from __future__ import annotations

from watch_skill.perceive import scenes


def test_macos_scene_detection_uses_ffmpeg_without_scenedetect(sample_video, monkeypatch) -> None:
    """PySceneDetect eagerly imports OpenCV and PyAV, which macOS cannot share."""
    monkeypatch.setattr(scenes.sys, "platform", "darwin")

    def imported_scenedetect():
        raise AssertionError("macOS scene detection must not import PySceneDetect")

    monkeypatch.setattr(scenes, "_import_scenedetect", imported_scenedetect)

    spans = scenes.detect_scenes(sample_video)

    assert len(spans) >= 2
    assert spans[0][0] == 0.0
    assert spans[-1][1] >= 11.0


def test_macos_ffmpeg_scene_detection_respects_the_window(sample_video, monkeypatch) -> None:
    monkeypatch.setattr(scenes.sys, "platform", "darwin")

    spans = scenes.detect_scenes(sample_video, start_seconds=4.0, end_seconds=8.0)

    assert spans
    assert all(start >= 4.0 and end <= 8.0 for start, end in spans)
