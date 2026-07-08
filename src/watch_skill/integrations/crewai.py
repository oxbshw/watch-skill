"""CrewAI adapter: Watch Skill as CrewAI tools.

    from watch_skill.integrations.crewai import get_watch_tools
    agent = Agent(role="video analyst", tools=get_watch_tools(), ...)

Requires ``pip install crewai``.
"""
from __future__ import annotations

import functools

from watch_skill.integrations._core import TOOL_SPECS


def _described(func, description: str):
    """A wrapper carrying the rich tool description as its docstring —
    CrewAI reads the docstring; mutating the shared core function would
    leak the change into every other adapter."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)

    wrapper.__doc__ = description
    return wrapper


def get_watch_tools() -> list:
    """The Watch Skill tool belt as CrewAI ``Tool`` objects."""
    try:
        from crewai.tools import tool as crewai_tool
    except ImportError as exc:  # pragma: no cover - exercised only w/o extra
        raise ImportError(
            "crewai is not installed. Run: pip install crewai"
        ) from exc

    return [
        crewai_tool(spec["name"])(_described(spec["func"], spec["description"]))
        for spec in TOOL_SPECS
    ]
