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


def test_resolve_ocr_lang_routing() -> None:
    """Each script routes to its RapidOCR model; everything else default."""
    from agentvision.perceive.ocr import resolve_ocr_lang

    assert resolve_ocr_lang("ar") == "arabic"
    assert resolve_ocr_lang("ar-SA") == "arabic"
    assert resolve_ocr_lang("fa") == "arabic"   # Persian shares the script
    assert resolve_ocr_lang("ur") == "arabic"
    assert resolve_ocr_lang("ru") == "eslav"
    assert resolve_ocr_lang("hi") == "devanagari"
    assert resolve_ocr_lang("ko") == "korean"
    assert resolve_ocr_lang("en") == "default"
    assert resolve_ocr_lang(None) == "default"
    # the bundled multilingual model reads these directly (benchmarked)
    assert resolve_ocr_lang("zh") == "default"
    assert resolve_ocr_lang("ja") == "default"
    assert resolve_ocr_lang("fr") == "default"


class _FakeOcrOutput:
    """Mirror of RapidOCROutput's consumed surface (boxes/txts/scores)."""

    def __init__(self, boxes=(), txts=(), scores=()):
        self.boxes = list(boxes)
        self.txts = tuple(txts)
        self.scores = tuple(scores)


def test_ocr_frame_dispatches_engine_by_lang(tmp_path, monkeypatch) -> None:
    """Regression: Arabic videos got garbage OCR because the bundled ch/en
    recognition model ran on Arabic text. lang must select the engine."""
    from agentvision.perceive import ocr as mod

    chosen: list[str] = []

    class FakeEngine:
        def __call__(self, path):
            return _FakeOcrOutput()

    monkeypatch.setattr(
        mod, "_get_engine", lambda lang="default": chosen.append(lang) or FakeEngine()
    )
    img = tmp_path / "f.jpg"
    img.write_bytes(b"fake")
    mod.ocr_frame(img, lang="ar")
    mod.ocr_frame(img, lang="en")
    mod.ocr_frame(img)
    assert chosen == ["arabic", "default", "default"]


def test_ocr_frame_parses_rapidocr3_output(tmp_path, monkeypatch) -> None:
    """Regression (rapidocr 1.x → 3.x): results moved from a list of
    [box, text, score] rows to an output object with parallel boxes/txts/
    scores. Parse the new shape, filter by confidence, and handle None."""
    from agentvision.perceive import ocr as mod

    box = [[10, 20], [110, 20], [110, 60], [10, 60]]
    output = _FakeOcrOutput(
        boxes=[box, box], txts=("kept text", "low confidence"), scores=(0.91, 0.2)
    )

    class FakeEngine:
        def __init__(self, result):
            self.result = result

        def __call__(self, path):
            return self.result

    img = tmp_path / "f.jpg"
    img.write_bytes(b"fake")

    monkeypatch.setattr(mod, "_get_engine", lambda lang="default": FakeEngine(output))
    blocks = mod.ocr_frame(img)
    assert [b.text for b in blocks] == ["kept text"]
    assert blocks[0].bbox == (10.0, 20.0, 110.0, 60.0)
    assert blocks[0].confidence == 0.91

    monkeypatch.setattr(mod, "_get_engine", lambda lang="default": FakeEngine(None))
    assert mod.ocr_frame(img) == []


def test_focused_scene_detection_scans_only_the_window(sample_video, tmp_path) -> None:
    """Regression: a focused watch decoded the WHOLE video for scene
    detection (minutes of wasted decode on long sources). The window must
    bound the scan — scenes returned must lie within it."""
    from agentvision.perceive.scenes import detect_scenes

    spans = detect_scenes(sample_video, start_seconds=4.0, end_seconds=8.0)
    for start, end in spans:
        assert start >= 3.9, f"scene starts before the window: {start}"
        assert end <= 8.2, f"scene ends after the window: {end}"
