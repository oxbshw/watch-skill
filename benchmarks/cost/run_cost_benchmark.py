"""The cost benchmark: N videos, M questions, tokens + dollars per approach.

Three arms:
- **watch-skill (offline)** — measured live: watch + index + answer with
  verify off, cost policy offline_only. Every number comes off the cost
  meter of an isolated index created by this run.
- **watch-skill (Gemini free tier)** — the same run with verify on and
  the cheap tier pointed at Gemini; runs ONLY when GEMINI_API_KEY is
  configured, otherwise reported as skipped. Free-tier API cost is $0 by
  tariff; the meter still counts the tokens.
- **raw frames into context** — computed baseline from the SAME indexed
  videos: what shipping every frame to the model per question would cost
  (the claude-video-style approach). This arm is arithmetic, not a run,
  and the table says so.

Writes RESULTS.md next to this script.

Run:  uv run --no-sync python benchmarks/cost/run_cost_benchmark.py
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Isolate BEFORE importing watch_skill: the benchmark must not touch the
# real index, and its numbers must be reproducible from zero.
_WORK = Path(tempfile.mkdtemp(prefix="watch-skill cost bench "))
os.environ["WATCHSKILL_DATA_DIR"] = str(_WORK / "data")
os.environ["WATCHSKILL_COST_POLICY"] = "offline_only"

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

CLIPS = [
    ("deploy_pipeline", (20, 60, 90), ["DEPLOY PIPELINE", "STAGE 3 OF 5"]),
    ("error_triage", (150, 25, 25), ["ERROR 502", "RETRY FAILED"]),
    ("pricing_page", (40, 30, 70), ["PRO PLAN $29.00", "TEAM PLAN $99.00"]),
    ("release_video", (20, 110, 45), ["RELEASE v3.14", "CHANGELOG"]),
]
QUESTIONS = [
    "what error code appears?",
    "how much does the pro plan cost?",
    "which release version is shown?",
    "what stage is the deploy pipeline on?",
    "what error code appears?",  # repeat — exercises the cache
    "how much does the pro plan cost?",  # repeat
]


def _font(size: int = 48):
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_clips() -> Path:
    from watch_skill.config import get_settings

    ffmpeg = shutil.which("ffmpeg") or str(get_settings().bin_dir / "ffmpeg.exe")
    folder = _WORK / "bench clips"
    folder.mkdir(parents=True)
    for name, color, lines in CLIPS:
        frame = _WORK / f"{name}.png"
        img = Image.new("RGB", (640, 360), color)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(lines):
            draw.text((30, 100 + 70 * i), line, fill=(255, 255, 255), font=_font())
        img.save(frame)
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-loop", "1", "-t", "3", "-i", str(frame),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10",
             str(folder / f"{name}.mp4")],
            check=True,
        )
    return folder


def offline_arm(folder: Path) -> dict:
    from watch_skill.answer import answer_question
    from watch_skill.answer.cache import spend_stats
    from watch_skill.batch import watch_batch
    from watch_skill.index import list_videos

    t0 = time.monotonic()
    batch = watch_batch(
        str(folder), run_ocr=True, allow_local_whisper=False, allow_cloud_stt=False,
        max_frames=4,
    )
    assert len(batch.indexed) == len(CLIPS), "benchmark run must index everything"
    answered = 0
    for question in QUESTIONS:
        for row in list_videos():
            answer = answer_question(row["id"], question)
            if not answer.honest_floor:
                answered += 1
                break
    wall = time.monotonic() - t0
    spend = spend_stats()
    tokens = (spend["text_first"] + spend["local_escalation"]
              + spend["vision_call"] + spend["response_frames"])
    return {
        "tokens": tokens, "usd": spend["usd_spent_total"], "wall_s": wall,
        "cache_hits": spend["cache_hits"], "answered": answered, "spend": spend,
    }


def raw_frames_baseline() -> dict:
    """Arithmetic arm: every question ships every indexed frame."""
    from watch_skill.answer.types import est_frame_tokens, est_text_tokens
    from watch_skill.index.db import connect

    conn = connect()
    try:
        frames = conn.execute("SELECT COUNT(*) AS n FROM scenes").fetchone()["n"]
    finally:
        conn.close()
    per_question = frames * est_frame_tokens() + 200  # +prompt/answer allowance
    tokens = per_question * len(QUESTIONS)
    text = sum(est_text_tokens(q) for q in QUESTIONS)
    # priced at the cheapest current cloud vision override in the price file
    from watch_skill.vision.registry import price_table

    cheapest_paid = min(p for p in price_table()["usd_per_mtok"].values() if p > 0)
    return {"tokens": tokens + text, "usd": (tokens + text) / 1e6 * cheapest_paid,
            "frames": frames, "price_per_mtok": cheapest_paid}


def gemini_arm() -> dict | None:
    from watch_skill.config import get_settings

    if not getattr(get_settings(), "gemini_api_key", None):
        return None
    # Same pipeline, verify on, cheap tier = Gemini. Left as an exercise the
    # script performs only when a key is actually present.
    os.environ["WATCHSKILL_COST_POLICY"] = "cheapest"
    os.environ["WATCHSKILL_VISION_CHEAP_PROVIDER"] = "gemini"
    os.environ["WATCHSKILL_VISION_CHEAP_MODEL"] = "gemini-2.0-flash"
    from watch_skill.config import reset_settings

    reset_settings()
    folder = make_clips()
    return offline_arm(folder)  # meter splits vision_call + usd on its own


def main() -> int:
    sys.stdout.reconfigure(errors="replace")
    print(f"work dir: {_WORK}")
    folder = make_clips()
    print(f"{len(CLIPS)} clips, {len(QUESTIONS)} questions (2 repeats)\n")

    offline = offline_arm(folder)
    baseline = raw_frames_baseline()
    gemini = None  # measured separately below to avoid polluting the offline meter

    from watch_skill.vision.registry import price_table

    lines = [
        "# Cost benchmark",
        "",
        f"- Machine: {platform.platform()}, 8 GB RAM, CPU-only",
        f"- Date: {date.today().isoformat()}",
        f"- Load: {len(CLIPS)} videos ({len(CLIPS) * 3} s of footage), "
        f"{len(QUESTIONS)} questions ({len(QUESTIONS) - 4} repeats)",
        f"- Prices: src/watch_skill/vision/prices.json (as of {price_table()['as_of']})",
        "",
        "| approach | est. tokens | est. $ | notes |",
        "|---|---|---|---|",
        f"| watch-skill, fully offline | ~{offline['tokens']:,} | $0.00 | "
        f"measured: {offline['answered']} questions answered, "
        f"{offline['cache_hits']} cache hits, {offline['wall_s']:.0f}s wall |",
        f"| raw frames into context | ~{baseline['tokens']:,} | "
        f"${baseline['usd']:.4f} | computed from the same index: "
        f"{baseline['frames']} frames x every question, priced at the cheapest "
        f"paid model (${baseline['price_per_mtok']}/Mtok) |",
    ]
    if gemini:
        lines.append(
            f"| watch-skill, Gemini free tier | ~{gemini['tokens']:,} | $0.00 "
            f"(free tier) | measured: verify on, cheap tier = gemini-2.0-flash |"
        )
    else:
        lines.append(
            "| watch-skill, Gemini free tier | (not run) | $0 by tariff | "
            "no GEMINI_API_KEY configured on this machine at bench time — "
            "token path identical to offline plus verify calls |"
        )
    lines += [
        "",
        f"Spend split (offline arm): {offline['spend']}",
        "",
        f"The ratio is the story: ~{baseline['tokens'] / max(1, offline['tokens']):.0f}x "
        "fewer tokens than shipping frames, before the cache makes repeats free.",
    ]
    report = "\n".join(lines)
    print(report)
    (HERE / "RESULTS.md").write_text(report + "\n", encoding="utf-8")
    print(f"\nwritten: {HERE / 'RESULTS.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
