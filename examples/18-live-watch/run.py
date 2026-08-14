"""Live watch: prove an event arrives before the stream ends.

Everything is local. The clip is generated here rather than shipped, so the
example is rights-clear, deterministic, and small enough to keep in a repo.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def make_clip(work: Path) -> Path:
    """A 14 s clip: READY on green for 7 s, then ERROR 502 on red for 7 s."""
    from PIL import Image, ImageDraw, ImageFont

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        sys.exit("ffmpeg not found — run `watch-skill doctor` first")

    frames = work / "src"
    frames.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default(size=110)
    index = 0
    for colour, text in (("darkgreen", "READY"), ("darkred", "ERROR 502")):
        for _ in range(70):  # 7 s at 10 fps
            index += 1
            image = Image.new("RGB", (640, 360), colour)
            draw = ImageDraw.Draw(image)
            box = draw.textbbox((0, 0), text, font=font)
            draw.text(((640 - (box[2] - box[0])) / 2,
                       (360 - (box[3] - box[1])) / 2 - box[1]),
                      text, fill="white", font=font)
            image.save(frames / f"src_{index:05d}.png")

    clip = work / "state-change.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-framerate", "10",
         "-i", str(frames / "src_%05d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", str(clip)],
        check=True,
    )
    return clip


def main() -> int:
    from watch_skill.live import ask_live, observe, start_live, stop_live
    from watch_skill.live.finalize import finalize_session

    work = Path(tempfile.mkdtemp(prefix="watch-skill-live-example-"))
    print("generating a 14s clip...")
    clip = make_clip(work)

    print("starting a live session on it (played at real time)\n")
    began = time.monotonic()
    session = start_live(str(clip), kind="file_replay", fps=2.0)

    cursor, change_at = "", None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        batch = observe(session.session_id, cursor=cursor or None,
                        timeout_seconds=1.0)
        for event in batch["events"]:
            print(f"{event['media_ts']:8.2f}s  {event['type']:<21} "
                  f"{event['summary']}")
            if change_at is None and event["media_ts"] >= 6.0:
                change_at = time.monotonic() - began
        cursor = batch["next_cursor"]
        if change_at is not None or batch["state"] not in ("running", "starting"):
            break

    if change_at is None:
        print("\n!! no state change was reported — see `watch-skill live status`")
        stop_live(session.session_id)
        return 1

    remaining = max(0.0, 14.0 - change_at)
    print(f"\n>>> the change was reported {change_at:.1f}s in, while the source "
          f"still had {remaining:.1f}s to play")
    print(">>> that is the whole point: a batch pipeline would report at 14s "
          "or later\n")

    print("asking the live session a question...")
    answer = ask_live(session.session_id, "what changed on screen?",
                      scope="session")
    for line in answer["answer"].splitlines():
        print(f"  {line}")
    for item in answer["evidence"][:3]:
        print(f"  evidence: {item['artifact_id']} @ {item['media_ts']:.2f}s")

    print("\nstopping and finalising...")
    stop_live(session.session_id)
    video_id = finalize_session(session.session_id)
    print(f"  finalised as video_id {video_id}")
    print("  the session is now ordinary indexed memory: "
          "ask_video / search_videos work")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
