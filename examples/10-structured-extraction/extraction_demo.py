"""Structured extraction, live: chapters + bug report + hook on one clip.

Builds a 4-scene screen-recording-style clip (title card -> setup step ->
ERROR 502 screen -> success), watches + indexes it for real (OCR on), then
runs the three extractors on the index.

Run:  uv run --no-sync python examples/10-structured-extraction/extraction_demo.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(errors="replace")
WORK = Path(tempfile.mkdtemp(prefix="watch-skill extract demo "))

SCENES = [
    ((20, 60, 90), "CACHE TUTORIAL"),
    ((25, 35, 45), "STEP 1: SETUP"),
    ((150, 25, 25), "ERROR 502"),
    ((20, 110, 45), "DEPLOY OK"),
]


def _font(size: int = 64):
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_clip() -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        from watch_skill.config import get_settings

        ffmpeg = str(get_settings().bin_dir / "ffmpeg.exe")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    filters = []
    for i, (color, text) in enumerate(SCENES):
        frame = WORK / f"scene_{i}.png"
        img = Image.new("RGB", (640, 360), color)
        ImageDraw.Draw(img).text((30, 140), text, fill=(255, 255, 255), font=_font())
        img.save(frame)
        cmd += ["-loop", "1", "-t", "3", "-i", str(frame)]
        filters.append(f"[{i}:v]")
    out = WORK / "tutorial clip.mp4"
    cmd += [
        "-filter_complex", "".join(filters) + f"concat=n={len(SCENES)}:v=1[v]",
        "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out


def main() -> int:
    from watch_skill.extract import analyze_hook, extract_bug_report, extract_chapters
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    clip = make_clip()
    print(f"clip: {clip}")
    result = watch(
        str(clip), out_dir=WORK / "watch work",
        run_ocr=True, allow_local_whisper=False, allow_cloud_stt=False, max_frames=8,
    )
    video_id = index_watch_result(result, describe_scenes=False)
    print(f"indexed: {video_id}\n")

    chapters = extract_chapters(video_id)
    print("--- extract_chapters ---")
    print(json.dumps([c.to_dict() for c in chapters], ensure_ascii=False, indent=2))

    report = extract_bug_report(video_id)
    print("\n--- extract_bug_report ---")
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))

    hook = analyze_hook(video_id, window_seconds=6.0)
    print("\n--- analyze_hook ---")
    print(json.dumps(hook.to_dict(), ensure_ascii=False, indent=2))

    ok = (
        len(chapters) >= 2
        and report.found is True
        and "502" in report.error_text
        and report.frame_path is not None
        and hook.score > 0 and len(hook.metrics) == 4
    )
    print("\nEXTRACTION DEMO:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
