"""Generate, index, and question a local clip with cloud use disabled.

Run:
    uv run --no-sync python examples/15-private-offline-workflow/offline_workflow.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _font(size: int = 58) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "arial.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _make_clip(work: Path) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("ffmpeg not found; run `watch-skill doctor --fix`")

    frame = work / "release.png"
    image = Image.new("RGB", (960, 540), (18, 29, 42))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((55, 55, 905, 485), radius=24, fill=(29, 49, 66))
    draw.text((100, 125), "DEPLOYMENT STATUS", fill=(96, 210, 190), font=_font(48))
    draw.text((100, 225), "API HEALTHY", fill=(235, 239, 242), font=_font())
    draw.text((100, 325), "RELEASE 1.4.0", fill=(242, 174, 73), font=_font())
    image.save(frame)

    clip = work / "private-release.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-t",
            "4",
            "-i",
            str(frame),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "10",
            str(clip),
        ],
        check=True,
    )
    return clip


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="watch-skill-offline-example-"))
    os.environ["WATCHSKILL_DATA_DIR"] = str(work / "data")
    os.environ["WATCHSKILL_COST_POLICY"] = "offline_only"
    os.environ["WATCHSKILL_CLOUD_STT_ENABLED"] = "false"

    from watch_skill.answer import answer_question
    from watch_skill.config import reset_settings
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    reset_settings()
    clip = _make_clip(work)
    result = watch(
        str(clip),
        max_frames=4,
        run_ocr=True,
        allow_local_whisper=False,
        allow_cloud_stt=False,
    )
    video_id = index_watch_result(result, describe_scenes=False)
    answer = answer_question(video_id, "Which release version is shown?")

    print(f"indexed: {video_id}")
    print(f"answer: {answer.text}")
    print("cloud calls allowed: no")
    print(f"temporary workspace: {work}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
