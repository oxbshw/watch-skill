"""AutoGen adapter: Watch Skill as AutoGen (v0.4+) function tools.

    from watch_skill.integrations.autogen import get_watch_tools
    agent = AssistantAgent(name="analyst", model_client=client,
                           tools=get_watch_tools())

Requires ``pip install autogen-core`` (``autogen-agentchat`` pulls it in).
"""
from __future__ import annotations

from watch_skill.integrations._core import TOOL_SPECS


def get_watch_tools() -> list:
    """The Watch Skill tool belt as AutoGen ``FunctionTool`` objects."""
    try:
        from autogen_core.tools import FunctionTool
    except ImportError as exc:  # pragma: no cover - exercised only w/o extra
        raise ImportError(
            "autogen-core is not installed. Run: pip install autogen-core"
        ) from exc

    return [
        FunctionTool(spec["func"], description=spec["description"], name=spec["name"])
        for spec in TOOL_SPECS
    ]
