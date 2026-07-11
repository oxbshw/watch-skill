"""Answer questions across the whole library, from notes, with receipts.

`library_synthesize` is for questions no single video answers: it
retrieves distilled notes across every indexed video, drills the top
videos into their REAL indexed evidence (the same hybrid retrieval
`ask_video` uses), and composes an answer where every finding carries a
per-video timestamp citation. Corroboration across videos raises
confidence; a library that does not clearly know says so — the honest
floor is the same contract as the single-video engine.

Synthesis is extractive and deterministic: no model call is required, so
it works fully offline and repeats are served from the library answer
cache (counted in the savings meter).
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from watch_skill.answer.types import est_frame_tokens, est_text_tokens
from watch_skill.config import get_settings
from watch_skill.errors import IndexError_
from watch_skill.index import embeddings as emb
from watch_skill.index.db import connect, get_meta, set_meta
from watch_skill.index.retrieval import hybrid_search
from watch_skill.index.textnorm import normalize_for_search

_NOTE_CANDIDATES = 32
_TOP_VIDEOS = 5
_LIBRARY_FLOOR = 0.12  # unrelated questions land ≈0.04 (measured); real but
# weak matches ≈0.17+ — the gap is the floor's home


@dataclass
class Citation:
    """One piece of provenance: which video, where, what it says."""

    video_id: str
    video_title: str
    timestamp: float | None
    text: str
    kind: str  # entity | claim | chapter | evidence

    def to_dict(self) -> dict[str, Any]:
        return vars(self)


@dataclass
class LibraryAnswer:
    """A cross-video synthesis with per-video citations."""

    question: str
    text: str
    confidence: float
    honest_floor: bool
    videos_consulted: int
    corroborated: bool  # the same finding appeared in 2+ videos
    citations: list[Citation] = field(default_factory=list)
    cached: bool = False
    tokens_spent_estimate: int = 0
    tokens_saved_estimate: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = vars(self).copy()
        data["citations"] = [c.to_dict() for c in self.citations]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LibraryAnswer:
        data = dict(data)
        data["citations"] = [Citation(**c) for c in data.get("citations", [])]
        return cls(**data)


def _library_stamp(conn: sqlite3.Connection) -> str:
    """State of the note set; changes whenever any video's notes change."""
    row = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top FROM notes"
    ).fetchone()
    videos = conn.execute("SELECT COUNT(*) AS n FROM videos").fetchone()
    return f"{videos['n']}:{row['n']}:{row['top']}"


def _term_overlap(question_norm_terms: set[str], text: str) -> float:
    """Fraction of the question's normalized terms present in the text.

    The FTS query is OR-of-terms, so a single stopword can match an
    unrelated note; scaling by overlap makes 'one common word out of
    nine' score like the noise it is, in any language."""
    if not question_norm_terms:
        return 0.0
    note_terms = set(normalize_for_search(text).split())
    return len(question_norm_terms & note_terms) / len(question_norm_terms)


def _note_hits(conn: sqlite3.Connection, question: str) -> list[dict[str, Any]]:
    """Merged keyword + vector retrieval over notes (their own tables)."""
    from watch_skill.index.retrieval import _fts_query  # same sanitizer

    question_terms = set(normalize_for_search(question).split())
    merged: dict[int, dict[str, Any]] = {}
    rows = conn.execute(
        "SELECT note_id, video_id, kind, timestamp, text, bm25(notes_fts) AS rank "
        "FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?",
        (_fts_query(question), _NOTE_CANDIDATES),
    ).fetchall()
    for row in rows:
        overlap = _term_overlap(question_terms, row["text"])
        score = overlap * 0.45 / (1.0 + max(0.0, float(row["rank"])))
        if score <= 0.0:
            continue
        merged[int(row["note_id"])] = {
            "note_id": int(row["note_id"]), "video_id": row["video_id"],
            "kind": row["kind"], "timestamp": row["timestamp"],
            "text": row["text"], "score": score,
        }

    model_name = get_meta(conn, "embedding_model") or emb.MODEL_NAME
    query_vecs = emb.embed_texts([question], model_name=model_name)
    if query_vecs:
        query = query_vecs[0]
        for row in conn.execute(
            "SELECT id, video_id, kind, timestamp, text, vector, dim FROM notes "
            "WHERE vector IS NOT NULL"
        ).fetchall():
            sim = emb.cosine_similarity(query, emb.unpack_vector(row["vector"], row["dim"]))
            # unrelated prose still lands ~0.3-0.4 cosine in sentence models;
            # discount that baseline so only genuine relatedness scores
            weighted = 0.55 * max(0.0, (sim - 0.40) / 0.60)
            if weighted <= 0.0:
                continue
            note_id = int(row["id"])
            if note_id in merged:
                merged[note_id]["score"] += weighted
            else:
                merged[note_id] = {
                    "note_id": note_id, "video_id": row["video_id"],
                    "kind": row["kind"], "timestamp": row["timestamp"],
                    "text": row["text"], "score": weighted,
                }
    return sorted(merged.values(), key=lambda h: h["score"], reverse=True)


def _video_titles(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        row["id"]: row["title"] or row["source"]
        for row in conn.execute("SELECT id, title, source FROM videos").fetchall()
    }


def _cache_lookup(conn: sqlite3.Connection, question: str, stamp: str) -> LibraryAnswer | None:
    settings = get_settings()
    if not settings.answer_cache_enabled:
        return None
    norm = normalize_for_search(question)
    row = conn.execute(
        "SELECT answer_json, library_stamp FROM library_answers "
        "WHERE question_norm = ? ORDER BY id DESC LIMIT 1",
        (norm,),
    ).fetchone()
    if row is None or row["library_stamp"] != stamp:
        return None  # unknown question, or the library grew since — recompute
    answer = LibraryAnswer.from_dict(json.loads(row["answer_json"]))
    answer.cached = True
    return answer


def _cache_put(conn: sqlite3.Connection, answer: LibraryAnswer, stamp: str) -> None:
    if answer.cached or not get_settings().answer_cache_enabled:
        return
    model_name = get_meta(conn, "embedding_model")
    vecs = emb.embed_texts([answer.question], model_name=model_name)
    blob, dim = (emb.pack_vector(vecs[0]), len(vecs[0])) if vecs else (None, None)
    conn.execute(
        "INSERT INTO library_answers (question, question_norm, embedding, dim, answer_json, library_stamp) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (answer.question, normalize_for_search(answer.question), blob, dim,
         json.dumps(answer.to_dict(), ensure_ascii=False), stamp),
    )


def _record_library_savings(conn: sqlite3.Connection, tokens_saved: int) -> None:
    total = int(get_meta(conn, "library_tokens_saved") or 0) + max(0, tokens_saved)
    count = int(get_meta(conn, "library_answers_count") or 0) + 1
    set_meta(conn, "library_tokens_saved", str(total))
    set_meta(conn, "library_answers_count", str(count))


def _format_stamp(ts: float | None) -> str:
    if ts is None:
        return "--:--"
    return f"{int(ts // 60)}:{int(ts % 60):02d}"


def library_synthesize(question: str, k_videos: int = _TOP_VIDEOS) -> LibraryAnswer:
    """Answer a question from the whole library with per-video citations."""
    conn = connect()
    try:
        if conn.execute("SELECT COUNT(*) AS n FROM videos").fetchone()["n"] == 0:
            raise IndexError_(
                "the library is empty — nothing has been watched yet",
                code="index.library_empty",
                fix="watch_video/watch_batch something first; notes distill automatically",
            )
        stamp = _library_stamp(conn)
        hit = _cache_lookup(conn, question, stamp)
        if hit is not None:
            hit.tokens_saved_estimate += hit.tokens_spent_estimate  # repeat = free
            with conn:
                _record_library_savings(conn, hit.tokens_spent_estimate)
            return hit

        titles = _video_titles(conn)
        note_hits = _note_hits(conn, question)
    finally:
        conn.close()

    # group by video, keep the strongest videos
    per_video: dict[str, list[dict[str, Any]]] = {}
    for h in note_hits:
        per_video.setdefault(h["video_id"], []).append(h)
    video_rank = sorted(
        per_video.items(), key=lambda kv: max(h["score"] for h in kv[1]), reverse=True
    )[:k_videos]

    # drill each top video into real indexed evidence (same path ask_video uses)
    citations: list[Citation] = []
    spent = est_text_tokens(question)
    for video_id, hits in video_rank:
        for h in hits[:3]:
            citations.append(Citation(
                video_id=video_id, video_title=titles.get(video_id, video_id),
                timestamp=h["timestamp"], text=h["text"], kind=h["kind"],
            ))
        for ev in hybrid_search(question, video_id=video_id, k=2):
            spent += est_text_tokens(ev.text)
            citations.append(Citation(
                video_id=video_id, video_title=titles.get(video_id, video_id),
                timestamp=ev.timestamp, text=ev.text, kind="evidence",
            ))

    # corroboration: the same normalized note text in 2+ distinct videos
    seen: dict[str, set[str]] = {}
    for c in citations:
        if c.kind != "evidence":
            seen.setdefault(normalize_for_search(c.text), set()).add(c.video_id)
    corroborated = any(len(v) >= 2 for v in seen.values())

    top_score = video_rank[0][1][0]["score"] if video_rank else 0.0
    coverage = min(1.0, len(video_rank) / 2)  # 2+ videos = full coverage credit
    # coverage and corroboration SCALE relevance — they must never rescue a
    # zero-relevance match (breadth of weak hits is not knowledge)
    confidence = min(
        0.95,
        top_score * (0.7 + 0.15 * coverage + (0.15 if corroborated else 0.0)),
    )
    honest_floor = confidence < _LIBRARY_FLOOR or not citations

    if honest_floor:
        text = (
            f"The library does not clearly answer {question!r}. "
            f"{len(titles)} videos indexed; the closest notes were too weak to cite. "
            "Watch a video that covers this, or ask a narrower question."
        )
    else:
        lines = [f"Across {len(video_rank)} video(s), the library answers {question!r}:", ""]
        for c in citations:
            if c.kind == "evidence":
                continue
            lines.append(
                f"- {c.text}  [{c.video_title} @ {_format_stamp(c.timestamp)}]"
            )
        evidence_lines = [
            f"  - {c.text}  [{c.video_title} @ {_format_stamp(c.timestamp)}]"
            for c in citations if c.kind == "evidence"
        ]
        if evidence_lines:
            lines += ["", "Supporting evidence from the index:", *evidence_lines]
        if corroborated:
            lines += ["", "(Corroborated: the same finding appears in more than one video.)"]
        text = "\n".join(lines)

    spent += est_text_tokens(text)
    # naive baseline: shipping every consulted video's frames into context
    conn = connect()
    try:
        naive = 0
        for video_id, _ in video_rank:
            frames = conn.execute(
                "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (video_id,)
            ).fetchone()["n"]
            naive += frames * est_frame_tokens()
        answer = LibraryAnswer(
            question=question, text=text, confidence=round(confidence, 3),
            honest_floor=honest_floor, videos_consulted=len(video_rank),
            corroborated=corroborated, citations=citations,
            tokens_spent_estimate=spent,
            tokens_saved_estimate=max(0, naive - spent),
        )
        with conn:
            _cache_put(conn, answer, _library_stamp(conn))
            _record_library_savings(conn, answer.tokens_saved_estimate)
    finally:
        conn.close()
    return answer


def library_overview() -> dict[str, Any]:
    """What the library knows: sizes, spans, and the strongest entities."""
    conn = connect()
    try:
        videos = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS seconds FROM videos"
        ).fetchone()
        notes_by_kind = {
            row["kind"]: row["n"]
            for row in conn.execute(
                "SELECT kind, COUNT(*) AS n FROM notes GROUP BY kind"
            ).fetchall()
        }
        top_entities = [
            {"text": row["text"], "videos": row["videos"], "weight": row["weight"]}
            for row in conn.execute(
                """SELECT text, COUNT(DISTINCT video_id) AS videos, SUM(weight) AS weight
                   FROM notes WHERE kind = 'entity'
                   GROUP BY text ORDER BY videos DESC, weight DESC LIMIT 12"""
            ).fetchall()
        ]
        recent = [
            {"id": row["id"], "title": row["title"] or row["source"],
             "analyzed": row["last_analyzed_at"]}
            for row in conn.execute(
                "SELECT id, title, source, last_analyzed_at FROM videos "
                "ORDER BY last_analyzed_at DESC LIMIT 8"
            ).fetchall()
        ]
        return {
            "videos": videos["n"],
            "hours_indexed": round(videos["seconds"] / 3600, 2),
            "notes": notes_by_kind,
            "cross_video_entities": top_entities,
            "recent_videos": recent,
            "library_answers_cached": int(get_meta(conn, "library_answers_count") or 0),
            "library_tokens_saved": int(get_meta(conn, "library_tokens_saved") or 0),
        }
    finally:
        conn.close()
