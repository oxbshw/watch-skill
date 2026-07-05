"""Read path: hybrid FTS5 + vector retrieval. Analyze once, ask forever."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentvision.errors import IndexError_
from agentvision.index import embeddings as emb
from agentvision.index.db import connect
from agentvision.index.store import get_video

_FTS_CANDIDATES = 24
_VECTOR_CANDIDATES = 24


@dataclass
class Hit:
    """One retrieved piece of evidence."""

    video_id: str
    kind: str  # segment | scene | ocr
    ref_id: int
    timestamp: float | None
    text: str
    score: float


@dataclass
class MomentContext:
    """Frames + text surrounding one moment of one video."""

    video_id: str
    timestamp: float
    window: float
    frames: list[dict[str, Any]] = field(default_factory=list)
    segments: list[dict[str, Any]] = field(default_factory=list)
    ocr: list[dict[str, Any]] = field(default_factory=list)


def _fts_query(text: str) -> str:
    """Sanitize free text into an OR-of-terms FTS5 MATCH over the normalized column.

    Terms are folded with the same normalization used at index time, so
    Arabic hamza/diacritic variants (and case) match reliably. A term whose
    normalization contains spaces (CJK runs are character-segmented) becomes
    an FTS5 phrase query, so the characters must appear adjacent — substring
    search over unspaced CJK text, including two-character queries.
    """
    import unicodedata

    from agentvision.index.textnorm import normalize_for_search

    def keep(ch: str) -> bool:
        # combining marks (Devanagari matras, etc.) are part of words —
        # str.isalnum() alone would strip them and break the match
        return ch.isalnum() or ch == " " or unicodedata.category(ch).startswith("M")

    terms: list[str] = []
    for token in text.split():
        normalized = normalize_for_search(token)
        cleaned = "".join(ch for ch in normalized if keep(ch))
        cleaned = " ".join(cleaned.split())
        if cleaned:
            terms.append(cleaned)
    if not terms:
        return '""'
    return " OR ".join(f'text_norm:"{t}"' for t in terms)


def _fts_hits(conn: sqlite3.Connection, query: str, video_id: str | None) -> list[Hit]:
    sql = (
        "SELECT video_id, kind, ref_id, timestamp, text, bm25(fts) AS rank "
        "FROM fts WHERE fts MATCH ?"
    )
    params: list[Any] = [_fts_query(query)]
    if video_id:
        sql += " AND video_id = ?"
        params.append(video_id)
    sql += " ORDER BY rank LIMIT ?"
    params.append(_FTS_CANDIDATES)
    hits = []
    for row in conn.execute(sql, params).fetchall():
        # bm25 rank is lower-is-better and unbounded; squash to (0, 1]
        score = 1.0 / (1.0 + max(0.0, float(row["rank"])))
        hits.append(
            Hit(row["video_id"], row["kind"], row["ref_id"], row["timestamp"], row["text"], score)
        )
    return hits


def _vector_hits(conn: sqlite3.Connection, query: str, video_id: str | None) -> list[Hit]:
    from agentvision.index.db import get_meta

    # the query must embed with the same model that wrote the stored vectors
    model_name = get_meta(conn, "embedding_model") or emb.MODEL_NAME
    query_vecs = emb.embed_texts([query], model_name=model_name)
    if not query_vecs:
        return []
    query_vec = query_vecs[0]
    sql = "SELECT video_id, kind, ref_id, timestamp, text, vector, dim FROM embeddings"
    params: list[Any] = []
    if video_id:
        sql += " WHERE video_id = ?"
        params.append(video_id)
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return []
    scores = _batch_cosine(query_vec, rows)
    scored = [
        Hit(row["video_id"], row["kind"], row["ref_id"], row["timestamp"], row["text"], score)
        for row, score in zip(rows, scores, strict=False)
    ]
    scored.sort(key=lambda h: h.score, reverse=True)
    return scored[:_VECTOR_CANDIDATES]


def _batch_cosine(query_vec: list[float], rows: list) -> list[float]:
    """Cosine of the query against every stored vector.

    numpy path: one matrix product (measured 45x faster than the pure-Python
    loop at 10k vectors — 122 ms vs 5.5 s on the dev machine). numpy ships
    with the index extra; the loop stays as a fallback for exotic installs.
    """
    try:
        import numpy as np  # noqa: PLC0415

        matrix = np.frombuffer(
            b"".join(row["vector"] for row in rows), dtype="<f4"
        ).reshape(len(rows), -1)
        query = np.asarray(query_vec, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1) * (np.linalg.norm(query) or 1.0)
        norms[norms == 0] = 1.0
        return (matrix @ query / norms).tolist()
    except (ImportError, ValueError):  # ValueError: mixed-dim rows (corrupt index)
        return [
            emb.cosine_similarity(query_vec, emb.unpack_vector(row["vector"], row["dim"]))
            for row in rows
        ]


def hybrid_search(query: str, video_id: str | None = None, k: int = 8) -> list[Hit]:
    """Merge keyword (FTS5 bm25) and vector (cosine) hits, best-of-both scoring."""
    conn = connect()
    try:
        merged: dict[tuple[str, str, int], Hit] = {}
        for weight, hits in ((0.45, _fts_hits(conn, query, video_id)),
                             (0.55, _vector_hits(conn, query, video_id))):
            for hit in hits:
                key = (hit.video_id, hit.kind, hit.ref_id)
                weighted = hit.score * weight
                if key in merged:
                    merged[key].score += weighted
                else:
                    hit.score = weighted
                    merged[key] = hit
        ranked = sorted(merged.values(), key=lambda h: h.score, reverse=True)
        return ranked[:k]
    finally:
        conn.close()


def frames_near(
    conn: sqlite3.Connection, video_id: str, timestamp: float, limit: int = 2
) -> list[dict[str, Any]]:
    """The frames closest in time to ``timestamp`` for one video."""
    rows = conn.execute(
        """SELECT id, scene_id, timestamp, frame_path, description
           FROM scenes WHERE video_id = ?
           ORDER BY ABS(timestamp - ?) LIMIT ?""",
        (video_id, timestamp, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def ask_video(
    video_id_or_source: str, question: str, k: int = 8, max_frames: int = 6
) -> dict[str, Any]:
    """Retrieval-based answer context: top hits + the frames around them.

    Returns text evidence with timestamps plus a handful of frame paths —
    NOT a re-run of the full analysis.
    """
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video/`agentvision watch --index` on it first, or list_videos()",
        )
    hits = hybrid_search(question, video_id=video["id"], k=k)
    conn = connect()
    try:
        frame_rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        for hit in hits:
            if hit.timestamp is None or len(frame_rows) >= max_frames:
                continue
            for frame in frames_near(conn, video["id"], hit.timestamp, limit=1):
                if frame["frame_path"] not in seen and Path(frame["frame_path"]).is_file():
                    seen.add(frame["frame_path"])
                    frame_rows.append(frame)
    finally:
        conn.close()
    return {
        "video": video,
        "question": question,
        "hits": [vars(h) for h in hits],
        "frames": frame_rows,
    }


def search_videos(query: str, k: int = 12) -> list[dict[str, Any]]:
    """Cross-video hybrid search; hits grouped with their video rows."""
    hits = hybrid_search(query, video_id=None, k=k)
    videos: dict[str, dict[str, Any]] = {}
    for hit in hits:
        videos.setdefault(hit.video_id, {"video": get_video(hit.video_id), "hits": []})
        videos[hit.video_id]["hits"].append(vars(hit))
    return list(videos.values())


def get_moment(
    video_id_or_source: str, timestamp: float, window: float = 10.0, max_frames: int = 6
) -> MomentContext:
    """Dense context around one moment: nearby frames, transcript, OCR."""
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first",
        )
    lo, hi = timestamp - window / 2, timestamp + window / 2
    conn = connect()
    try:
        frames = conn.execute(
            """SELECT id, scene_id, timestamp, frame_path, description FROM scenes
               WHERE video_id = ? AND timestamp BETWEEN ? AND ?
               ORDER BY timestamp""",
            (video["id"], lo, hi),
        ).fetchall()
        if not frames:
            frames = frames_near(conn, video["id"], timestamp, limit=max_frames)
            frames = sorted(frames, key=lambda f: f["timestamp"])
        else:
            frames = [dict(r) for r in frames][:max_frames]
        segments = conn.execute(
            """SELECT start, end, text FROM segments
               WHERE video_id = ? AND end >= ? AND start <= ? ORDER BY start""",
            (video["id"], lo, hi),
        ).fetchall()
        ocr = conn.execute(
            """SELECT timestamp, text, confidence FROM ocr_blocks
               WHERE video_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp""",
            (video["id"], lo, hi),
        ).fetchall()
    finally:
        conn.close()
    return MomentContext(
        video_id=video["id"], timestamp=timestamp, window=window,
        frames=[dict(f) for f in frames],
        segments=[dict(s) for s in segments],
        ocr=[dict(o) for o in ocr],
    )
