"""Semantic answer cache: a repeat (or near-duplicate) question is free.

Lives in the index DB (``answers`` table, migration v5). Lookup is exact on
the normalized question first, then cosine similarity over stored question
embeddings. Invalidation: per-video on re-watch (store deletes the rows) or
``agentvision clean --cache-answers``.
"""
from __future__ import annotations

import json
import sqlite3

from agentvision.answer.types import Answer
from agentvision.config import get_settings
from agentvision.index import embeddings as emb
from agentvision.index.db import connect, get_meta, set_meta
from agentvision.index.textnorm import normalize_for_search


def lookup(video_id: str, question: str) -> Answer | None:
    """Return a cached Answer for this (video, question-ish) or None."""
    settings = get_settings()
    if not settings.answer_cache_enabled:
        return None
    norm = normalize_for_search(question)
    conn = connect()
    try:
        row = conn.execute(
            "SELECT answer_json FROM answers WHERE video_id = ? AND question_norm = ? "
            "ORDER BY id DESC LIMIT 1",
            (video_id, norm),
        ).fetchone()
        if row is not None:
            return _revive(row["answer_json"])
        return _semantic_lookup(conn, video_id, question, settings.answer_cache_similarity)
    finally:
        conn.close()


def _semantic_lookup(
    conn: sqlite3.Connection, video_id: str, question: str, threshold: float
) -> Answer | None:
    rows = conn.execute(
        "SELECT embedding, dim, answer_json FROM answers "
        "WHERE video_id = ? AND embedding IS NOT NULL",
        (video_id,),
    ).fetchall()
    if not rows:
        return None
    model_name = get_meta(conn, "embedding_model")
    vecs = emb.embed_texts([question], model_name=model_name)
    if not vecs:
        return None
    query = vecs[0]
    best_row, best_sim = None, 0.0
    for row in rows:
        stored = emb.unpack_vector(row["embedding"], row["dim"])
        sim = emb.cosine_similarity(query, stored)
        if sim > best_sim:
            best_row, best_sim = row, sim
    if best_row is not None and best_sim >= threshold:
        return _revive(best_row["answer_json"])
    return None


def _revive(answer_json: str) -> Answer:
    answer = Answer.from_dict(json.loads(answer_json))
    answer.cached = True
    return answer


def put(answer: Answer) -> None:
    """Store an answer (skips cached ones — no cache-of-cache)."""
    if answer.cached or not get_settings().answer_cache_enabled:
        return
    conn = connect()
    try:
        model_name = get_meta(conn, "embedding_model")
        vecs = emb.embed_texts([answer.question], model_name=model_name)
        blob, dim = (emb.pack_vector(vecs[0]), len(vecs[0])) if vecs else (None, None)
        with conn:
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, embedding, dim, answer_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    answer.video_id, answer.question,
                    normalize_for_search(answer.question),
                    blob, dim, json.dumps(answer.to_dict(), ensure_ascii=False),
                ),
            )
    finally:
        conn.close()


def clear(video_id: str | None = None) -> int:
    """Drop cached answers (one video or all); returns rows removed."""
    conn = connect()
    try:
        with conn:
            if video_id:
                cur = conn.execute("DELETE FROM answers WHERE video_id = ?", (video_id,))
            else:
                cur = conn.execute("DELETE FROM answers")
            return cur.rowcount
    finally:
        conn.close()


def record_savings(tokens_saved: int) -> None:
    """Accumulate lifetime savings in the index meta table."""
    conn = connect()
    try:
        with conn:
            total = int(get_meta(conn, "tokens_saved_total") or 0) + max(0, tokens_saved)
            count = int(get_meta(conn, "answers_count") or 0) + 1
            set_meta(conn, "tokens_saved_total", str(total))
            set_meta(conn, "answers_count", str(count))
    finally:
        conn.close()


def lifetime_stats() -> dict[str, int]:
    conn = connect()
    try:
        return {
            "tokens_saved_total": int(get_meta(conn, "tokens_saved_total") or 0),
            "answers_count": int(get_meta(conn, "answers_count") or 0),
        }
    finally:
        conn.close()
