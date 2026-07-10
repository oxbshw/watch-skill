"""CrewAI adapter, live: a REAL watch + ask through the core.

Tools are run directly (`tool.run`) — the exact call path a CrewAI agent
uses once its LLM picks the tool; give your crew an LLM to drive selection.

Run:  uv run --no-sync python examples/09-framework-adapters/crewai_example.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _demo_clip import EXPECTED, QUESTION, make_demo_clip  # noqa: E402

from watch_skill.integrations.crewai import get_watch_tools  # noqa: E402


def main() -> int:
    watch_tool, ask_tool, _search = get_watch_tools()
    clip = make_demo_clip()

    print(f"tool: {watch_tool.name} -> watching {clip}")
    report = str(watch_tool.run(source=str(clip)))
    print(report)
    video_id = report.splitlines()[0].split(":", 1)[1].strip()

    print(f"\ntool: {ask_tool.name} -> {QUESTION}")
    answer = str(ask_tool.run(video_id_or_source=video_id, question=QUESTION))
    print(answer)

    ok = EXPECTED in answer
    print("\nCREWAI ADAPTER:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
