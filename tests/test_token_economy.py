"""Token economy surfaces: text-first MCP asks, savings meter, forget,
telegraphic descriptions, and the report_mistake/stats tools."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

pytest.importorskip("fastmcp", reason="mcp extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

from agentvision.index import index_watch_result  # noqa: E402
from agentvision.transcribe.types import Segment, Transcript  # noqa: E402
from agentvision.watch import watch  # noqa: E402
from fastmcp import Client  # noqa: E402

from surfaces.mcp_server.server import mcp  # noqa: E402


def _call(tool: str, **kwargs):
    async def _run():
        async with Client(mcp) as client:
            return await client.call_tool(tool, kwargs)

    return asyncio.run(_run())


@pytest.fixture()
def indexed(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video), out_dir=tmp_path / "econ work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "the red warning screen appears first"),
            Segment(4.5, 7.5, "then the colorful calibration bars show up"),
        ],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


def test_new_tools_registered() -> None:
    async def _list():
        async with Client(mcp) as client:
            return {t.name for t in await client.list_tools()}

    names = asyncio.run(_list())
    assert {"report_mistake", "stats"} <= names
    # COMPAT: every v0.5 tool still present under its old name
    assert {"watch_video", "ask_video", "get_moment", "search_videos",
            "list_videos", "capture", "loop_start", "loop_iterate",
            "loop_status", "doctor", "get_status"} <= names


def test_ask_video_is_text_first(indexed: str) -> None:
    """A confidently-answerable question returns ZERO image blocks by default."""
    result = _call(
        "ask_video", video=indexed, question="when do the calibration bars show up?"
    )
    images = [c for c in result.content if c.type == "image"]
    assert images == [], "text-first: no frames unless asked or unverified"
    text = result.content[0].text
    assert "confidence:" in text
    assert "tokens saved vs raw-frame injection" in text


def test_ask_video_include_frames_attaches(indexed: str) -> None:
    result = _call(
        "ask_video", video=indexed,
        question="when do the calibration bars show up?", include_frames=True,
    )
    images = [c for c in result.content if c.type == "image"]
    assert images, "include_frames=true must attach evidence frames"


def test_ask_video_cached_flag_on_repeat(indexed: str) -> None:
    _call("ask_video", video=indexed, question="what appears after the warning?")
    repeat = _call("ask_video", video=indexed, question="what appears after the warning?")
    assert "cached: true" in repeat.content[0].text


def test_report_mistake_tool_roundtrip(indexed: str) -> None:
    result = _call(
        "report_mistake",
        video=indexed,
        question="what appears after the warning screen?",
        wrong_answer="a black screen",
        correction="look closer — the colorful calibration bars show up",
        session_id="mcp-sess",
    )
    text = result.content[0].text
    assert '"lesson_id"' in text
    assert '"error_class"' in text


def test_stats_tool_reports_savings(indexed: str) -> None:
    _call("ask_video", video=indexed, question="when do the bars appear?")
    result = _call("stats")
    assert "tokens saved" in result.content[0].text


def test_forget_removes_video_and_answers(indexed: str) -> None:
    from agentvision.answer import answer_question
    from agentvision.errors import IndexError_
    from agentvision.index.db import connect
    from agentvision.index.store import forget_video, get_video

    answer_question(indexed, "when do the bars appear?")  # populate the cache
    forget_video(indexed)
    assert get_video(indexed) is None
    conn = connect()
    try:
        for table in ("segments", "scenes", "ocr_blocks", "embeddings", "answers"):
            n = conn.execute(
                f"SELECT COUNT(*) AS n FROM {table} WHERE video_id = ?", (indexed,)
            ).fetchone()["n"]
            assert n == 0, f"{table} rows survived forget"
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM fts WHERE video_id = ?", (indexed,)
        ).fetchone()["n"]
        assert n == 0
    finally:
        conn.close()
    with pytest.raises(IndexError_):
        forget_video(indexed)  # structured error on unknown id


def test_v05_index_upgrades_losslessly(tmp_path: Path) -> None:
    """A real v0.5 index (schema v4) opened by v0.6 gains the answers table
    via forward migration — and loses NOTHING."""
    import sqlite3

    from agentvision.index.db import MIGRATIONS, migrate, schema_version

    db = tmp_path / "v05 dir" / "index.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        # build exactly what v0.5 shipped: migrations v1..v4
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        for version, migration in enumerate(MIGRATIONS[:4], start=1):
            if callable(migration):
                migration(conn)
            else:
                conn.executescript(migration)
            conn.execute("INSERT INTO schema_version VALUES (?)", (version,))
        conn.execute(
            "INSERT INTO videos (id, source, title, duration_seconds) "
            "VALUES ('v05vid', 'file:///old.mp4', 'legacy video', 42.0)"
        )
        conn.execute(
            "INSERT INTO segments (video_id, start, end, text) "
            "VALUES ('v05vid', 0, 3, 'legacy transcript line')"
        )
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES ('legacy transcript line', 'legacy transcript line', 'v05vid', 'segment', 1, 0)"
        )
        assert schema_version(conn) == 4

        assert migrate(conn) == len(MIGRATIONS)  # v0.6 opens it -> v5 applies
        # nothing lost
        video = conn.execute("SELECT * FROM videos WHERE id='v05vid'").fetchone()
        assert video["title"] == "legacy video"
        seg = conn.execute("SELECT text FROM segments WHERE video_id='v05vid'").fetchone()
        assert seg["text"] == "legacy transcript line"
        hit = conn.execute(
            "SELECT text FROM fts WHERE fts MATCH 'text_norm:\"legacy\"'"
        ).fetchone()
        assert hit is not None
        # and the new capability exists
        conn.execute(
            "INSERT INTO answers (video_id, question, question_norm, answer_json) "
            "VALUES ('v05vid', 'q', 'q', '{}')"
        )
    finally:
        conn.close()


def test_describe_prompt_is_telegraphic() -> None:
    """The indexing prompt demands compact descriptions (token economy)."""
    from agentvision.vision.model import ClientVisionModel

    captured = {}

    class FakeClient:
        def generate(self, prompt, frames):
            captured["prompt"] = prompt
            return "1: terminal, red error banner"

    model = ClientVisionModel(FakeClient())
    out = model.describe_frames([Path("a.jpg")])
    assert out == ["terminal, red error banner"]
    assert "max 12 words" in captured["prompt"]
    assert "telegraphic" in captured["prompt"]
