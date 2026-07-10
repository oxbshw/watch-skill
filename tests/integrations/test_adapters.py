"""B2 — framework adapters stay thin: framework-native tools wrapping the
shared core calls, nothing more.

Per-framework tests skip when that framework isn't installed; the shared
TOOL_SPECS contract is always tested. Real watch+ask through the adapters is
exercised by examples/09-framework-adapters (live).
"""
from __future__ import annotations

import pytest

from watch_skill.integrations import _core

EXPECTED_NAMES = ["watch_video", "ask_video", "search_videos"]


def _stub_ask(video_id_or_source: str, question: str) -> str:
    """Annotated stand-in — frameworks build tool schemas from annotations,
    so a bare lambda would produce an empty/invalid schema."""
    return "STUBBED"


# --- the shared contract -------------------------------------------------------

def test_tool_specs_shape() -> None:
    assert [s["name"] for s in _core.TOOL_SPECS] == EXPECTED_NAMES
    for spec in _core.TOOL_SPECS:
        assert callable(spec["func"])
        assert len(str(spec["description"])) > 40  # rich enough for an LLM


def test_core_ask_surfaces_structured_error() -> None:
    from watch_skill.errors import IndexError_

    with pytest.raises(IndexError_):
        _core.ask_video("no-such-video", "q?")


def test_core_search_empty_index_is_friendly() -> None:
    assert "no indexed video" in _core.search_videos("anything")


# --- langchain -----------------------------------------------------------------

def test_langchain_tools(monkeypatch) -> None:
    pytest.importorskip("langchain_core", reason="langchain extra not installed")
    from watch_skill.integrations.langchain import get_watch_tools

    monkeypatch.setitem(_core.TOOL_SPECS[1], "func", _stub_ask)
    tools = get_watch_tools()
    assert [t.name for t in tools] == EXPECTED_NAMES
    result = tools[1].invoke({"video_id_or_source": "v1", "question": "what?"})
    assert result == "STUBBED"


# --- openai agents sdk -----------------------------------------------------------

def test_openai_agents_tools(monkeypatch) -> None:
    pytest.importorskip("agents", reason="openai-agents extra not installed")
    import asyncio
    import json

    from watch_skill.integrations.openai_agents import get_watch_tools

    monkeypatch.setitem(_core.TOOL_SPECS[1], "func", _stub_ask)
    tools = get_watch_tools()
    assert [t.name for t in tools] == EXPECTED_NAMES
    from types import SimpleNamespace

    args = json.dumps({"video_id_or_source": "v1", "question": "what?"})
    ctx = SimpleNamespace(tool_name="ask_video", tool_call_id="call_1", tool_arguments=args)
    result = asyncio.run(tools[1].on_invoke_tool(ctx, args))
    assert result == "STUBBED"


# --- crewai ----------------------------------------------------------------------

def test_crewai_tools(monkeypatch) -> None:
    pytest.importorskip("crewai", reason="crewai extra not installed")
    from watch_skill.integrations.crewai import get_watch_tools

    monkeypatch.setitem(_core.TOOL_SPECS[1], "func", _stub_ask)
    tools = get_watch_tools()
    assert [t.name for t in tools] == EXPECTED_NAMES
    result = tools[1].run(video_id_or_source="v1", question="what?")
    assert "STUBBED" in str(result)


# --- llamaindex -------------------------------------------------------------------

def test_llamaindex_tools(monkeypatch) -> None:
    pytest.importorskip("llama_index.core", reason="llamaindex extra not installed")
    from watch_skill.integrations.llamaindex import get_watch_tools

    monkeypatch.setitem(_core.TOOL_SPECS[1], "func", _stub_ask)
    tools = get_watch_tools()
    assert [t.metadata.name for t in tools] == EXPECTED_NAMES
    result = tools[1].call(video_id_or_source="v1", question="what?")
    assert "STUBBED" in str(result)


# --- autogen ---------------------------------------------------------------------

def test_autogen_tools(monkeypatch) -> None:
    pytest.importorskip("autogen_core", reason="autogen extra not installed")
    import asyncio

    from autogen_core import CancellationToken

    from watch_skill.integrations.autogen import get_watch_tools

    monkeypatch.setitem(_core.TOOL_SPECS[1], "func", _stub_ask)
    tools = get_watch_tools()
    assert [t.name for t in tools] == EXPECTED_NAMES
    result = asyncio.run(
        tools[1].run_json(
            {"video_id_or_source": "v1", "question": "what?"}, CancellationToken()
        )
    )
    assert "STUBBED" in str(result)
