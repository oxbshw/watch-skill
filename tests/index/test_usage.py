"""`stats --disk`: where the library's space went, and what to forget.

The index is supposed to grow — it is the product — but it grew silently.
`clean` offered caches, loops, and orphans, and nothing reported the library
itself, so reclaiming space meant guessing a `forget` and re-checking.

The unit that matters is one video, because that is what a person decides
about. A total tells you there is a problem; a per-video breakdown tells you
which one.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.index.usage import human_bytes, index_usage, render_usage


@pytest.fixture()
def library(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Three videos of deliberately different weight."""
    import numpy as np

    from watch_skill import config
    from watch_skill.index import embeddings as emb
    from watch_skill.index.db import connect, migrate

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    conn = connect()
    migrate(conn)
    rng = np.random.default_rng(0)
    root = config.get_settings().data_dir / "frames"

    plan = [("big talk", 200, 10, 8000), ("standup", 40, 4, 4000), ("tiny clip", 5, 1, 1000)]
    for i, (title, vectors, frames, size) in enumerate(plan):
        vid = f"vid{i:013d}"
        fdir = root / vid
        fdir.mkdir(parents=True, exist_ok=True)
        for f in range(frames):
            (fdir / f"frame_{f:04d}.jpg").write_bytes(b"x" * size)
        conn.execute(
            "INSERT INTO videos (id,source,title,duration_seconds,transcript_source,frames_dir)"
            " VALUES (?,?,?,?,?,?)",
            (vid, f"src{i}", title, 60.0, "captions", str(fdir)),
        )
        conn.executemany(
            "INSERT INTO embeddings (video_id,kind,ref_id,timestamp,text,vector,dim)"
            " VALUES (?,?,?,?,?,?,?)",
            [
                (vid, "segment", j, float(j), "t",
                 emb.pack_vector(rng.random(384).astype("float32").tolist()), 384)
                for j in range(vectors)
            ],
        )
    conn.commit()
    conn.close()
    return tmp_path


def test_videos_are_ranked_by_what_they_cost(library) -> None:
    usage = index_usage()
    assert [v.title for v in usage.videos] == ["big talk", "standup", "tiny clip"]
    assert usage.videos[0].total_bytes > usage.videos[-1].total_bytes


def test_frames_and_vectors_are_counted_separately(library) -> None:
    """Which half is heavy decides what to do about it."""
    biggest = index_usage().videos[0]
    assert biggest.frame_count == 10
    assert biggest.frames_bytes == 10 * 8000
    assert biggest.embeddings == 200
    # float32 x 384 dimensions
    assert biggest.embedding_bytes == 200 * 384 * 4
    assert biggest.total_bytes == biggest.frames_bytes + biggest.embedding_bytes


def test_the_totals_include_the_database_itself(library) -> None:
    usage = index_usage()
    assert usage.db_bytes > 0, "the .db file is most of a vector-heavy library"
    assert usage.total_bytes == usage.db_bytes + usage.frames_bytes


def test_top_limits_the_listing_without_changing_the_totals(library) -> None:
    full, limited = index_usage(), index_usage(top=1)
    assert len(limited.videos) == 1
    assert limited.videos[0].title == "big talk"
    assert limited.db_bytes == full.db_bytes
    assert limited.frames_bytes == full.frames_bytes, "a shorter list is not a smaller library"


def test_the_report_names_the_command_that_acts_on_it(library) -> None:
    """A number with no next step is trivia."""
    text = render_usage(index_usage())
    assert "watch-skill forget" in text
    assert "watch-skill clean" in text
    assert "big talk" in text


def test_a_video_whose_frames_were_deleted_still_reports(library, monkeypatch) -> None:
    """`clean --orphans` removes frame dirs; the row outlives them."""
    import shutil

    from watch_skill import config

    frames_root = config.get_settings().data_dir / "frames"
    shutil.rmtree(frames_root / "vid0000000000000")

    usage = index_usage()
    row = next(v for v in usage.videos if v.video_id == "vid0000000000000")
    assert row.frames_bytes == 0
    assert row.frame_count == 0
    assert row.embeddings == 200, "the vectors are still in the database"


def test_an_empty_library_reports_zero_rather_than_failing(tmp_path, monkeypatch) -> None:
    from watch_skill import config
    from watch_skill.index.db import connect, migrate

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "empty"))
    config.reset_settings()
    conn = connect()
    migrate(conn)
    conn.close()

    usage = index_usage()
    assert usage.videos == []
    assert "0 video(s)" in render_usage(usage)


@pytest.mark.parametrize(
    ("size", "expected"),
    [(0, "0 B"), (512, "512 B"), (2048, "2.0 KB"), (5 * 1024**2, "5.0 MB"), (3 * 1024**3, "3.0 GB")],
)
def test_sizes_read_as_sizes(size: int, expected: str) -> None:
    assert human_bytes(size) == expected
