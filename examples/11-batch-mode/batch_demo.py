"""Batch mode, live: index a small library in one call, then answer a
cross-video question — the persistent-index payoff no per-video tool has.

Builds four distinct clips (different topics, content in pixels), batch-
indexes the folder, then asks ONE question across the whole library.

Run:  uv run --no-sync python examples/11-batch-mode/batch_demo.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(errors="replace")
WORK = Path(tempfile.mkdtemp(prefix="watch-skill batch demo "))

CLIPS = [
    ("intro_python", (20, 60, 90), "PYTHON BASICS"),
    ("docker_talk", (40, 30, 70), "DOCKER DEPLOY"),
    ("bug_repro", (150, 25, 25), "ERROR 502"),
    ("release_notes", (20, 110, 45), "RELEASE v3.14"),
]


def _font(size: int = 64):
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
    folder = WORK / "video library"
    folder.mkdir()
    for name, color, text in CLIPS:
        frame = WORK / f"{name}.png"
        img = Image.new("RGB", (640, 360), color)
        ImageDraw.Draw(img).text((30, 140), text, fill=(255, 255, 255), font=_font())
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
    from watch_skill.batch import watch_batch
    from watch_skill.index.retrieval import search_videos

    folder = make_library()
    print(f"library: {folder} ({len(CLIPS)} videos)\n")

    result = watch_batch(
        str(folder), run_ocr=True, allow_local_whisper=False, allow_cloud_stt=False,
        max_frames=4,
    )
    print(result.report())
    if len(result.indexed) != len(CLIPS):
        print("BATCH DEMO: FAILED (not everything indexed)")
        return 1

    question = "ERROR 502"
    print(f'\ncross-video question: which video shows "{question}"?')
    groups = search_videos(question)
    batch_ids = {i.video_id: i for i in result.indexed}
    matches = [g for g in groups if g["video"]["id"] in batch_ids]
    for group in matches:
        item = batch_ids[group["video"]["id"]]
        top = group["hits"][0]
        print(f"  -> {item.title}  [{top['kind']} @ {top['timestamp']}s]  {top['text'][:60]}")

    ok = bool(matches) and "bug_repro" in matches[0]["video"]["source"]
    print("\nBATCH DEMO:", "PASSED (cross-video question answered)" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
