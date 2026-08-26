"""A cached answer belongs to the algorithm that produced it.

The cache keyed only on (video, normalized question) plus a semantic
near-match, with no record of the engine that wrote the row. That let a real
contradiction survive: entries written before the answer deadline existed
carry no ``deadline_stopped`` at all, yet remained servable — verbatim, with
their old confidence and old evidence — for any near-duplicate question asked
after retrieval and scoring had moved on.

These tests pin the rule in both directions: a row from another schema is
never served, a row from the current one still is, and the semantic (not just
exact) lookup path honours the stamp too — that path is the one that reaches
across differently-worded questions, so an unstamped row there would be the
easiest to serve by accident.
"""
from __future__ import annotations

import pytest

from watch_skill.answer import cache
from watch_skill.answer.types import Answer, Evidence
from watch_skill.index.db import connect

VIDEO = "vid_cache_versioning"
QUESTION = "what does a second brain keep?"


def _answer(confidence: float) -> Answer:
    return Answer(
        video_id=VIDEO,
        question=QUESTION,
        text="every decision and the reason, in files you own",
        evidence=[Evidence(timestamp=60.0, kind="segment", text="keeps every decision", score=0.8)],
        confidence=confidence,
        verified=False,
        honest_floor=False,
    )


def _seed_video(video_id: str = VIDEO) -> None:
    """The answers table references videos; give it a row to hang off."""
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT OR IGNORE INTO videos (id, source, title, duration_seconds) "
                "VALUES (?, ?, ?, ?)",
                (video_id, f"memory://{video_id}", "cache versioning", 10.0),
            )
    finally:
        conn.close()


def _stamp_of(video_id: str = VIDEO) -> str | None:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT engine_schema FROM answers WHERE video_id = ? ORDER BY id DESC LIMIT 1",
            (video_id,),
        ).fetchone()
        return row["engine_schema"] if row else None
    finally:
        conn.close()


def _restamp(value: str | None) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute("UPDATE answers SET engine_schema = ? WHERE video_id = ?", (value, VIDEO))
    finally:
        conn.close()


def test_put_stamps_the_current_schema_and_lookup_serves_it() -> None:
    _seed_video()
    cache.put(_answer(0.51))

    assert _stamp_of() == cache.ANSWER_SCHEMA

    hit = cache.lookup(VIDEO, QUESTION)
    assert hit is not None, "an entry from the current schema must still be served"
    assert hit.cached is True
    assert hit.confidence == pytest.approx(0.51)


@pytest.mark.parametrize(
    "foreign",
    [
        pytest.param("2026-01-01/before-the-deadline-work", id="older-schema"),
        pytest.param(None, id="unstamped-legacy-row"),
    ],
)
def test_entry_from_another_schema_is_never_served(foreign: str | None) -> None:
    """The 0.51-vs-0.39 class of bug: old numbers outliving the algorithm."""
    _seed_video()
    cache.put(_answer(0.51))
    _restamp(foreign)

    assert cache.lookup(VIDEO, QUESTION) is None


def test_semantic_near_match_also_honours_the_stamp(monkeypatch: pytest.MonkeyPatch) -> None:
    """The cross-wording path must not be a hole in the versioning.

    Embeddings are stubbed so the test states a cache rule rather than
    re-measuring the embedding model: every question embeds to the same
    vector, which forces a similarity of 1.0. The only thing left that can
    reject the row is the schema stamp.
    """
    monkeypatch.setattr(cache.emb, "embed_texts", lambda texts, model_name=None: [[1.0, 0.0]])
    monkeypatch.setattr(cache.emb, "unpack_vector", lambda blob, dim: [1.0, 0.0])
    monkeypatch.setattr(cache.emb, "pack_vector", lambda vec: b"\x00\x00")
    monkeypatch.setattr(cache.emb, "cosine_similarity", lambda a, b: 1.0)

    _seed_video()
    cache.put(_answer(0.51))

    differently_worded = 'what does a "second brain" keep that AI memory loses?'
    assert cache.lookup(VIDEO, differently_worded) is not None

    _restamp("2026-01-01/before-the-deadline-work")
    assert cache.lookup(VIDEO, differently_worded) is None


def test_disabling_the_cache_needs_no_deletion(monkeypatch: pytest.MonkeyPatch) -> None:
    """The supported uncached run keeps the user's rows on disk."""
    _seed_video()
    cache.put(_answer(0.51))

    monkeypatch.setenv("WATCHSKILL_ANSWER_CACHE_ENABLED", "false")
    from watch_skill.config import reset_settings

    reset_settings()
    try:
        assert cache.lookup(VIDEO, QUESTION) is None
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT COUNT(*) AS n FROM answers WHERE video_id = ?", (VIDEO,)
            ).fetchone()["n"]
        finally:
            conn.close()
        assert rows == 1, "disabling the cache must not delete what is stored"
    finally:
        monkeypatch.delenv("WATCHSKILL_ANSWER_CACHE_ENABLED", raising=False)
        reset_settings()
