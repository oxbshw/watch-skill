"""Export the newest (or selected) indexed video as one offline HTML file.

Run:
    uv run --no-sync python examples/16-shareable-viewer/export_viewer.py [VIDEO] [OUT]
"""
from __future__ import annotations

import sys
from pathlib import Path

from watch_skill.index import list_videos
from watch_skill.viewer import generate_viewer


def main() -> int:
    videos = list_videos()
    if len(sys.argv) > 1:
        video = sys.argv[1]
    elif videos:
        video = videos[0]["id"]
    else:
        print("No indexed videos. Run `watch-skill watch <source>` first.")
        return 1

    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("watch-skill-report.html")
    path = generate_viewer(video, out_path=out)
    print(f"viewer written: {path.resolve()}")
    print("self-contained: yes (no external requests)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
