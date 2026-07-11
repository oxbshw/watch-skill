"""Distill one watched video into structured notes.

Deterministic, incremental, provenance-first: re-derives the notes for
ONE video from its already-indexed rows (segments, OCR, scene
descriptions) and never touches any other video's notes. Works
transcript+OCR-only; scene descriptions (when a vision backend ran)
just add material.

Three note kinds:
- ``entity`` — concrete referents worth finding again across videos:
  error codes, versions, prices, URLs, file paths, repeated proper
  nouns, on-screen titles. Weight = occurrence count.
- ``claim`` — salient sentences with their timestamp: the lines that
  carry numbers, entities, or decision language.
- ``chapter`` — the auto-chapter spans (start/end + title), so
  synthesis can name the section it cites.
"""
from __future__ import annotations

import re
import sqlite3
from collections import Counter

from watch_skill.index import embeddings as emb
from watch_skill.index.db import connect, get_meta
from watch_skill.index.textnorm import normalize_for_search

_MAX_CLAIMS = 12
_MAX_ENTITIES = 40
_CLAIM_MIN_CHARS = 12
_CLAIM_MAX_CHARS = 240

# Concrete referent shapes. Deliberately narrow: a wrong entity poisons
# cross-video matching, a missed one only costs recall.
_ENTITY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("error", re.compile(r"\b(?:ERROR|ERR|E|HTTP|status)[ :\-]{0,2}(\d{2,5})\b", re.IGNORECASE)),
    ("version", re.compile(r"\bv?\d+\.\d+(?:\.\d+)*\b")),
    ("price", re.compile(r"[$€£]\s?\d+(?:[.,]\d{2})?\b")),
    ("url", re.compile(r"\bhttps?://[^\s)>\]]+", re.IGNORECASE)),
    ("path", re.compile(r"(?:[A-Za-z]:\\|/)[\w.\\/-]{3,}")),
    ("email", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")),
]

# Words that mark a sentence as carrying a decision/assertion, across the
# languages the engine localizes. Tiny on purpose — claims mostly qualify
# through entities and numbers, this only breaks ties.
_DECISION_MARKERS = (
    "decide", "decided", "must", "should", "fix", "fixed", "because",
    "means", "conclusion", "important", "remember", "never", "always",
    "قرر", "يجب", "لأن", "دائما", "أبدا",
)


def _proper_noun_runs(text: str) -> list[str]:
    """Capitalized multi-word runs in Latin text (mid-sentence only)."""
    runs = []
    for match in re.finditer(r"(?<![.!?]\s)(?<!^)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b", text):
        runs.append(match.group(1))
    return runs


def _extract_entities(
    segments: list[dict], ocr: list[dict], scenes: list[dict]
) -> list[tuple[str, float, float]]:
    """(text, first_timestamp, weight) per entity."""
    counts: Counter[str] = Counter()
    first_seen: dict[str, float] = {}

    def feed(text: str, timestamp: float, boost: int = 1) -> None:
        for _, pattern in _ENTITY_PATTERNS:
            for match in pattern.finditer(text):
                key = match.group(0).strip().rstrip(".,;")
                counts[key] += boost
                first_seen.setdefault(key, timestamp)
        for run in _proper_noun_runs(text):
            counts[run] += boost
            first_seen.setdefault(run, timestamp)

    for seg in segments:
        feed(seg["text"], seg["start"])
    for row in ocr:
        # on-screen text is deliberate (titles, labels) — worth double
        feed(row["text"], row["timestamp"], boost=2)
        stripped = row["text"].strip()
        if stripped.isupper() and 3 <= len(stripped) <= 60:
            counts[stripped] += 2
            first_seen.setdefault(stripped, row["timestamp"])
    for row in scenes:
        if row["description"]:
            feed(row["description"], row["timestamp"])

    ranked = counts.most_common(_MAX_ENTITIES)
    return [(text, first_seen[text], float(n)) for text, n in ranked]


def _extract_claims(
    segments: list[dict], scenes: list[dict], entities: list[tuple[str, float, float]]
) -> list[tuple[str, float, float]]:
    """(text, timestamp, weight) for the most salient sentences."""
    entity_norms = {normalize_for_search(text) for text, _, _ in entities}
    candidates: list[tuple[float, str, float]] = []

    def score(text: str) -> float:
        value = 0.0
        norm = normalize_for_search(text)
        if any(e and e in norm for e in entity_norms):
            value += 2.0
        if re.search(r"\d", text):
            value += 1.0
        lowered = text.lower()
        if any(marker in lowered for marker in _DECISION_MARKERS):
            value += 1.5
        return value

    for seg in segments:
        text = " ".join(seg["text"].split())
        if _CLAIM_MIN_CHARS <= len(text) <= _CLAIM_MAX_CHARS:
            s = score(text)
            if s > 0:
                candidates.append((s, text, seg["start"]))
    for row in scenes:
        description = (row["description"] or "").strip()
        if _CLAIM_MIN_CHARS <= len(description) <= _CLAIM_MAX_CHARS:
            s = score(description) + 0.5  # a vision model found it notable
            candidates.append((s, description, row["timestamp"]))

    candidates.sort(key=lambda c: (-c[0], c[2]))
    return [(text, timestamp, s) for s, text, timestamp in candidates[:_MAX_CLAIMS]]


def _chapter_notes(video_id: str) -> list[tuple[str, float, float]]:
    """(title, start, end) per auto-chapter. Empty on any failure —
    chapters are derived data; notes must not depend on their success."""
    try:
        from watch_skill.extract.chapters import extract_chapters

        return [(c.title, c.start, c.end) for c in extract_chapters(video_id)]
    except Exception:  # noqa: BLE001 — chapters are optional garnish here
        return []


def _index_notes(conn: sqlite3.Connection, video_id: str, rows: list[tuple]) -> None:
    """Insert note rows + their notes_fts entries + vectors (own tables —
    the main fts/embeddings read paths never see notes)."""
    model_name = get_meta(conn, "embedding_model") or emb.MODEL_NAME
    vectors = emb.embed_texts([text for _, text, _, _, _ in rows], model_name=model_name)
    padded = vectors if vectors else [None] * len(rows)
    for (kind, text, timestamp, end_timestamp, weight), vector in zip(rows, padded, strict=False):
        blob, dim = (emb.pack_vector(vector), len(vector)) if vector else (None, None)
        cur = conn.execute(
            "INSERT INTO notes (video_id, kind, text, timestamp, end_timestamp, weight, vector, dim) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (video_id, kind, text, timestamp, end_timestamp, weight, blob, dim),
        )
        conn.execute(
            "INSERT INTO notes_fts (text, text_norm, video_id, note_id, kind, timestamp) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (text, normalize_for_search(text), video_id, cur.lastrowid, kind, timestamp),
        )


def distill_notes(video_id: str) -> int:
    """(Re)derive the notes for one video; returns how many were written.

    Incremental by construction: reads only this video's indexed rows,
    replaces only this video's notes.
    """
    conn = connect()
    try:
        segments = [dict(r) for r in conn.execute(
            "SELECT start, end, text FROM segments WHERE video_id = ? ORDER BY start",
            (video_id,),
        ).fetchall()]
        ocr = [dict(r) for r in conn.execute(
            "SELECT timestamp, text FROM ocr_blocks WHERE video_id = ? ORDER BY timestamp",
            (video_id,),
        ).fetchall()]
        scenes = [dict(r) for r in conn.execute(
            "SELECT timestamp, description FROM scenes WHERE video_id = ? ORDER BY timestamp",
            (video_id,),
        ).fetchall()]

        entities = _extract_entities(segments, ocr, scenes)
        claims = _extract_claims(segments, scenes, entities)
        chapters = _chapter_notes(video_id)

        rows: list[tuple] = []
        rows += [("entity", text, ts, None, weight) for text, ts, weight in entities]
        rows += [("claim", text, ts, None, weight) for text, ts, weight in claims]
        rows += [("chapter", title, start, end, 1.0) for title, start, end in chapters]

        with conn:
            conn.execute("DELETE FROM notes_fts WHERE video_id = ?", (video_id,))
            conn.execute("DELETE FROM notes WHERE video_id = ?", (video_id,))
            _index_notes(conn, video_id, rows)
        return len(rows)
    finally:
        conn.close()
