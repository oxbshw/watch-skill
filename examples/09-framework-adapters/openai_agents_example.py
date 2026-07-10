"""OpenAI Agents SDK adapter, live: a REAL watch + ask through the core.

Tools are invoked via their on_invoke_tool handler — the exact call path the
Runner uses once the agent's LLM picks the tool; add your OPENAI_API_KEY and
an Agent(...) to let the model drive selection.

Run:  uv run --no-sync python examples/09-framework-adapters/openai_agents_example.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _demo_clip import EXPECTED, QUESTION, make_demo_clip  # noqa: E402

from watch_skill.integrations.openai_agents import get_watch_tools  # noqa: E402


def _invoke(tool, **kwargs) -> str:
    args = json.dumps(kwargs)
    ctx = SimpleNamespace(tool_name=tool.name, tool_call_id="call_demo", tool_arguments=args)
    return asyncio.run(tool.on_invoke_tool(ctx, args))


def main() -> int:
    watch_tool, ask_tool, _search = get_watch_tools()
    clip = make_demo_clip()

    print(f"tool: {watch_tool.name} -> watching {clip}")
    report = _invoke(watch_tool, source=str(clip))
    print(report)
    video_id = report.splitlines()[0].split(":", 1)[1].strip()

    print(f"\ntool: {ask_tool.name} -> {QUESTION}")
    answer = _invoke(ask_tool, video_id_or_source=video_id, question=QUESTION)
    print(answer)

    ok = EXPECTED in answer
    print("\nOPENAI AGENTS SDK ADAPTER:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
