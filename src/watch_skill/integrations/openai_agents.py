"""OpenAI Agents SDK adapter: Watch Skill as function tools.

    from watch_skill.integrations.openai_agents import get_watch_tools
    agent = Agent(name="video analyst", tools=get_watch_tools())

Requires ``pip install openai-agents``.
"""
from __future__ import annotations

from watch_skill.integrations._core import TOOL_SPECS


def get_watch_tools() -> list:
    """The Watch Skill tool belt as Agents-SDK ``FunctionTool`` objects."""
    try:
        from agents import function_tool
    except ImportError as exc:  # pragma: no cover - exercised only w/o extra
        raise ImportError(
            "openai-agents is not installed. Run: pip install openai-agents"
        ) from exc

    return [
        function_tool(
            spec["func"],
            name_override=spec["name"],
            description_override=spec["description"],
        )
        for spec in TOOL_SPECS
    ]
