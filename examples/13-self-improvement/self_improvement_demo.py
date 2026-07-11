"""The self-improvement circle, live and mechanical — zero mysticism.

What this demonstrates, all against a real index built by this run:

1. A grounded answer (the dashboard question) — the baseline works.
2. An honest refusal (the OKR question) — the engine does not invent.
3. A reported hallucination becomes a lesson with derived guidance.
4. `lessons eval` replays EVERY lesson against the current pipeline and
   classifies each: still-effective / prunable / regressed. All three
   states appear in this run, from real replays, not labels.
5. `--prune` retires exactly the lessons the pipeline no longer needs.

Why no faked wrong-answer-then-recovery here: on clean synthetic clips
the perception stack reads everything on the first pass (we tried; it
kept being right). The recovery path — report a missed-OCR mistake, the
re-ask runs dense re-sampling + zoom-crop re-OCR, evidence lands in the
index permanently — is exercised on real footage in the loop demos and
golden runs (examples 04/07, docs/guides/lessons-and-savings.md).

Isolated: WATCHSKILL_DATA_DIR points at a temp dir, so the eval/prune
below never touches your real lessons store.

Run:  uv run --no-sync python examples/13-self-improvement/self_improvement_demo.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(errors="replace")
WORK = Path(tempfile.mkdtemp(prefix="watch-skill improve demo "))
os.environ["WATCHSKILL_DATA_DIR"] = str(WORK / "data")


def make_clip() -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        from watch_skill.config import get_settings

        ffmpeg = str(get_settings().bin_dir / "ffmpeg.exe")
    frame = WORK / "frame.png"
    img = Image.new("RGB", (640, 360), (24, 26, 33))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except OSError:
        font = ImageFont.load_default()
    draw.text((40, 100), "DEPLOY DASHBOARD", fill=(235, 235, 235), font=font)
    draw.text((40, 180), "BUILD 7741 - STABLE", fill=(150, 200, 150), font=font)
    img.save(frame)
    clip = WORK / "dashboard.mp4"
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-t", "4", "-i", str(frame),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(clip)],
        check=True,
    )
    return clip


def main() -> int:
    from watch_skill.answer import answer_question
    from watch_skill.index import index_watch_result
    from watch_skill.lessons.evals import eval_report, prune_lessons
    from watch_skill.lessons.report import report_mistake
    from watch_skill.watch import watch

    clip = make_clip()
    result = watch(str(clip), out_dir=WORK / "work", run_ocr=True,
                   allow_local_whisper=False, allow_cloud_stt=False)
    video_id = index_watch_result(result, describe_scenes=False)
    print(f"indexed: {video_id}\n")

    print("Q1 (answerable): what build number is shown?")
    grounded = answer_question(video_id, "what build number is shown?",
                               use_cache=False, verify=False)
    grounded_ok = "7741" in grounded.text or any("7741" in e.text for e in grounded.evidence)
    print(f"  grounded answer, honest_floor={grounded.honest_floor}, cites 7741: {grounded_ok}")

    print("\nQ2 (unanswerable): what is the team's OKR score?")
    refusal = answer_question(video_id, "what is the team's OKR score?",
                              use_cache=False, verify=False)
    print(f"  honest_floor={refusal.honest_floor} — the engine refuses rather than invents")

    print("\nsuppose an agent HAD invented one — report it:")
    hallucination = report_mistake(
        video_id, "what is the team's OKR score?",
        wrong_answer="the OKR score is 87",
        correction="the video never shows any OKR score — refuse this",
        agent="demo",
    )
    print(f"  lesson #{hallucination['lesson_id']} [{hallucination['error_class']}] "
          f"guidance: {hallucination['guidance'][:70]}...")

    # a second lesson whose correction the pipeline CAN surface (prunable),
    # and a third it cannot (regressed) — so the report shows its whole
    # vocabulary from real replays
    prunable = report_mistake(
        video_id, "what build is stable?",
        wrong_answer="build 9000",
        correction="the dashboard shows BUILD 7741 as stable",
        agent="demo", reask=False,
    )
    regressed = report_mistake(
        video_id, "who approved the deploy?",
        wrong_answer="nobody",
        correction="Dana approved it in the standup",  # never on screen
        agent="demo", reask=False,
    )

    print("\n--- lessons eval --report (every lesson replayed, classified) ---")
    report = eval_report()
    states = {e["lesson_id"]: e["state"] for e in report["lessons"]}
    for label, lesson in (("hallucination", hallucination), ("recoverable", prunable),
                          ("unrecoverable", regressed)):
        print(f"  #{lesson['lesson_id']} ({label}): {states[lesson['lesson_id']]}")
    print(f"  counts: {report['counts']}")

    removed = prune_lessons(report)
    print(f"\nlessons eval --prune: retired {removed} lesson(s) the pipeline "
          "no longer needs; regressed ones stay flagged for a human")

    checks = [
        ("grounded answer cites the build", grounded_ok),
        ("unanswerable question hits the honest floor", refusal.honest_floor),
        ("hallucination lesson expects the floor and passes",
         states[hallucination["lesson_id"]] in ("still_effective", "prunable")),
        ("surfaced correction classifies prunable",
         states[prunable["lesson_id"]] == "prunable"),
        ("unsurfaceable correction classifies regressed",
         states[regressed["lesson_id"]] == "regressed"),
        ("prune removed only the prunable", removed == sum(
            1 for s in states.values() if s == "prunable")),
    ]
    ok = True
    print()
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\nSELF-IMPROVEMENT DEMO:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
