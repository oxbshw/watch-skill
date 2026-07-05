"""MCP server end-to-end via the in-process FastMCP client (stdio semantics)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

pytest.importorskip("fastmcp", reason="mcp extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

from fastmcp import Client  # noqa: E402

from surfaces.mcp_server.server import mcp  # noqa: E402


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


def test_list_videos_empty() -> None:
    result = _call("list_videos")
    assert "empty" in result.content[0].text


def test_watch_then_ask_roundtrip(sample_video: Path) -> None:
    result = _call(
        "watch_video", source=str(sample_video), question="what colors appear?", budget=8
    )
    text = result.content[0].text
    assert "video_id:" in text
    assert "# agentvision: video report" in text
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


def test_frame_cap_respected(sample_video: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTVISION_RESPONSE_FRAME_CAP", "3")
    from agentvision.config import reset_settings

    reset_settings()
    result = _call("watch_video", source=str(sample_video), budget=10)
    images = [c for c in result.content if c.type == "image"]
    assert len(images) <= 3
