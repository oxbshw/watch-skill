"""Lesson injection: the top-k relevant guidance lines, under a hard budget.

Relevance = embedding similarity on the question (+ a content-type match
bonus). The injected section may never exceed ``lessons_injection_token_cap``
tokens — lessons exist to raise accuracy, not to erode the token economy.
"""
from __future__ import annotations

from typing import Any

from agentvision.answer.types import est_text_tokens
from agentvision.config import get_settings
from agentvision.index import embeddings as emb
from agentvision.lessons import store
from agentvision.lessons.classify import classify_content_type

_TOP_K = 5
_MIN_SIMILARITY = 0.25
_CONTENT_TYPE_BONUS = 0.15


def relevant_guidance(question: str, video: dict[str, Any]) -> list[str]:
    """Guidance lines for this question/video, budget-capped, LRU-touched."""
    settings = get_settings()
    conn = store.connect()
    try:
        rows = conn.execute(
            "SELECT id, content_type, guidance, embedding, dim FROM lessons"
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return []

    vecs = emb.embed_texts([question])
    if not vecs:
        return []
    query = vecs[0]
    content_type = classify_content_type(video)

    scored: list[tuple[float, int, str]] = []
    for row in rows:
        if row["embedding"] is None:
            continue
        sim = emb.cosine_similarity(query, emb.unpack_vector(row["embedding"], row["dim"]))
        if row["content_type"] == content_type:
            sim += _CONTENT_TYPE_BONUS
        if sim >= _MIN_SIMILARITY:
            scored.append((sim, row["id"], row["guidance"]))
    scored.sort(reverse=True)

    lines: list[str] = []
    used_ids: list[int] = []
    budget = settings.lessons_injection_token_cap
    spent = 0
    for _sim, lesson_id, guidance in scored[:_TOP_K]:
        cost = est_text_tokens(guidance)
        if spent + cost > budget:
            break
        spent += cost
        lines.append(guidance)
        used_ids.append(lesson_id)
    store.mark_used(used_ids)
    return lines
