"""Audio extraction and overlap-aware chunk planning for STT.

Privacy invariant: this module produces the ONLY artifact that may ever be
sent to a cloud API — mono 16 kHz mp3 audio — and cloud.py refuses to send
even that unless cloud STT is explicitly enabled.
"""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

from agentvision.errors import TranscriptionError
from agentvision.health.binaries import require_binary

MAX_UPLOAD_BYTES = 24 * 1024 * 1024  # margin under both APIs' 25 MB cap
CHUNK_OVERLAP_SECONDS = 2.0  # fixes the reference's words-lost-at-boundary bug


def extract_audio(video_path: Path, out_path: Path) -> Path:
    """Extract mono 16 kHz 64 kbps mp3 (~480 kB/min)."""
    ffmpeg = require_binary("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path.resolve()),
        "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
        str(out_path.resolve()),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0 or not out_path.is_file() or out_path.stat().st_size == 0:
        raise TranscriptionError(
            "audio extraction failed — the video may have no audio track",
            code="transcribe.no_audio",
            details={"stderr": result.stderr[-1000:]},
        )
    return out_path


def audio_duration(audio_path: Path) -> float:
    """Duration in seconds via ffprobe."""
    ffprobe = require_binary("ffprobe")
    result = subprocess.run(
        [
            str(ffprobe), "-v", "quiet", "-print_format", "json", "-show_format",
            str(audio_path.resolve()),
        ],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise TranscriptionError(f"ffprobe failed: {result.stderr[-500:]}")
    fmt = json.loads(result.stdout or "{}").get("format", {})
    return float(fmt.get("duration") or 0.0)


def plan_chunks(
    total_seconds: float,
    total_bytes: int,
    max_bytes: int = MAX_UPLOAD_BYTES,
    overlap: float = CHUNK_OVERLAP_SECONDS,
) -> list[tuple[float, float]]:
    """Split into (offset, duration) chunks under ``max_bytes``, overlapping.

    Constant-bitrate audio scales linearly with time, so an even time split
    yields even sizes. Consecutive chunks share ``overlap`` seconds so words
    straddling a boundary appear in both; the merge step deduplicates them.
    """
    if total_bytes <= max_bytes or total_seconds <= 0:
        return [(0.0, total_seconds)]
    n = math.ceil(total_bytes / max_bytes)
    base = total_seconds / n
    plan: list[tuple[float, float]] = []
    for i in range(n):
        offset = max(0.0, i * base - (overlap if i > 0 else 0.0))
        end = total_seconds if i == n - 1 else (i + 1) * base
        plan.append((round(offset, 3), round(end - offset, 3)))
    return plan


def split_audio(
    full_audio: Path, work_dir: Path, plan: list[tuple[float, float]]
) -> list[tuple[Path, float]]:
    """Slice per-plan chunk files with stream copy; returns (path, offset) pairs."""
    ffmpeg = require_binary("ffmpeg")
    work_dir.mkdir(parents=True, exist_ok=True)
    chunks: list[tuple[Path, float]] = []
    for index, (offset, duration) in enumerate(plan):
        out_path = work_dir / f"chunk_{index:03d}.mp3"
        cmd = [
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{offset:.3f}", "-i", str(full_audio.resolve()),
            "-t", f"{duration:.3f}", "-c", "copy", str(out_path.resolve()),
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
        if result.returncode != 0 or not out_path.is_file() or out_path.stat().st_size == 0:
            raise TranscriptionError(
                f"failed to split audio chunk {index + 1}",
                code="transcribe.chunk_split_failed",
                details={"stderr": result.stderr[-500:]},
            )
        chunks.append((out_path, offset))
    return chunks
