"""Shared helper: build a small local clip whose content lives in its pixels,
so a real watch+ask through an adapter has something honest to find."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

QUESTION = "What release version number is shown in the video?"
EXPECTED = "3.14"


def _font(size: int = 64):
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_demo_clip() -> Path:
    """A 3-second card announcing a release version (readable by OCR)."""
    work = Path(tempfile.mkdtemp(prefix="watch-skill adapter demo "))
    frame = work / "card.png"
    img = Image.new("RGB", (640, 360), (20, 60, 90))
    draw = ImageDraw.Draw(img)
    draw.text((40, 90), "RELEASE", fill=(255, 255, 255), font=_font(72))
    draw.text((40, 190), f"v{EXPECTED}", fill=(240, 178, 30), font=_font(72))
    img.save(frame)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        from watch_skill.config import get_settings

        ffmpeg = str(get_settings().bin_dir / "ffmpeg.exe")
    out = work / "release clip.mp4"
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-t", "3", "-i", str(frame),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(out)],
        check=True,
    )
    return out
