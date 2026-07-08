"""Minimal video generator: renders a 3s title-card video from a text file.

Stand-in for Manim/Remotion in the video-gen loop demo — any command that
writes a video file works the same way. Usage:

    python render_title_card.py <title_file> <output_mp4>
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


def main() -> int:
    title_file, output = Path(sys.argv[1]), Path(sys.argv[2])
    title = title_file.read_text(encoding="utf-8").strip()

    frame = Path(tempfile.mkdtemp(prefix="titlecard-")) / "card.png"
    img = Image.new("RGB", (640, 360), (18, 32, 58))
    draw = ImageDraw.Draw(img)
    draw.rectangle([(30, 140), (610, 220)], fill=(240, 178, 30))
    draw.text((60, 170), title, fill=(18, 32, 58))
    img.save(frame)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:  # the doctor-managed bin dir (Windows bootstrap)
        from watch_skill.config import get_settings

        ffmpeg = str(get_settings().bin_dir / "ffmpeg.exe")
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-t", "3", "-i", str(frame),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(output),
        ],
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
