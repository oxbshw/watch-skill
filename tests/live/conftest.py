"""Deterministic media fixtures for the live tests.

Generated with ffmpeg lavfi rather than checked in: rights-clear, byte-stable
for a given ffmpeg build, and the *content* is the point — a clip whose
on-screen text changes at a known second is what makes "detected the change
before the stream ended" a real assertion rather than a hopeful one.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


def _ffmpeg() -> str:
    binary = shutil.which("ffmpeg")
    if binary is None:
        pytest.skip("ffmpeg not available")
    return binary


@pytest.fixture(autouse=True)
def stop_live_sessions():
    """No live session may outlive its test."""
    yield
    from watch_skill.live.session import stop_all

    stop_all()


def _draw_frames(out_dir: Path, halves: list[tuple[str, str]], seconds: float,
                 fps: int, size: tuple[int, int]) -> None:
    """Render the frame sequence with Pillow.

    Not ffmpeg's ``drawtext``: it needs a font file, and this machine's build
    segfaults without one. Pillow's default font is scalable from 10.x and
    ships with the dependency we already have, so the fixture works the same
    on every platform CI runs on.
    """
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.load_default(size=110)
    index = 0
    for colour, text in halves:
        for _ in range(int(seconds * fps)):
            index += 1
            image = Image.new("RGB", size, colour)
            draw = ImageDraw.Draw(image)
            box = draw.textbbox((0, 0), text, font=font)
            draw.text(
                ((size[0] - (box[2] - box[0])) / 2,
                 (size[1] - (box[3] - box[1])) / 2 - box[1]),
                text, fill="white", font=font,
            )
            image.save(out_dir / f"src_{index:05d}.png")


@pytest.fixture(scope="session")
def state_change_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A 14 s clip that says READY for 7 s, then ERROR 502 for 7 s.

    Two halves with different colours AND different text, so both the scene
    detector and the OCR detector have something unambiguous to find. The
    change sits in the middle, leaving seven seconds of stream after it — the
    margin that lets a test distinguish "reported while playing" from
    "reported once the file was fully read" on a loaded machine.
    """
    pytest.importorskip("PIL", reason="Pillow renders the fixture's on-screen text")
    out_dir = tmp_path_factory.mktemp("live clips")
    frames_dir = out_dir / "src"
    frames_dir.mkdir()
    fps = 10
    _draw_frames(frames_dir, [("darkgreen", "READY"), ("darkred", "ERROR 502")],
                 seconds=7.0, fps=fps, size=(640, 360))

    combined = out_dir / "state change.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-framerate", str(fps),
         "-i", str(frames_dir / "src_%05d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), str(combined)],
        check=True, capture_output=True,
    )
    return combined
