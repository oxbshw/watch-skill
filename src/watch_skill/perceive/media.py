"""ffprobe metadata and single-frame extraction (space-safe, list-args only)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from watch_skill.errors import PerceptionError
from watch_skill.health.binaries import require_binary
from watch_skill.perceive.types import VideoMetadata

MAX_READ_DIMENSION = 1998  # Claude Read tool image-height limit (reference-proven)


def probe(video_path: Path) -> VideoMetadata:
    """Read duration/resolution/fps/codec/audio via ffprobe."""
    ffprobe = require_binary("ffprobe")
    result = subprocess.run(
        [
            str(ffprobe), "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(video_path.resolve()),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise PerceptionError(
            f"ffprobe failed on {video_path.name}",
            code="perceive.probe_failed",
            details={"path": str(video_path), "stderr": result.stderr[-1000:]},
        )
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    fps = None
    rate = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
    if rate and "/" in rate:
        num, _, den = rate.partition("/")
        try:
            fps = round(float(num) / float(den), 3) if float(den) else None
        except ValueError:
            fps = None

    return VideoMetadata(
        duration_seconds=float(fmt.get("duration") or video_stream.get("duration") or 0),
        width=video_stream.get("width"),
        height=video_stream.get("height"),
        fps=fps,
        codec=video_stream.get("codec_name"),
        has_audio=audio_stream is not None,
        size_bytes=int(fmt.get("size") or 0),
    )


def _scale_filter(width: int) -> str:
    return (
        f"scale=w='min({width},iw)':h='min({MAX_READ_DIMENSION},ih)':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )


def extract_frame_at(
    video_path: Path, timestamp_seconds: float, dest: Path, width: int = 512
) -> Path | None:
    """Grab one scaled JPEG at ``timestamp_seconds`` (fast input seek).

    Returns ``None`` (instead of raising) when the seek lands past the end of
    the stream — callers just skip that timestamp.
    """
    ffmpeg = require_binary("ffmpeg")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{max(0.0, timestamp_seconds):.3f}",
        "-i", str(video_path.resolve()),
        "-frames:v", "1",
        "-vf", _scale_filter(width),
        "-q:v", "4",
        str(dest),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        dest.unlink(missing_ok=True)
        return None
    return dest
