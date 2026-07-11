"""Semantic answer cache: a repeat (or near-duplicate) question is free.

Lives in the index DB (``answers`` table, migration v5). Lookup is exact on
the normalized question first, then cosine similarity over stored question
embeddings. Invalidation: per-video on re-watch (store deletes the rows) or
``watch-skill clean --cache-answers``.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from watch_skill.answer.types import Answer
from watch_skill.config import get_settings
from watch_skill.index import embeddings as emb
from watch_skill.index.db import connect, get_meta, set_meta
from watch_skill.index.textnorm import normalize_for_search


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


def record_spend(breakdown: dict[str, int], usd: float) -> None:
    """Cost meter v2: accumulate lifetime spend per source.

    Sources: cache (served free), text_first, local_escalation, vision_call,
    response_frames. USD accrues only from cloud vision calls."""
    conn = connect()
    try:
        with conn:
            if "cache" in breakdown:
                hits = int(get_meta(conn, "spend_cache_hits") or 0) + 1
                set_meta(conn, "spend_cache_hits", str(hits))
            for source, tokens in breakdown.items():
                if source == "cache" or tokens <= 0:
                    continue
                key = f"spend_{source}"
                set_meta(conn, key, str(int(get_meta(conn, key) or 0) + tokens))
            if usd > 0:
                total = float(get_meta(conn, "usd_spent_total") or 0.0) + usd
                set_meta(conn, "usd_spent_total", f"{total:.6f}")
    finally:
        conn.close()


def spend_stats() -> dict[str, Any]:
    """Lifetime spend split by source, plus the cloud USD estimate."""
    conn = connect()
    try:
        return {
            "cache_hits": int(get_meta(conn, "spend_cache_hits") or 0),
            "text_first": int(get_meta(conn, "spend_text_first") or 0),
            "local_escalation": int(get_meta(conn, "spend_local_escalation") or 0),
            "vision_call": int(get_meta(conn, "spend_vision_call") or 0),
            "response_frames": int(get_meta(conn, "spend_response_frames") or 0),
            "usd_spent_total": float(get_meta(conn, "usd_spent_total") or 0.0),
        }
    finally:
        conn.close()


def lifetime_stats() -> dict[str, int]:
    conn = connect()
    try:
        return {
            "tokens_saved_total": int(get_meta(conn, "tokens_saved_total") or 0),
            "answers_count": int(get_meta(conn, "answers_count") or 0),
            "library_answers_count": int(get_meta(conn, "library_answers_count") or 0),
            "library_tokens_saved": int(get_meta(conn, "library_tokens_saved") or 0),
        }
    finally:
        conn.close()
