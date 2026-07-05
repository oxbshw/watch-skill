"""Zoom into one specific moment of an already-indexed video.

`get_moment` returns dense frames + transcript + on-screen text (OCR) within
a window around a timestamp — the right tool when the user names a moment
("what happens at 1:00?") instead of asking about the whole video.

The video must already be in the index (run example 01 first, or
`watch-skill list` to see what is indexed). Works fully offline: everything
comes from the persistent index and cached media.

Run:  uv run --no-sync python examples/02-focused-moment/focused_moment.py [VIDEO] [SECONDS]
"""
from __future__ import annotations

import sys

from watch_skill.index import get_moment

# "Me at the zoo" — indexed by example 01. Any video_id or original source
# URL works.
VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TIMESTAMP = 8.0  # seconds — "...really really long trunks"


def fmt(seconds: float) -> str:
    return f"{int(seconds) // 60:02d}:{int(seconds) % 60:02d}"


def main() -> int:
    video = sys.argv[1] if len(sys.argv) > 1 else VIDEO
    ts = float(sys.argv[2]) if len(sys.argv) > 2 else TIMESTAMP

    ctx = get_moment(video, ts, window=10.0)
    print(f"moment {fmt(ctx.timestamp)} +/-{ctx.window / 2:.0f}s of video {ctx.video_id}\n")

    if ctx.segments:
        print("transcript:")
        for seg in ctx.segments:
            print(f"  [{fmt(seg['start'])}] {seg['text']}")
    if ctx.ocr:
        print("on-screen text (OCR):")
        for blk in ctx.ocr:
            print(f"  [{fmt(blk['timestamp'])}] {blk['text']}")
    print("frames (open with any image viewer):")
    for frame in ctx.frames:
        print(f"  t={fmt(frame['timestamp'])}  {frame['frame_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
