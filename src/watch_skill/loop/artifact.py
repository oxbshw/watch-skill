"""Shareable proof: side-by-side before/after MP4 + GIF via ffmpeg."""
from __future__ import annotations

import subprocess
from pathlib import Path

from watch_skill.errors import LoopError
from watch_skill.health.binaries import require_binary


def _run_ffmpeg(args: list[str], dest: Path, timeout: float = 600.0) -> None:
    ffmpeg = require_binary("ffmpeg")
    result = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    if result.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        raise LoopError(
            "artifact rendering failed",
            code="loop.artifact_failed",
            details={"stderr": result.stderr[-800:], "dest": str(dest)},
        )


_LABELS = (
    "drawtext=text='BEFORE':x=20:y=20:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[l0]",
    "drawtext=text='AFTER':x=20:y=20:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[l1]",
)


def _side_by_side_filter(labels: bool) -> str:
    scale = (
        "[0:v]scale=640:-2,fps=12[v0];[1:v]scale=640:-2,fps=12[v1];"
    )
    if labels:
        return (
            scale
            + f"[v0]{_LABELS[0]};[v1]{_LABELS[1]};[l0][l1]hstack=inputs=2[out]"
        )
    return scale + "[v0][v1]hstack=inputs=2[out]"


def render_before_after(
    before_video: Path, after_video: Path, out_dir: Path, labels: bool = True
) -> dict[str, Path]:
    """Render {mp4, gif} side-by-side comparisons of two recordings.

    Falls back to unlabeled output when drawtext lacks a usable font (some
    minimal ffmpeg builds), so the artifact is never silently skipped.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    mp4 = out_dir / "before_after.mp4"
    gif = out_dir / "before_after.gif"
    inputs = ["-i", str(before_video), "-i", str(after_video)]

    try:
        _run_ffmpeg(
            [*inputs, "-filter_complex", _side_by_side_filter(labels=True),
             "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast",
             "-pix_fmt", "yuv420p", "-an", str(mp4)],
            mp4,
        )
    except LoopError:
        if not labels:
            raise
        _run_ffmpeg(
            [*inputs, "-filter_complex", _side_by_side_filter(labels=False),
             "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast",
             "-pix_fmt", "yuv420p", "-an", str(mp4)],
            mp4,
        )

    # GIF from the rendered mp4: palette pass keeps it small and legible.
    _run_ffmpeg(
        ["-i", str(mp4), "-vf",
         "fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
         str(gif)],
        gif,
    )
    return {"mp4": mp4, "gif": gif}
