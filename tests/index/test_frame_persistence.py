"""Persisting frames must not destroy the frames it is persisting.

`_persist_frames` used to wipe the destination directory and then copy into
it. Because it also repoints each Frame at its new home, the wipe deleted its
own inputs on any second call, and two processes indexing the same video —
the id is derived from content, so they collide by design — raced on one
directory. Both surfaced as a bare FileNotFoundError with an index row left
pointing at frames that no longer existed.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from watch_skill.index.store import _persist_frames


class _Frame:
    def __init__(self, path: Path) -> None:
        self.path = path


class _Perception:
    def __init__(self, frames: list[_Frame]) -> None:
        self.frames = frames


class _Result:
    def __init__(self, perception: _Perception | None) -> None:
        self.perception = perception


@pytest.fixture()
def work_frames(tmp_path: Path) -> list[_Frame]:
    work = tmp_path / "work"
    work.mkdir()
    frames = []
    for i in range(3):
        p = work / f"frame_{i:04d}.jpg"
        p.write_bytes(b"\xff\xd8\xff" + bytes([i]) * 32)
        frames.append(_Frame(p))
    return frames


def test_reindexing_the_same_result_keeps_every_frame(work_frames, tmp_path, monkeypatch) -> None:
    """The retry path: index, then index the very same object again."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    result = _Result(_Perception(work_frames))
    contents = [f.path.read_bytes() for f in work_frames]

    for attempt in range(3):
        dest = _persist_frames(result, "vid0000000000001")
        on_disk = sorted(p.name for p in dest.glob("frame_*.jpg"))
        assert len(on_disk) == 3, f"attempt {attempt}: expected 3 frames, found {on_disk}"
        for frame, original in zip(result.perception.frames, contents, strict=True):
            assert frame.path.is_file(), f"attempt {attempt}: {frame.path} vanished"
            assert frame.path.read_bytes() == original, "frame contents changed"


def test_no_staging_directories_are_left_behind(work_frames, tmp_path, monkeypatch) -> None:
    """Staging and swap must clean up, or the frames root fills with debris."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    result = _Result(_Perception(work_frames))
    for _ in range(3):
        dest = _persist_frames(result, "vid0000000000002")

    leftovers = [p.name for p in dest.parent.iterdir() if p.name != "vid0000000000002"]
    assert not leftovers, f"temporary directories survived: {leftovers}"


def test_a_result_without_perception_still_gets_a_directory(tmp_path, monkeypatch) -> None:
    """transcript-only watches have no frames but still index."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    dest = _persist_frames(_Result(None), "vid0000000000003")
    assert dest.is_dir()


def test_a_failed_copy_leaves_the_previous_frames_in_place(work_frames, tmp_path, monkeypatch) -> None:
    """A broken second pass must not destroy what the first one stored."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    result = _Result(_Perception(work_frames))
    dest = _persist_frames(result, "vid0000000000004")
    before = sorted(p.name for p in dest.glob("frame_*.jpg"))
    assert before

    # Second pass fails midway: one source is gone.
    result.perception.frames.append(_Frame(tmp_path / "work" / "missing.jpg"))
    with pytest.raises((FileNotFoundError, OSError, shutil.Error)):
        _persist_frames(result, "vid0000000000004")

    after = sorted(p.name for p in dest.glob("frame_*.jpg"))
    assert after == before, "a failed re-index dropped the frames that were already stored"
