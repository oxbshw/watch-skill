"""Video-gen loop demo: generate -> watch -> judge -> fix generator -> pass.

The generator is a tiny PIL+ffmpeg title-card renderer (stand-in for
Manim/Remotion/any command that writes a video). Its first version renders
the WRONG title; the "agent" (this script) fixes the generator's input
between iterations, exactly as a real agent would edit scene code.

Run:  uv run --no-sync python examples/08-loop-types/video_gen_loop.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from watch_skill.loop import loop_iterate, loop_video_gen
from watch_skill.loop.reportfmt import format_loop_state

WORK = Path(tempfile.mkdtemp(prefix="watch-skill-videogen-"))
GENERATOR = Path(__file__).resolve().parent / "render_title_card.py"
OUTPUT = WORK / "render.mp4"
TITLE_FILE = WORK / "title.txt"


def main() -> int:
    TITLE_FILE.write_text("UNTITLED DRAFT", encoding="utf-8")  # the bug
    cmd = f'"{sys.executable}" "{GENERATOR}" "{TITLE_FILE}" "{OUTPUT}"'
    spec = (
        "The video must show the launch title card reading LAUNCH DAY "
        "(like LAUNCH DAY), never UNTITLED or a draft placeholder."
    )

    print("=== iteration 0: generate + watch the WRONG render ===")
    state = loop_video_gen(spec, cmd, str(OUTPUT), max_iterations=3)
    print(format_loop_state(state))
    if state.iterations[0]["critique"]["verdict"] != "fail":
        print("DEMO FAILED: critic accepted the wrong title")
        return 1

    print("\n=== agent fixes the generator input ===")
    TITLE_FILE.write_text("LAUNCH DAY", encoding="utf-8")

    print("\n=== iteration 1: regenerate + verify ===")
    state = loop_iterate(state.loop_id)
    print(format_loop_state(state))

    last = state.iterations[-1]
    ok = (
        state.status == "passed"
        and last["diff"] is not None and len(last["diff"]["fixed"]) >= 1
        and last["artifacts"] is not None
        and Path(last["artifacts"]["gif"]).is_file()
    )
    print("DEMO PASSED" if ok else "DEMO FAILED: see state above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
