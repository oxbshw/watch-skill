"""Game loop demo: record a running canvas game, catch a state glitch, verify
the fix. The 'game' is a bouncing-ball canvas whose score counter renders NaN
(an uninitialized variable — a classic game-state bug that only shows up
on screen). The loop records real gameplay in a browser and the critic reads
the HUD.

Run:  uv run --no-sync python examples/08-loop-types/game_loop.py
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from watch_skill.loop import loop_game, loop_iterate
from watch_skill.loop.reportfmt import format_loop_state

HERE = Path(__file__).resolve().parent


def main() -> int:
    page = Path(tempfile.mkdtemp(prefix="watch-skill-game-")) / "game.html"
    shutil.copy2(HERE / "game_broken.html", page)
    criteria = (
        "The SCORE counter must show a number (like SCORE: 12), never NaN "
        "or undefined, and the ball must be visible on the canvas."
    )

    print("=== iteration 0: record the GLITCHED game ===")
    # small viewport + short recording keep local-CPU vision times sane
    state = loop_game(
        page.as_uri(), criteria, duration_seconds=5.0, max_iterations=3,
        viewport={"width": 800, "height": 450},
    )
    print(format_loop_state(state))
    if state.iterations[0]["critique"]["verdict"] != "fail":
        print("DEMO FAILED: critic did not catch the NaN score")
        return 1

    print("\n=== agent fixes the game state bug ===")
    shutil.copy2(HERE / "game_fixed.html", page)

    print("\n=== iteration 1: re-record + verify ===")
    state = loop_iterate(state.loop_id)
    print(format_loop_state(state))

    last = state.iterations[-1]
    ok = (
        state.status == "passed"
        and last["diff"] is not None and len(last["diff"]["fixed"]) >= 1
        and last["artifacts"] is not None
    )
    print("DEMO PASSED" if ok else "DEMO FAILED: see state above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
