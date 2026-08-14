"""Scene detection and perceptual hashing."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from watch_skill.errors import PerceptionError
from watch_skill.health.binaries import require_binary


def _import_scenedetect():
    try:
        from scenedetect import ContentDetector, detect  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "PySceneDetect is not installed",
            code="perceive.missing_dependency",
            fix='install the perception extras: `uv sync --extra perceive` or `pip install "watch-skill[perceive]"`',
        ) from exc
    return detect, ContentDetector


_SCENE_TIME = re.compile(r"pts_time:([0-9.]+)")


def _detect_scenes_with_ffmpeg(
    video_path: Path,
    start_seconds: float | None,
    end_seconds: float | None,
) -> list[tuple[float, float]]:
    """Build scene spans from ffmpeg's cut score without importing PyAV."""
    from watch_skill.perceive.media import probe  # noqa: PLC0415

    metadata = probe(video_path)
    lo = max(0.0, start_seconds or 0.0)
    hi = min(end_seconds if end_seconds is not None else metadata.duration_seconds, metadata.duration_seconds)
    if hi <= lo:
        return []

    ffmpeg = require_binary("ffmpeg")
    command = [str(ffmpeg), "-hide_banner", "-loglevel", "info"]
    if lo:
        command.extend(["-ss", f"{lo:.3f}"])
    command.extend(["-i", str(video_path.resolve()), "-t", f"{hi - lo:.3f}"])
    command.extend(["-an", "-vf", "select=gt(scene\\,0.3),showinfo", "-f", "null", "-"])
    result = subprocess.run(
        command, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        raise PerceptionError(
            f"ffmpeg scene detection failed: {result.stderr.strip()[:200]}",
            code="perceive.scene_detection_failed",
            fix="the media may be corrupt or zero-length — re-acquire it, "
            "or watch with --transcript-only",
            details={"path": str(video_path)},
        )

    cuts = sorted({
        round(float(match.group(1)), 3)
        for match in _SCENE_TIME.finditer(result.stderr)
        if lo < float(match.group(1)) < hi
    })
    boundaries = [lo, *cuts, hi]
    return list(zip(boundaries, boundaries[1:], strict=False))


def detect_scenes(
    video_path: Path,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
) -> list[tuple[float, float]]:
    """Detect cuts; return (start_seconds, end_seconds) per scene.

    ``start/end`` bound the scan — a focused watch of one minute must not
    decode a whole hour of video (live finding: 10 min of decode for a 60 s
    window on a slow machine). An empty list means the video is effectively
    one static shot — callers fall back to uniform sampling.
    """
    if sys.platform == "darwin":
        return _detect_scenes_with_ffmpeg(video_path, start_seconds, end_seconds)

    detect, ContentDetector = _import_scenedetect()
    try:
        scene_list = detect(
            str(video_path),
            ContentDetector(),
            start_time=start_seconds,
            end_time=end_seconds,
        )
    except TypeError:
        # older scenedetect without start/end kwargs — full scan fallback
        try:
            scene_list = detect(str(video_path), ContentDetector())
        except Exception as exc:
            raise PerceptionError(
                f"scene detection failed: {exc}",
                code="perceive.scene_detection_failed",
                fix="the media may be corrupt or zero-length — re-acquire it, "
                "or watch with --transcript-only",
                details={"path": str(video_path)},
            ) from exc
    except Exception as exc:  # scenedetect raises plain Exceptions on bad media
        raise PerceptionError(
            f"scene detection failed: {exc}",
            code="perceive.scene_detection_failed",
            fix="the media may be corrupt or zero-length — re-acquire it, "
            "or watch with --transcript-only",
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
