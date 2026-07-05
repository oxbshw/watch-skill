"""Search across every indexed video at once.

Hybrid keyword (FTS5) + semantic (local ONNX embeddings) search over
transcripts, scene descriptions, and OCR blocks of the whole index. Use it
when you don't know which video contains something — then follow up with
`ask` or `get_moment` on a hit.

CLI equivalent (see README.md):

    uv run --no-sync watch-skill search "elephants"

Runs fully offline against the persistent index. No cloud key needed.

Run:  uv run --no-sync python examples/03-cross-video-search/cross_video_search.py [QUERY]
"""
from __future__ import annotations

import sys

from watch_skill.index import search_videos

# Titles can be in any script (Arabic, CJK, ...); don't let a legacy Windows
# console codepage crash the demo.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUERY = "elephants"


def fmt(seconds: float | None) -> str:
    if seconds is None:
        return "--:--"
    return f"{int(seconds) // 60:02d}:{int(seconds) % 60:02d}"


def main() -> int:
    query = sys.argv[1] if len(sys.argv) > 1 else QUERY
    groups = search_videos(query)
    if not groups:
        print(f"no indexed content matches {query!r}")
        return 1

    print(f"matches for {query!r}:\n")
    for group in groups:
        video = group["video"] or {}
        print(f"{video.get('title') or video.get('source')}  (id {video.get('id')})")
        for hit in group["hits"][:3]:  # top hits per video
            print(f"  [{fmt(hit['timestamp'])}] ({hit['kind']}, {hit['score']:.2f}) {hit['text']}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
