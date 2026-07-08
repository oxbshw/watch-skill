"""LangChain adapter: Watch Skill as LangChain tools.

Thin by contract — three ``StructuredTool``s over the shared core calls.

    from watch_skill.integrations.langchain import get_watch_tools
    agent = create_agent(model, tools=get_watch_tools())

Requires ``pip install langchain-core`` (any framework using langchain-core
tools — LangChain, LangGraph — consumes these unchanged).
"""
from __future__ import annotations

from watch_skill.integrations._core import TOOL_SPECS


def get_watch_tools() -> list:
    """The Watch Skill tool belt as LangChain ``StructuredTool`` objects."""
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as exc:  # pragma: no cover - exercised only w/o extra
        raise ImportError(
            "langchain-core is not installed. Run: pip install langchain-core"
        ) from exc

    return [
        StructuredTool.from_function(
            func=spec["func"], name=spec["name"], description=spec["description"]
        )
        for spec in TOOL_SPECS
    ]
