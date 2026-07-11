"""Library memory, live: one incident scattered across four clips.

No single clip has the whole story — the monitor shows the error, the
standup names the cause, the tutorial shows the config fix, the release
clip confirms it shipped. `library ask` synthesizes the answer across
all four with per-video citations, the repeat comes from cache, and the
savings meter records both.

Run:  uv run --no-sync python examples/12-library-memory/library_demo.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(errors="replace")
WORK = Path(tempfile.mkdtemp(prefix="watch-skill library demo "))

CLIPS = [
    ("monitor_feed", (150, 25, 25), ["ERROR 502", "GATEWAY TIMEOUT"]),
    ("standup_notes", (40, 30, 70), ["ERROR 502 ROOT CAUSE", "CACHE MISCONFIG"]),
    ("config_tutorial", (20, 60, 90), ["CACHE CONFIG FIX", "UPSTREAM_TIMEOUT 30"]),
    ("release_update", (20, 110, 45), ["FIX SHIPPED v3.15", "ERROR 502 RESOLVED"]),
]

QUESTION = "what caused the ERROR 502 and is it fixed?"


def _font(size: int = 48):
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_library() -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        from watch_skill.config import get_settings

        ffmpeg = str(get_settings().bin_dir / "ffmpeg.exe")
    folder = WORK / "incident clips"
    folder.mkdir()
    for name, color, lines in CLIPS:
        frame = WORK / f"{name}.png"
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


def main() -> int:
    from watch_skill.answer.cache import lifetime_stats
    from watch_skill.batch import watch_batch
    from watch_skill.library import library_overview, library_synthesize

    folder = make_library()
    print(f"library: {folder} ({len(CLIPS)} related clips)\n")

    result = watch_batch(
        str(folder), run_ocr=True, allow_local_whisper=False, allow_cloud_stt=False,
        max_frames=4,
    )
    print(result.report())
    if len(result.indexed) != len(CLIPS):
        print("LIBRARY DEMO: FAILED (not everything indexed)")
        return 1

    overview = library_overview()
    print(f"\nlibrary overview: {overview['videos']} videos, notes = {overview['notes']}")
    cross = [e["text"] for e in overview["cross_video_entities"] if e["videos"] >= 2]
    print(f"entities recurring across videos: {cross}")

    print(f"\nQ (no single clip answers this): {QUESTION}")
    answer = library_synthesize(QUESTION)
    print(answer.text)
    print(f"\nconfidence: {answer.confidence} | videos consulted: {answer.videos_consulted}"
          f" | corroborated: {answer.corroborated} | cached: {answer.cached}")

    cited = {c.video_id for c in answer.citations}
    checks = [
        ("synthesis is not honest-floored", not answer.honest_floor),
        ("2+ videos cited", len(cited) >= 2),
        ("timestamps in the text", "@" in answer.text),
    ]

    repeat = library_synthesize(QUESTION)
    checks.append(("repeat served from cache", repeat.cached))
    stats = lifetime_stats()
    checks.append(("savings meter counts syntheses", stats["library_answers_count"] >= 2))
    print(f"\nmeter: {stats['library_answers_count']} library syntheses, "
          f"~{stats['library_tokens_saved']:,} library tokens saved")

    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\nLIBRARY DEMO:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
