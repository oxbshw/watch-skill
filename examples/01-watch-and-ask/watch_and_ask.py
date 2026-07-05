"""Watch a short YouTube video, then ask it one question — the Python way.

CLI equivalent (see README.md):

    uv run --no-sync watch-skill watch "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    uv run --no-sync watch-skill ask <video_id> "What does the narrator say about the elephants?"

The pipeline is captions-first and fully local: no cloud key is required.
Re-running is cheap — acquisition is cached and the index is persistent.

Run:  uv run --no-sync python examples/01-watch-and-ask/watch_and_ask.py [URL]
"""
from __future__ import annotations

import sys

from watch_skill.answer import answer_question
from watch_skill.index import index_watch_result
from watch_skill.watch import watch

URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"  # "Me at the zoo", 19s
QUESTION = "What does the narrator say about the elephants?"


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else URL

    print(f"watching {url} ...")
    result = watch(url, max_frames=6)
    video_id = index_watch_result(result)
    frames = len(result.perception.frames) if result.perception else 0
    print(f"indexed: video_id={video_id} frames={frames} "
          f"transcript={result.transcript.source}")

    print(f"\nasking: {QUESTION!r}")
    answer = answer_question(video_id, QUESTION)
    print(answer.text)
    print(f"\n(confidence: {answer.confidence:.2f} | verified: {answer.verified} "
          f"| cached: {answer.cached})")
    print(f"~{answer.tokens_saved_estimate} tokens saved vs raw-frame injection")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
