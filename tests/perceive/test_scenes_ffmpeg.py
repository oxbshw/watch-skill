"""The ffmpeg scene detector: absolute timestamps, and a static-shot contract.

Ported from the approach in oxbshw/watch-skill#15 by @felores, which added an
ffmpeg-only scene path to avoid a PyAV/AVFoundation conflict on macOS. The
timestamp handling is corrected here: `-ss` before `-i` restarts the
presentation clock, so the reported times are relative to the window and must
have the offset added back.

These tests run wherever ffmpeg does. They do **not** emulate macOS, and
nothing here licenses a macOS machine-tested claim.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from watch_skill.errors import PerceptionError
from watch_skill.perceive.scenes import detect_scenes_ffmpeg


def _ffmpeg() -> str:
    binary = shutil.which("ffmpeg")
    if binary is None:
        pytest.skip("ffmpeg not available")
    return binary


@pytest.fixture(scope="module")
def known_cut_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """20 s of video with exactly one hard cut, at 12.0 s.

    Black then white: the largest possible scene score, so the detector's
    threshold is never what the test is measuring.
    """
    out_dir = tmp_path_factory.mktemp("cut clip")
    first, second = out_dir / "a.mp4", out_dir / "b.mp4"
    for path, colour, seconds in ((first, "black", 12), (second, "white", 8)):
        subprocess.run(
            [_ffmpeg(), "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", f"color=c={colour}:s=320x180:d={seconds}:r=10",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
            check=True, capture_output=True,
        )
    listing = out_dir / "list.txt"
    listing.write_text(f"file '{first.as_posix()}'\nfile '{second.as_posix()}'\n",
                       encoding="utf-8")
    combined = out_dir / "known cut.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(combined)],
        check=True, capture_output=True,
    )
    return combined


@pytest.fixture(scope="module")
def static_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """10 s of one unchanging colour — a single continuous shot."""
    out = tmp_path_factory.mktemp("static clip") / "static.mp4"
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", "color=c=navy:s=320x180:d=10:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        check=True, capture_output=True,
    )
    return out


# --- the static-shot contract -------------------------------------------------


def test_a_static_video_reports_no_scenes(static_clip: Path) -> None:
    """Empty means "one continuous shot", and callers uniform-sample.

    Returning a single whole-video span instead would look like a detected
    scene and silently disable that fallback — the contract the existing
    PySceneDetect path already keeps.
    """
    assert detect_scenes_ffmpeg(static_clip) == []


def test_a_static_window_reports_no_scenes(known_cut_clip: Path) -> None:
    """A window that contains no cut is static, even if the video is not."""
    assert detect_scenes_ffmpeg(known_cut_clip, 1.0, 8.0) == []


# --- absolute timestamps ------------------------------------------------------


def test_a_cut_is_found_at_its_absolute_time(known_cut_clip: Path) -> None:
    spans = detect_scenes_ffmpeg(known_cut_clip)
    assert spans, "the cut at 12s was not detected at all"
    boundary = spans[0][1]
    assert boundary == pytest.approx(12.0, abs=0.6), (
        f"cut reported at {boundary}s, expected ~12.0s"
    )


def test_timestamps_are_absolute_inside_a_non_zero_window(
    known_cut_clip: Path,
) -> None:
    """The correction this port exists for.

    `-ss` before `-i` seeks the input and restarts the presentation clock, so
    the cut 2s into a window starting at 10s is reported as pts_time:2.
    Treating that as absolute would put every scene in a focused watch near
    the start of the video — and every citation with it.
    """
    spans = detect_scenes_ffmpeg(known_cut_clip, 10.0, 20.0)
    assert spans, "the cut was not detected inside the window"
    boundary = spans[0][1]
    assert boundary == pytest.approx(12.0, abs=0.6), (
        f"cut reported at {boundary}s — window offset was not added back"
    )
    assert boundary > 10.0, "the timestamp is relative, not absolute"


def test_every_span_lies_inside_the_requested_window(known_cut_clip: Path) -> None:
    spans = detect_scenes_ffmpeg(known_cut_clip, 10.0, 20.0)
    for start, end in spans:
        assert 10.0 <= start < end <= 20.0 + 0.05, (start, end)


def test_spans_are_contiguous_and_ordered(known_cut_clip: Path) -> None:
    spans = detect_scenes_ffmpeg(known_cut_clip)
    for earlier, later in zip(spans, spans[1:], strict=False):
        assert earlier[1] == pytest.approx(later[0], abs=0.001), "a gap between spans"
        assert earlier[0] < earlier[1]


# --- degenerate windows -------------------------------------------------------


def test_an_inverted_window_is_empty_not_an_error(known_cut_clip: Path) -> None:
    assert detect_scenes_ffmpeg(known_cut_clip, 15.0, 5.0) == []


def test_a_zero_width_window_is_empty(known_cut_clip: Path) -> None:
    assert detect_scenes_ffmpeg(known_cut_clip, 5.0, 5.0) == []


def test_a_window_past_the_end_is_empty(known_cut_clip: Path) -> None:
    assert detect_scenes_ffmpeg(known_cut_clip, 500.0, 600.0) == []


# --- failure paths ------------------------------------------------------------


def test_a_missing_file_is_a_structured_error(tmp_path: Path) -> None:
    with pytest.raises(PerceptionError) as raised:
        detect_scenes_ffmpeg(tmp_path / "nope.mp4")
    assert raised.value.fix


def test_corrupt_media_is_a_structured_error(tmp_path: Path) -> None:
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"this is not a video" * 100)
    with pytest.raises(PerceptionError) as raised:
        detect_scenes_ffmpeg(broken)
    assert raised.value.fix, "whether probe or the detector notices first, say what to do"


def _patch_scene_run(monkeypatch: pytest.MonkeyPatch, fake) -> None:
    """Replace subprocess.run for the scene-detect call only.

    `probe()` shells out to ffprobe first, so a blanket patch would break the
    call under test before it ever ran.
    """
    from watch_skill.perceive import scenes

    real = subprocess.run

    def dispatch(command, *args, **kwargs):
        if any("showinfo" in str(part) for part in command):
            return fake(command, *args, **kwargs)
        return real(command, *args, **kwargs)

    monkeypatch.setattr(scenes.subprocess, "run", dispatch)


def test_a_timeout_is_reported_as_a_timeout(
    known_cut_clip: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hung ffmpeg must not hang the watch."""
    def explode(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=900)

    _patch_scene_run(monkeypatch, explode)
    with pytest.raises(PerceptionError) as raised:
        detect_scenes_ffmpeg(known_cut_clip)
    assert raised.value.code == "perceive.scene_detection_timeout"
    assert "--start" in raised.value.fix


def test_a_nonzero_exit_is_a_structured_error(
    known_cut_clip: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Failed:
        returncode = 1
        stderr = "Invalid data found when processing input"

    _patch_scene_run(monkeypatch, lambda *a, **k: Failed())
    with pytest.raises(PerceptionError) as raised:
        detect_scenes_ffmpeg(known_cut_clip)
    assert raised.value.code == "perceive.scene_detection_failed"
    assert raised.value.fix


def test_stderr_is_bounded(known_cut_clip: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`showinfo` prints per selected frame; a pathological source must not
    fill memory with log text."""
    from watch_skill.perceive import scenes

    class Result:
        returncode = 0
        stderr = "pts_time:1.0\n" * 2_000_000

    _patch_scene_run(monkeypatch, lambda *a, **k: Result())
    detect_scenes_ffmpeg(known_cut_clip)  # must not blow up
    assert scenes._STDERR_CAP < 10_000_000
