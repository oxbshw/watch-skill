"""Arabic in, Arabic out: ask an indexed Arabic video a question in Arabic.

Watch Skill's index normalizes Arabic (and other scripts) properly — FTS
keyword search and the local embeddings both work on the Arabic transcript,
and answers quote the Arabic evidence verbatim with timestamps.

The video below is an Arabic programming intro already in the index. To
index it yourself:

    uv run --no-sync watch-skill watch "https://www.youtube.com/watch?v=9ndH9Qo05F4"

Run:  uv run --no-sync python examples/05-multilingual-arabic/ask_in_arabic.py
"""
from __future__ import annotations

import sys

from watch_skill.answer import answer_question

# Windows consoles often default to a legacy codepage; force UTF-8 so the
# Arabic text survives printing (and redirection to files).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

VIDEO = "https://www.youtube.com/watch?v=9ndH9Qo05F4"  # video_id d02c3e2e589f4253
QUESTION = "ما موضوع الفيديو؟"  # "What is the video about?"


def main() -> int:
    video = sys.argv[1] if len(sys.argv) > 1 else VIDEO
    question = sys.argv[2] if len(sys.argv) > 2 else QUESTION

    print(f"question: {question}\n")
    answer = answer_question(video, question)
    print(answer.text)
    print(f"\n(confidence: {answer.confidence:.2f} | verified: {answer.verified})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
