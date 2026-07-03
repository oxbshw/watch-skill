"""M3 acceptance demo: THE LOOP on a deliberately broken checkout page.

Flow (exactly the agent handshake the MCP tools expose):
  1. loop_start on the broken page  -> critic finds the "$NaN" total (fail)
  2. the "agent" (this script) applies the fix by swapping in the fixed HTML
  3. loop_iterate                   -> critic passes, diff reports the issue
                                       FIXED, before/after MP4+GIF rendered

Critic selection: the real strong-tier vision critic when an API key is
configured; otherwise a deterministic OCR-based critic so the demo runs on a
machine with no cloud access (the loop machinery is identical either way).

Run:  uv run python "examples/loop_demo/run_demo.py"
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from agentvision.config import get_settings
from agentvision.errors import VisionError
from agentvision.loop import Critique, Issue, loop_iterate, loop_start
from agentvision.loop.reportfmt import format_loop_state
from agentvision.perceive.types import PerceptionResult
from agentvision.vision import get_vision

HERE = Path(__file__).resolve().parent


def ocr_critic(perception: PerceptionResult, pass_criteria: str) -> Critique:
    """Deterministic fallback critic: reads the rendered total via OCR.

    Fails when any frame's OCR shows a NaN/placeholder total — the same visual
    defect the vision critic would flag, minus the API call.
    """
    for frame in perception.frames:
        text = frame.ocr_text.lower()
        if "nan" in text or "$--" in text:
            return Critique(
                verdict="fail",
                score=35,
                summary="Checkout total renders as NaN instead of a price.",
                issues=[
                    Issue(
                        timestamp=frame.timestamp_seconds,
                        severity="critical",
                        description="Total shows 'TOTAL: $NaN' — price computation is broken.",
                        suggested_fix="Parse prices as numbers before summing (Number(p) or parseFloat).",
                    )
                ],
            )
    return Critique(
        verdict="pass",
        score=96,
        summary="Checkout total renders a real price; no visual defects found.",
        issues=[],
    )


def pick_critic():
    """Real vision critic when a key is configured, OCR fallback otherwise."""
    try:
        get_vision("strong").client._api_key()
        print("critic: strong-tier vision model")
        return None  # runner default = critique_recording
    except VisionError:
        print("critic: no vision API key configured -> deterministic OCR critic")
        return ocr_critic


def main() -> int:
    page = Path(tempfile.mkdtemp(prefix="agentvision-demo-")) / "page.html"
    shutil.copy2(HERE / "page_broken.html", page)
    url = page.as_uri()
    criteria = (
        "The checkout page must show a real dollar total (like $29.00), "
        "never NaN or a placeholder, and the BUY NOW button label must be readable."
    )
    critic = pick_critic()

    print(f"\n=== iteration 0: capture the BROKEN page ===\n{url}")
    state = loop_start(url, criteria, duration_seconds=5.0, critic_override=critic)
    print(format_loop_state(state))
    if state.iterations[0]["critique"]["verdict"] != "fail":
        print("\nDEMO FAILED: critic did not flag the broken page")
        return 1

    print("\n=== agent applies the suggested fix (swap in fixed HTML) ===")
    shutil.copy2(HERE / "page_fixed.html", page)

    print("\n=== iteration 1: re-capture + diff vs previous ===")
    state = loop_iterate(state.loop_id, critic_override=critic)
    print(format_loop_state(state))

    last = state.iterations[-1]
    ok = (
        state.status == "passed"
        and last["diff"] is not None
        and len(last["diff"]["fixed"]) >= 1
        and last["artifacts"] is not None
        and Path(last["artifacts"]["gif"]).is_file()
        and Path(last["artifacts"]["mp4"]).is_file()
    )
    loops_dir = get_settings().loops_dir / state.loop_id
    print(f"\nloop dir: {loops_dir}")
    print("DEMO PASSED" if ok else "DEMO FAILED: see state above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
