"""LlamaIndex adapter: Watch Skill as LlamaIndex function tools.

    from watch_skill.integrations.llamaindex import get_watch_tools
    agent = FunctionAgent(tools=get_watch_tools(), llm=llm)

Requires ``pip install llama-index-core``.
"""
from __future__ import annotations

from watch_skill.integrations._core import TOOL_SPECS


def get_watch_tools() -> list:
    """The Watch Skill tool belt as LlamaIndex ``FunctionTool`` objects."""
    try:
        from llama_index.core.tools import FunctionTool
    except ImportError as exc:  # pragma: no cover - exercised only w/o extra
        raise ImportError(
            "llama-index-core is not installed. Run: pip install llama-index-core"
        ) from exc

    return [
        FunctionTool.from_defaults(
            fn=spec["func"], name=spec["name"], description=spec["description"]
        )
        for spec in TOOL_SPECS
    ]
