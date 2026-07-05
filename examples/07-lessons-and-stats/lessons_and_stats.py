"""Report a wrong answer, watch Watch Skill learn from it, read the meter.

The self-improve loop end to end:

1. pick an already-indexed video,
2. report a deliberately wrong answer + its correction (`report_mistake`),
3. see the classified lesson — and, for mechanical error classes, the
   immediate re-ask that validates the correction now surfaces,
4. show the lesson in the store, then clean the demo lesson up again,
5. print the lifetime savings meter.

Everything is local (lessons live in ~/.watch-skill/, nothing uploaded)
and offline. Needs at least one indexed video — run example 01 first on a
fresh machine.

Run:  uv run --no-sync python examples/07-lessons-and-stats/lessons_and_stats.py
"""
from __future__ import annotations

import json
import sys

from watch_skill.answer.cache import lifetime_stats
from watch_skill.index import list_videos
from watch_skill.lessons import list_lessons, remove_lessons, report_mistake

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    videos = list_videos()
    if not videos:
        print("The index is empty — run examples/01-watch-and-ask first.")
        return 1
    video = videos[0]
    print(f"using indexed video: {video['id']} — {video['title'] or video['source']}\n")

    # A correction phrased around on-screen text classifies as missed-ocr,
    # which is mechanical enough for an immediate re-ask validation.
    outcome = report_mistake(
        video["id"],
        question="what does the on-screen text say?",
        wrong_answer="there is no on-screen text",
        correction=f"the on-screen text shows the title {video['title'] or 'of the video'}",
        agent="example-07",
        session_id="example-07-demo",
    )
    print("--- report_mistake outcome ---")
    print(json.dumps(outcome, ensure_ascii=False, indent=2))

    print("\n--- the lesson in the store ---")
    for row in list_lessons(session_id="example-07-demo"):
        mark = "validated" if row["validated"] else "stored"
        print(f"#{row['id']} [{mark}] {row['error_class']} ({row['content_type']}): {row['guidance']}")

    removed = remove_lessons(session_id="example-07-demo")
    print(f"\n(demo lesson cleaned up: removed {removed})")
    print("keep real lessons instead: `watch-skill lessons add ...` or the "
          "report_mistake MCP tool, then `watch-skill evals run` to measure learning")

    stats = lifetime_stats()
    print("\n--- lifetime savings meter ---")
    print(f"answers served : {stats['answers_count']}")
    print(f"tokens saved   : ~{stats['tokens_saved_total']:,} vs raw-frame injection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
