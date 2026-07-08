"""THE LOOP: capture a page -> critique -> apply a fix -> re-capture -> verify.

The demo runs the exact agent handshake the MCP `loop_start` / `loop_iterate`
tools expose, against a deliberately broken checkout page:

  1. loop_start on the broken page  -> critic finds the "$NaN" total (fail)
  2. the "agent" (this script) applies the fix by swapping in the fixed HTML
  3. loop_iterate                   -> critic passes; the diff reports the
                                       issue FIXED and renders a
                                       before/after MP4 + GIF

Critic selection: the real strong-tier vision critic when a vision provider
is reachable; otherwise a deterministic OCR-based critic, so the demo runs
on a machine with no cloud access (the loop machinery is identical).

Needs a browser for capture (Edge/Chrome, or `playwright install chromium`).

Run:  uv run --no-sync python examples/04-ui-loop/ui_loop.py
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.loop import Critique, Issue, loop_iterate, loop_start
from watch_skill.loop.reportfmt import format_loop_state
from watch_skill.perceive.types import PerceptionResult
from watch_skill.vision import get_vision

HERE = Path(__file__).resolve().parent


def ocr_critic(perception: PerceptionResult, pass_criteria: str) -> Critique:
    """Deterministic fallback critic: reads the rendered total via OCR.

    Fails when any frame's OCR shows a NaN/placeholder total — the same
    visual defect the vision critic would flag, minus the API call.
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
    """Real vision critic when the provider answers a probe, OCR fallback otherwise.

    The probe attaches an image: captioning models (moondream) reply to a
    describe-an-image request but return nothing for text-only prompts, so a
    text probe would wrongly send a working vision setup to the OCR fallback.
    """
    import tempfile

    try:
        from PIL import Image

        probe = Path(tempfile.mkdtemp(prefix="watch-skill-probe-")) / "probe.png"
        Image.new("RGB", (64, 64), (200, 30, 30)).save(probe)
        get_vision("strong").describe_frames([probe])
        print("critic: strong-tier vision model")
        return None  # runner default = critique_recording (degrades internally)
    except Exception:
        print("critic: no vision provider reachable -> deterministic OCR critic")
        return ocr_critic


def main() -> int:
    page = Path(tempfile.mkdtemp(prefix="watch-skill-loop-")) / "page.html"
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
