"""Persistent SQLite index: analyze once, ask forever.

Schema-versioned SQLite with FTS5 keyword search plus local ONNX embeddings
(MiniLM-class via fastembed) for hybrid retrieval over transcript segments,
scene frames/descriptions, and OCR blocks.
"""

from watch_skill.index.retrieval import (
    Hit,
    MomentContext,
    ask_video,
    get_moment,
    hybrid_search,
    search_videos,
)
from watch_skill.index.store import get_video, index_watch_result, list_videos, video_id_for

__all__ = [
    "Hit",
    "MomentContext",
    "ask_video",
    "get_moment",
    "get_video",
    "hybrid_search",
    "index_watch_result",
    "list_videos",
    "search_videos",
    "video_id_for",
]
