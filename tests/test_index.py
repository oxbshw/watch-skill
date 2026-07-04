"""Index: schema migrations, store/retrieve roundtrip, hybrid search, moments."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from agentvision.errors import IndexError_  # noqa: E402
from agentvision.index import (  # noqa: E402
    ask_video,
    get_moment,
    get_video,
    index_watch_result,
    list_videos,
    search_videos,
    video_id_for,
)
from agentvision.index.db import MIGRATIONS, connect, migrate, schema_version  # noqa: E402
from agentvision.watch import watch  # noqa: E402


@pytest.fixture()
def indexed_video(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video),
        out_dir=tmp_path / "work dir",
        run_ocr=False,
        allow_local_whisper=False,
        allow_cloud_stt=False,
    )
    # synthesized clip has no speech; inject a fake transcript so text
    # retrieval has something to find (transcription itself is tested live)
    from agentvision.transcribe.types import Segment, Transcript

    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "the red warning screen appears first"),
            Segment(4.5, 7.5, "then the colorful calibration bars show up"),
            Segment(8.5, 11.5, "finally the moving test pattern with a counter"),
        ],
        source="captions",
    )
    return index_watch_result(result)


def test_schema_version_and_migrations(tmp_path: Path) -> None:
    db_path = tmp_path / "idx dir" / "index.db"
    conn = connect(db_path)
    try:
        assert schema_version(conn) == len(MIGRATIONS)
        assert migrate(conn) == len(MIGRATIONS)  # idempotent
        tables = {
            r["name"]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {"videos", "segments", "scenes", "ocr_blocks", "embeddings"} <= tables
    finally:
        conn.close()


def test_index_roundtrip(indexed_video: str) -> None:
    video = get_video(indexed_video)
    assert video is not None
    assert video["duration_seconds"] > 10
    assert video["transcript_source"] == "captions"
    assert [v["id"] for v in list_videos()] == [indexed_video]


def test_frames_persist_outside_workdir(indexed_video: str, isolated_settings: Path) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT frame_path FROM scenes WHERE video_id = ?", (indexed_video,)
        ).fetchall()
    finally:
        conn.close()
    assert rows
    for row in rows:
        path = Path(row["frame_path"])
        assert path.is_file()
        assert str(path).startswith(str(isolated_settings))


def test_reindex_replaces_rows(sample_video: Path, tmp_path: Path, indexed_video: str) -> None:
    result = watch(
        str(sample_video), out_dir=tmp_path / "work 2", run_ocr=False,
        allow_local_whisper=False, allow_cloud_stt=False,
    )
    second_id = index_watch_result(result)
    assert second_id == indexed_video
    conn = connect()
    try:
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM videos WHERE id = ?", (second_id,)
        ).fetchone()["n"]
    finally:
        conn.close()
    assert count == 1


def test_ask_video_retrieves_relevant_segment(indexed_video: str) -> None:
    result = ask_video(indexed_video, "when do the calibration bars appear?")
    assert result["hits"], "no hits returned"
    top_texts = " ".join(h["text"] for h in result["hits"][:3])
    assert "calibration" in top_texts
    # frames come from near the hit timestamps
    assert result["frames"]
    assert all(Path(f["frame_path"]).is_file() for f in result["frames"])


def test_ask_video_by_source_string(sample_video: Path, indexed_video: str) -> None:
    result = ask_video(str(sample_video), "red warning screen")
    assert result["video"]["id"] == indexed_video


def test_ask_unindexed_video_is_structured() -> None:
    with pytest.raises(IndexError_) as excinfo:
        ask_video("nonexistent", "anything")
    assert excinfo.value.code == "index.video_not_found"


def test_search_videos_cross_video(indexed_video: str) -> None:
    groups = search_videos("moving test pattern counter")
    assert groups
    assert groups[0]["video"]["id"] == indexed_video


def test_get_moment_window(indexed_video: str) -> None:
    ctx = get_moment(indexed_video, 6.0, window=4.0)
    assert ctx.frames, "no frames near the moment"
    for frame in ctx.frames:
        assert 3.0 <= frame["timestamp"] <= 9.0
    assert any("calibration" in s["text"] for s in ctx.segments)


def test_video_id_stability() -> None:
    assert video_id_for("https://x.com/v") == video_id_for("https://x.com/v")
    assert video_id_for("a") != video_id_for("b")


def test_search_finds_phrase_across_two_videos(
    sample_video: Path, tmp_path: Path
) -> None:
    """M2 acceptance: search_videos finds a phrase across 2 different videos."""
    import shutil

    from agentvision.transcribe.types import Segment, Transcript

    second_video = tmp_path / "second copy dir" / "another clip.mp4"
    second_video.parent.mkdir(parents=True)
    shutil.copy2(sample_video, second_video)

    ids = []
    for i, path in enumerate((sample_video, second_video)):
        result = watch(
            str(path), out_dir=tmp_path / f"work {i}", run_ocr=False,
            allow_local_whisper=False, allow_cloud_stt=False,
        )
        result.transcript = Transcript(
            segments=[Segment(1.0, 3.0, f"clip {i}: the quarterly revenue chart goes up")],
            source="captions",
        )
        ids.append(index_watch_result(result, describe_scenes=False))
    assert ids[0] != ids[1]

    groups = search_videos("quarterly revenue chart")
    found = {g["video"]["id"] for g in groups}
    assert set(ids) <= found


def test_scene_descriptions_indexed_when_vision_available(
    indexed_video: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agentvision.index import store as store_mod

    class FakeModel:
        def describe_frames(self, frames, context=""):
            return [f"a synthetic scene number {i}" for i in range(len(frames))]

    monkeypatch.setattr("agentvision.vision.get_vision", lambda tier: FakeModel())
    conn = connect()
    try:
        with conn:
            store_mod._maybe_describe_scenes(conn, indexed_video)
        described = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ? AND description IS NOT NULL",
            (indexed_video,),
        ).fetchone()["n"]
    finally:
        conn.close()
    assert described > 0
    groups = search_videos("synthetic scene")
    assert any(g["video"]["id"] == indexed_video for g in groups)


def test_fts_survives_special_characters(indexed_video: str) -> None:
    # FTS5 MATCH syntax characters must not crash free-text questions
    result = ask_video(indexed_video, 'what is "this" AND (that) -thing?')
    assert isinstance(result["hits"], list)


def test_ocr_text_lands_in_index_and_retrieval(sample_video: Path, tmp_path: Path) -> None:
    """OCR-in-index verification (M4): fake OCR blocks are stored, searchable,
    and surfaced by ask_video/get_moment — without needing rapidocr at test time."""
    from agentvision.perceive.types import OcrBlock

    result = watch(
        str(sample_video), out_dir=tmp_path / "ocr work", run_ocr=False,
        allow_local_whisper=False, allow_cloud_stt=False,
    )
    assert result.perception is not None and result.perception.frames
    target = result.perception.frames[0]
    target.ocr_blocks = [
        OcrBlock(text="ERROR CODE 0xDEADBEEF", bbox=(10, 10, 200, 40), confidence=0.97)
    ]
    video_id = index_watch_result(result)

    conn = connect()
    try:
        rows = conn.execute(
            "SELECT text, timestamp FROM ocr_blocks WHERE video_id = ?", (video_id,)
        ).fetchall()
    finally:
        conn.close()
    assert [r["text"] for r in rows] == ["ERROR CODE 0xDEADBEEF"]

    hits = ask_video(video_id, "what error code is shown on screen?")["hits"]
    assert any("0xDEADBEEF" in h["text"] and h["kind"] == "ocr" for h in hits)

    moment = get_moment(video_id, target.timestamp_seconds, window=4)
    assert any("0xDEADBEEF" in o["text"] for o in moment.ocr)


def test_describe_scene_crash_never_sinks_indexing(
    sample_video: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: an unexpected exception in the cheap vision tier crashed
    index_watch_result AFTER the heavy pipeline work. Descriptions are
    opportunistic — any failure must degrade to 'no descriptions'."""
    import agentvision.vision as vision_pkg

    def exploding_get_vision(*args, **kwargs):
        raise AttributeError("simulated mid-upgrade config mismatch")

    monkeypatch.setattr(vision_pkg, "get_vision", exploding_get_vision)
    result = watch(
        str(sample_video), out_dir=tmp_path / "boom work", run_ocr=False,
        allow_local_whisper=False, allow_cloud_stt=False,
    )
    video_id = index_watch_result(result, describe_scenes=True)  # must not raise
    assert get_video(video_id) is not None
