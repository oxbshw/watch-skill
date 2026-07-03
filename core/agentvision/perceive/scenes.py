"""Scene detection (PySceneDetect ContentDetector) and perceptual hashing."""
from __future__ import annotations

from pathlib import Path

from agentvision.errors import PerceptionError


def _import_scenedetect():
    try:
        from scenedetect import ContentDetector, detect  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "PySceneDetect is not installed",
            code="perceive.missing_dependency",
            fix='install the perception extras: `uv sync --extra perceive` or `pip install "agentvision[perceive]"`',
        ) from exc
    return detect, ContentDetector


def detect_scenes(video_path: Path) -> list[tuple[float, float]]:
    """Detect cuts; return (start_seconds, end_seconds) per scene.

    An empty list means the video is effectively one static shot — callers
    fall back to uniform sampling.
    """
    detect, ContentDetector = _import_scenedetect()
    try:
        scene_list = detect(str(video_path), ContentDetector())
    except Exception as exc:  # scenedetect raises plain Exceptions on bad media
        raise PerceptionError(
            f"scene detection failed: {exc}",
            code="perceive.scene_detection_failed",
            details={"path": str(video_path)},
        ) from exc
    def _seconds(timecode) -> float:
        value = getattr(timecode, "seconds", None)  # scenedetect >= 0.7
        return float(value) if value is not None else timecode.get_seconds()

    return [(_seconds(start), _seconds(end)) for start, end in scene_list]


def compute_phash(image_path: Path) -> str:
    """Perceptual hash (phash) of an image, as a hex string."""
    try:
        import imagehash  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "imagehash/Pillow are not installed",
            code="perceive.missing_dependency",
            fix='install the perception extras: `uv sync --extra perceive`',
        ) from exc
    with Image.open(image_path) as img:
        return str(imagehash.phash(img))


def hamming_distance(hash_a: str, hash_b: str) -> int:
    """Hamming distance between two hex phash strings."""
    a = int(hash_a, 16)
    b = int(hash_b, 16)
    return (a ^ b).bit_count()
