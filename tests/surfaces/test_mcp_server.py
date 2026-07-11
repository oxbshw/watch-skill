"""MCP server end-to-end via the in-process FastMCP client (stdio semantics)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

pytest.importorskip("fastmcp", reason="mcp extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

from fastmcp import Client  # noqa: E402

from watch_skill.surfaces.mcp.server import mcp  # noqa: E402


def _call(tool: str, **kwargs):
    async def _run():
        async with Client(mcp) as client:
            return await client.call_tool(tool, kwargs)

    return asyncio.run(_run())


def test_tools_are_registered() -> None:
    async def _list():
        async with Client(mcp) as client:
            return {t.name for t in await client.list_tools()}

    names = asyncio.run(_list())
    assert {"watch_video", "ask_video", "get_moment", "search_videos", "list_videos", "doctor"} <= names
    # the loop family: v0.6 names unchanged (compat contract) + v0.7 loop types
    assert {"loop_start", "loop_iterate", "loop_status"} <= names
    assert {"loop_video_gen", "loop_game", "loop_monitor"} <= names
    assert {"extract_chapters", "extract_bug_report", "analyze_hook"} <= names
    # v1.0 library layer
    assert {"library_synthesize", "library_overview"} <= names


def test_list_videos_empty() -> None:
    result = _call("list_videos")
    assert "empty" in result.content[0].text


def test_watch_then_ask_roundtrip(sample_video: Path) -> None:
    result = _call(
        "watch_video", source=str(sample_video), question="what colors appear?", budget=8
    )
    text = result.content[0].text
    assert "video_id:" in text
    assert "# watch-skill: video report" in text
    images = [c for c in result.content if c.type == "image"]
    assert images, "watch_video returned no image blocks"

    listing = _call("list_videos")
    assert "sample clip.mp4" in listing.content[0].text or "Indexed videos" in listing.content[0].text

    asked = _call("ask_video", video=str(sample_video), question="what happens first?")
    asked_text = asked.content[0].text
    assert "confidence:" in asked_text
    assert "tokens saved" in asked_text


def test_get_moment_after_watch(sample_video: Path) -> None:
    _call("watch_video", source=str(sample_video), budget=8)
    result = _call("get_moment", video=str(sample_video), timestamp="0:06", window=4.0)
    text = result.content[0].text
    assert "Moment 00:06" in text
    images = [c for c in result.content if c.type == "image"]
    assert images


def test_ask_unknown_video_returns_structured_error() -> None:
    result = _call("ask_video", video="never-indexed", question="anything")
    assert "index.video_not_found" in result.content[0].text


def test_server_source_has_no_mojibake() -> None:
    """Regression: the rebrand rewrite mangled '—'/'±' into mojibake
    ('â€”', 'آ±') inside the server instructions and tool output strings."""
    from watch_skill.surfaces.mcp import server as server_mod

    source = Path(server_mod.__file__).read_text(encoding="utf-8")
    for bad in ("â€", "آ±", "Â±"):
        assert bad not in source, f"mojibake {bad!r} in server.py"


def test_frame_cap_respected(sample_video: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_RESPONSE_FRAME_CAP", "3")
    from watch_skill.config import reset_settings

    reset_settings()
    result = _call("watch_video", source=str(sample_video), budget=10)
    images = [c for c in result.content if c.type == "image"]
    assert len(images) <= 3
