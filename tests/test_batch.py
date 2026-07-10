"""B4 — batch mode: source expansion, resilience, and the one-memory payoff."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill import batch as batch_mod  # noqa: E402
from watch_skill.batch import BatchResult, expand_source, watch_batch  # noqa: E402
from watch_skill.errors import AcquisitionError  # noqa: E402

# --- expansion -----------------------------------------------------------------

def test_expand_folder_lists_videos_oldest_first(tmp_path: Path) -> None:
    folder = tmp_path / "drop folder"
    folder.mkdir()
    (folder / "b.mp4").write_bytes(b"x")
    (folder / "ignore.txt").write_text("no")
    (folder / "a.webm").write_bytes(b"x")
    import os
    import time

    old = time.time() - 100
    os.utime(folder / "b.mp4", (old, old))
    expanded = expand_source(str(folder))
    assert [Path(p).name for p in expanded] == ["b.mp4", "a.webm"]


def test_expand_single_url_passes_through() -> None:
    assert expand_source("https://youtu.be/xyz") == ["https://youtu.be/xyz"]


def test_expand_playlist_url_routes_to_flat_extraction(monkeypatch) -> None:
    seen = {}

    def fake_expand(url, limit=50):
        seen["url"] = url
        return ["https://youtu.be/a", "https://youtu.be/b"]

    monkeypatch.setattr(batch_mod, "expand_playlist", fake_expand)
    out = expand_source("https://www.youtube.com/playlist?list=PL123")
    assert out == ["https://youtu.be/a", "https://youtu.be/b"]
    assert seen["url"].endswith("list=PL123")


def test_empty_batch_is_structured_error(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(AcquisitionError) as exc:
        watch_batch(str(empty))
    assert exc.value.code == "acquire.batch_empty"


# --- the batch run ---------------------------------------------------------------

def test_watch_batch_indexes_all_and_survives_failures(
    tmp_path: Path, sample_video: Path, monkeypatch
) -> None:
    """3 videos + 1 broken file: 3 indexed, 1 failed, batch completes."""
    import shutil

    folder = tmp_path / "library"
    folder.mkdir()
    for name in ("one.mp4", "two.mp4", "three.mp4"):
        shutil.copy2(sample_video, folder / name)
    (folder / "broken.mp4").write_bytes(b"this is not a video")

    result = watch_batch(
        str(folder),
        out_dir=None,
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    assert len(result.items) == 4
    assert len(result.indexed) == 3
    assert len(result.failed) == 1
    assert result.failed[0].source.endswith("broken.mp4")
    assert all(i.video_id for i in result.indexed)

    report = result.report()
    assert "3/4 indexed" in report and "FAILED" in report


def test_batch_builds_one_cross_video_memory(tmp_path: Path, sample_video: Path) -> None:
    """After a batch, one search spans every member (the persistent-index payoff)."""
    import shutil

    from watch_skill.index.db import connect
    from watch_skill.index.retrieval import search_videos
    from watch_skill.index.textnorm import normalize_for_search

    folder = tmp_path / "lib two"
    folder.mkdir()
    shutil.copy2(sample_video, folder / "alpha.mp4")
    shutil.copy2(sample_video, folder / "beta.mp4")
    result = watch_batch(
        str(folder), run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    assert len(result.indexed) == 2
    # give each video a distinct searchable line, as captions would have
    conn = connect()
    try:
        with conn:
            for item, text in zip(result.indexed, ("the red warning screen appears",
                                                   "the calibration bars are shown"), strict=True):
                conn.execute(
                    "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
                    "VALUES (?, ?, ?, 'segment', 1, 1.0)",
                    (text, normalize_for_search(text), item.video_id),
                )
    finally:
        conn.close()

    groups = search_videos("warning screen")
    hit_ids = {g["video"]["id"] for g in groups}
    assert result.indexed[0].video_id in hit_ids


def test_batch_result_report_shape() -> None:
    result = BatchResult()
    from watch_skill.batch import BatchItem

    result.items.append(BatchItem(source="s", status="indexed", video_id="v1",
                                  title="T", duration_seconds=61.0))
    text = result.report()
    assert "1/1 indexed" in text and "01:01" in text and "T" in text
