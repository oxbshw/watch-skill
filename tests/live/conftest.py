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
    """No live session — and no browser slot — may outlive its test.

    The lease release is not belt-and-braces. A test that fails midway leaves
    its session unstopped, and without this the browser budget would be
    permanently short by one for the rest of the run: every later browser
    test would then fail for a reason that has nothing to do with what it is
    testing, and the real failure would be buried under the cascade.
    """
    yield
    from watch_skill.live.browser_pool import get_pool
    from watch_skill.live.session import stop_all

    stop_all()
    get_pool().release_all()


def _draw_frames(out_dir: Path, halves: list[tuple[str, str]], seconds: float,
                 fps: int, size: tuple[int, int],
                 tail_seconds: float | None = None) -> None:
    """Render the frame sequence with Pillow.

    Not ffmpeg's ``drawtext``: it needs a font file, and this machine's build
    segfaults without one. Pillow's default font is scalable from 10.x and
    ships with the dependency we already have, so the fixture works the same
    on every platform CI runs on.
    """
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.load_default(size=110)
    index = 0
    for position, (colour, text) in enumerate(halves):
        last = position == len(halves) - 1
        span = tail_seconds if (last and tail_seconds is not None) else seconds
        for _ in range(int(span * fps)):
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
def audiovisual_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A 14 s clip with both a visual state change and a real audio track.

    The audio is a generated tone pattern, not speech: this fixture exists to
    prove the audio *transport* — that real PCM bytes flow through the
    production ffmpeg path with correct timestamps. Recognition is proved
    separately, by the deterministic backend for the transport and by the
    local-whisper test when the optional model is installed.
    """
    pytest.importorskip("PIL", reason="Pillow renders the fixture's on-screen text")
    out_dir = tmp_path_factory.mktemp("live av")
    frames_dir = out_dir / "src"
    frames_dir.mkdir()
    fps = 10
    _draw_frames(frames_dir, [("darkgreen", "READY"), ("darkred", "ERROR 502")],
                 seconds=7.0, fps=fps, size=(640, 360))

    silent = out_dir / "silent.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-framerate", str(fps),
         "-i", str(frames_dir / "src_%05d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), str(silent)],
        check=True, capture_output=True,
    )

    combined = out_dir / "with audio.mp4"
    # Two tones so the two halves differ in sound as well as in picture,
    # which makes an audio/video correlation assertion meaningful.
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-i", str(silent),
         "-f", "lavfi", "-i", "sine=frequency=440:duration=7:sample_rate=16000",
         "-f", "lavfi", "-i", "sine=frequency=880:duration=7:sample_rate=16000",
         "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]",
         "-map", "0:v", "-map", "[a]", "-c:v", "copy",
         "-c:a", "aac", "-shortest", str(combined)],
        check=True, capture_output=True,
    )
    return combined


@pytest.fixture(scope="session")
def state_change_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """READY for 7 s, then ERROR 502 for 20 s.

    Two halves with different colours AND different text, so both the scene
    detector and the OCR detector have something unambiguous to find. The
    change sits at seven seconds, and everything after it is margin: the test
    it serves distinguishes "reported while playing" from "reported once the
    file was fully read", and it can only do that while the source is still
    playing when the report arrives.

    Seven seconds of margin was not enough. A loaded Windows runner reported
    the change at 13.5 s — correctly, and after the source had finished — and
    the test read that as batch processing. Twenty seconds is chosen for the
    slow machine rather than the fast one.

    Lengthening the tail cannot make a batch pipeline pass. A pipeline that
    ingests the whole file before reporting still reports after the source
    ends, whatever the file's length; the margin only removes the case where a
    genuinely streaming pipeline is too far behind to be observed streaming.
    """
    pytest.importorskip("PIL", reason="Pillow renders the fixture's on-screen text")
    out_dir = tmp_path_factory.mktemp("live clips")
    frames_dir = out_dir / "src"
    frames_dir.mkdir()
    fps = 10
    _draw_frames(frames_dir, [("darkgreen", "READY"), ("darkred", "ERROR 502")],
                 seconds=7.0, fps=fps, size=(640, 360), tail_seconds=20.0)

    combined = out_dir / "state change.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-framerate", str(fps),
         "-i", str(frames_dir / "src_%05d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), str(combined)],
        check=True, capture_output=True,
    )
    return combined
