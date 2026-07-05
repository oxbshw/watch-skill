"""Index an Arabic video with its ORIGINAL Arabic captions.

Watch Skill's caption picker prefers the video's original-language track,
but yt-dlp only downloads tracks matching `WATCHSKILL_SUBTITLE_LANGS`
(default "en.*"). For Arabic-in-Arabic-out, request the Arabic tracks.

Equivalent CLI (on a machine where the video is not cached yet):

    set WATCHSKILL_SUBTITLE_LANGS=ar-orig,ar
    uv run --no-sync watch-skill watch "https://www.youtube.com/watch?v=9ndH9Qo05F4"

This script sets the variable itself and bypasses the acquisition cache so
it also works when an earlier watch already cached English captions.

Run:  uv run --no-sync python examples/05-multilingual-arabic/index_arabic.py
"""
from __future__ import annotations

import os
import sys

# Must be set before watch_skill.config loads the settings.
os.environ["WATCHSKILL_SUBTITLE_LANGS"] = "ar-orig,ar"

from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.watch import watch  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = "https://www.youtube.com/watch?v=9ndH9Qo05F4"  # Arabic programming intro


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else URL
    print(f"watching {url} with Arabic captions ...")
    result = watch(url, max_frames=8, use_cache=False)
    video_id = index_watch_result(result)
    print(f"indexed: video_id={video_id} transcript={result.transcript.source} "
          f"segments={len(result.transcript.segments)}")
    first = result.transcript.segments[0].text if result.transcript.segments else ""
    print(f"first segment: {first}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
