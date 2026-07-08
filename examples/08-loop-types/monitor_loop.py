"""Monitor loop demo: watch a folder of recordings until an error screen
appears, then emit a structured event an agent can react to.

Builds two tiny clips on the fly — a healthy dashboard and one showing a red
ERROR 502 screen — drops them in a folder, and monitors it for the condition.
The event lands in events.jsonl and on the on_event callback (the v0.8
webhook system plugs into that same seam).

Run:  uv run --no-sync python examples/08-loop-types/monitor_loop.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from watch_skill.loop import loop_monitor

WORK = Path(tempfile.mkdtemp(prefix="watch-skill-monitor-"))


def _big_font() -> ImageFont.ImageFont:
    """A large font so the text is legible on screen (like a real error page).
    PIL's default bitmap font is ~11px — invisible to OCR and vision alike."""
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, 72)
        except OSError:
            continue
    return ImageFont.load_default()


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    from watch_skill.config import get_settings

    return str(get_settings().bin_dir / "ffmpeg.exe")


def _clip(name: str, color: tuple[int, int, int], text: str) -> Path:
    frame = WORK / f"{name}.png"
    img = Image.new("RGB", (640, 360), color)
    ImageDraw.Draw(img).text((40, 140), text, fill=(255, 255, 255), font=_big_font())
    img.save(frame)
    out = WORK / "drop folder" / f"{name}.mp4"
    out.parent.mkdir(exist_ok=True)
    subprocess.run(
        [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-t", "3", "-i", str(frame),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(out)],
        check=True,
    )
    return out


def main() -> int:
    _clip("healthy_dashboard", (18, 90, 40), "ALL SYSTEMS OK")
    _clip("failed_deploy", (150, 25, 25), "ERROR 502")

    events_seen: list[dict] = []
    result = loop_monitor(
        str(WORK / "drop folder"),
        "an error screen (like ERROR 502)",
        max_checks=5,
        on_event=events_seen.append,
    )

    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    ok = (
        result.triggered
        and events_seen == result.events
        and "failed_deploy" in result.events[0]["source"]
        and Path(result.events_path).is_file()
    )
    print("DEMO PASSED" if ok else "DEMO FAILED: see result above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
