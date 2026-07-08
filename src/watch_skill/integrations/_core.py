"""The three core calls every framework adapter wraps.

Plain functions, string-in/string-out (LLM tool outputs are text), no
framework imports. Adapters must not add logic beyond calling these.
"""
from __future__ import annotations

from watch_skill.perceive.budget import format_time


def watch_video(source: str, question: str | None = None) -> str:
    """Watch + index a video (URL or local path); optionally ask right away."""
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    result = watch(source)
    video_id = index_watch_result(result)
    lines = [
        f"video_id: {video_id}",
        f"title: {result.acquisition.info.get('title') or source}",
        f"duration: {format_time(result.metadata.duration_seconds)}",
        f"frames indexed: {len(result.perception.frames)}",
        f"transcript segments: {len(result.transcript.segments) if result.transcript else 0}",
    ]
    if question:
        lines += ["", ask_video(video_id, question)]
    return "\n".join(lines)


def ask_video(video_id_or_source: str, question: str) -> str:
    """Answer a question about an indexed video from its persistent index."""
    from watch_skill.answer import answer_question

    answer = answer_question(video_id_or_source, question)
    header = (
        f"confidence: {answer.confidence}"
        + (" (verified)" if answer.verified else "")
        + (" [honest floor — not clearly shown]" if answer.honest_floor else "")
    )
    return f"{header}\n{answer.text}"


def search_videos(query: str) -> str:
    """Search across every video ever indexed on this machine."""
    from watch_skill.index.retrieval import search_videos as core_search

    groups = core_search(query)
    if not groups:
        return "no indexed video matches this query"
    lines = []
    for group in groups:
        video = group["video"]
        lines.append(f"{video['id']}  {video.get('title') or video['source']}")
        for hit in group["hits"][:3]:
            stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
            lines.append(f"  [{stamp}] ({hit['kind']}) {hit['text'][:140]}")
    return "\n".join(lines)


# Shared tool metadata so every framework describes the tools identically.
TOOL_SPECS: list[dict[str, object]] = [
    {
        "name": "watch_video",
        "description": (
            "Watch and index a video from a URL (YouTube and 1800+ sites) or a "
            "local file path. Returns a video_id for follow-up questions. "
            "Optionally pass a question to ask immediately."
        ),
        "func": watch_video,
    },
    {
        "name": "ask_video",
        "description": (
            "Ask a question about an already-watched video (by video_id or its "
            "original URL/path). Answers from the persistent index with "
            "timestamped evidence and a confidence score — no re-processing."
        ),
        "func": ask_video,
    },
    {
        "name": "search_videos",
        "description": (
            "Keyword/semantic search across every video ever watched on this "
            "machine; returns matching videos with timestamped snippets."
        ),
        "func": search_videos,
    },
]
