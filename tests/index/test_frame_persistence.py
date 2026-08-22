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

from watch_skill.index.store import _commit_frames, _persist_frames


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
        dest, displaced = _persist_frames(result, "vid0000000000001")
        _commit_frames(displaced)
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
        dest, displaced = _persist_frames(result, "vid0000000000002")
        _commit_frames(displaced)

    leftovers = [p.name for p in dest.parent.iterdir() if p.name != "vid0000000000002"]
    assert not leftovers, f"temporary directories survived: {leftovers}"


def test_a_result_without_perception_still_gets_a_directory(tmp_path, monkeypatch) -> None:
    """transcript-only watches have no frames but still index."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    dest, _ = _persist_frames(_Result(None), "vid0000000000003")
    assert dest.is_dir()


def test_a_failed_copy_leaves_the_previous_frames_in_place(work_frames, tmp_path, monkeypatch) -> None:
    """A broken second pass must not destroy what the first one stored."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    result = _Result(_Perception(work_frames))
    dest, displaced = _persist_frames(result, "vid0000000000004")
    _commit_frames(displaced)
    before = sorted(p.name for p in dest.glob("frame_*.jpg"))
    assert before

    # Second pass fails midway: one source is gone.
    result.perception.frames.append(_Frame(tmp_path / "work" / "missing.jpg"))
    with pytest.raises((FileNotFoundError, OSError, shutil.Error)):
        _persist_frames(result, "vid0000000000004")

    after = sorted(p.name for p in dest.glob("frame_*.jpg"))
    assert after == before, "a failed re-index dropped the frames that were already stored"


# --- publication is coupled to the transaction (issue #18) --------------------


def _committed_frame_paths(video_id: str) -> list[Path]:
    from watch_skill.index.db import connect

    conn = connect()
    try:
        rows = conn.execute(
            "SELECT frame_path FROM scenes WHERE video_id = ? "
            "AND frame_path IS NOT NULL", (video_id,)).fetchall()
    finally:
        conn.close()
    return [Path(row[0]) for row in rows]


def _rename_frames(result, prefix: str) -> None:
    """Give the replacement different filenames, as a re-perception would.

    Scene boundaries move between passes, so the second index of a source
    rarely writes the same names. Identical names hide this bug: the row still
    resolves, to different bytes.
    """
    for i, frame in enumerate(result.perception.frames):
        renamed = frame.path.with_name(f"{prefix}-{i}{frame.path.suffix}")
        frame.path.rename(renamed)
        frame.path = renamed


@pytest.fixture()
def indexed_once(sample_video: Path, tmp_path: Path, monkeypatch):
    """One committed video, and the frame paths its rows point at."""
    from watch_skill import config
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    first = watch(str(sample_video), out_dir=tmp_path / "w1", run_ocr=False,
                  allow_local_whisper=False, allow_cloud_stt=False)
    video_id = index_watch_result(first, describe_scenes=False)
    committed = _committed_frame_paths(video_id)
    assert committed and all(p.is_file() for p in committed)
    return video_id, committed, tmp_path


def test_db_failure_after_frame_stage_keeps_committed_frames(
    indexed_once, sample_video: Path, monkeypatch
) -> None:
    """A rolled-back index must not strand the rows that stayed committed.

    Frames were published to their final directory before the transaction ran
    and the displaced ones were deleted immediately, so a failed write left
    SQLite holding the previous scene rows while their files were gone.
    """
    from watch_skill.index import index_watch_result, store
    from watch_skill.watch import watch

    video_id, committed, tmp_path = indexed_once
    second = watch(str(sample_video), out_dir=tmp_path / "w2", run_ocr=False,
                   allow_local_whisper=False, allow_cloud_stt=False)
    _rename_frames(second, "after")

    def boom(*args, **kwargs):
        raise RuntimeError("injected database failure")

    monkeypatch.setattr(store, "_insert_derived", boom)
    with pytest.raises(RuntimeError, match="injected database failure"):
        index_watch_result(second, describe_scenes=False)

    missing = [p for p in committed if not p.is_file()]
    assert not missing, (
        f"the index still names {len(missing)} frame(s) that no longer exist: "
        f"{[p.name for p in missing]}")


def test_a_failed_index_does_not_publish_the_replacement_frames(
    indexed_once, sample_video: Path, monkeypatch
) -> None:
    """Rolled-back frames must not become authoritative either.

    The committed rows surviving is half the contract; the other half is that
    the frames from the attempt nobody committed are not left sitting in the
    published directory as though they were.
    """
    from watch_skill.index import index_watch_result, store
    from watch_skill.watch import watch

    video_id, committed, tmp_path = indexed_once
    published = committed[0].parent

    second = watch(str(sample_video), out_dir=tmp_path / "w3", run_ocr=False,
                   allow_local_whisper=False, allow_cloud_stt=False)
    _rename_frames(second, "unpublished")

    monkeypatch.setattr(store, "_insert_derived",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no")))
    with pytest.raises(RuntimeError):
        index_watch_result(second, describe_scenes=False)

    stray = sorted(p.name for p in published.glob("unpublished-*"))
    assert not stray, f"frames from a failed index were published: {stray}"
    leftovers = [p.name for p in published.parent.iterdir()
                 if p.name.startswith(".")]
    assert not leftovers, f"rollback left debris in the frames root: {leftovers}"
