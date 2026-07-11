"""Pillar 2 — the library layer: distilled notes, cross-video synthesis.

Offline and deterministic: rows go straight into the isolated index, the
same shape watch+index writes. Embeddings may be unavailable in the test
environment — the layer must work on the FTS path alone.
"""
from __future__ import annotations

import pytest

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.library import distill_notes, library_overview, library_synthesize


def _seed(
    video_id: str,
    title: str,
    duration: float = 90.0,
    segments: list[tuple[float, float, str]] = (),
    ocr: list[tuple[float, str]] = (),
    scenes: list[tuple[float, str]] = (),
) -> str:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, title, duration_seconds) VALUES (?, ?, ?, ?)",
                (video_id, f"src-{video_id}", title, duration),
            )
            for i, (ts, description) in enumerate(scenes):
                conn.execute(
                    "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, description) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (video_id, i, ts, f"frames/{video_id}_{i}.jpg", description),
                )
            for start, end, text in segments:
                conn.execute(
                    "INSERT INTO segments (video_id, start, end, text) VALUES (?, ?, ?, ?)",
                    (video_id, start, end, text),
                )
            for ts, text in ocr:
                conn.execute(
                    "INSERT INTO ocr_blocks (video_id, timestamp, text) VALUES (?, ?, ?)",
                    (video_id, ts, text),
                )
    finally:
        conn.close()
    distill_notes(video_id)
    return video_id


def _seed_related_library() -> None:
    """Four clips about one incident; no single clip has the whole story."""
    _seed(
        "vid_monitor", "monitoring stream",
        segments=[(3.0, 9.0, "the dashboard started paging at nine fifteen")],
        ocr=[(5.0, "ERROR 502"), (6.0, "GATEWAY TIMEOUT")],
    )
    _seed(
        "vid_standup", "standup recording",
        segments=[
            (10.0, 18.0, "we decided the ERROR 502 comes from the cache layer misconfig"),
            (20.0, 26.0, "Sarah will own the cache layer fix"),
        ],
    )
    _seed(
        "vid_tutorial", "cache tutorial",
        segments=[(2.0, 11.0, "set the upstream timeout to 30 seconds to avoid gateway errors")],
        ocr=[(4.0, "upstream_timeout: 30")],
    )
    _seed(
        "vid_unrelated", "cooking show",
        segments=[(1.0, 8.0, "today we bake sourdough bread at home")],
    )


# --- notes -----------------------------------------------------------------------

def test_distill_extracts_entities_claims_chapters() -> None:
    vid = _seed(
        "vid_notes", "release demo",
        segments=[
            (1.0, 6.0, "welcome to the walkthrough of RELEASE v3.14"),
            (10.0, 20.0, "we decided the price stays at $29.00 because of churn"),
        ],
        ocr=[(2.0, "RELEASE v3.14")],
    )
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT kind, text, timestamp, weight FROM notes WHERE video_id = ?", (vid,)
        ).fetchall()
    finally:
        conn.close()
    kinds = {row["kind"] for row in rows}
    assert {"entity", "claim"} <= kinds
    entities = {row["text"] for row in rows if row["kind"] == "entity"}
    assert "v3.14" in entities
    assert any("$29" in e for e in entities)
    claims = [row for row in rows if row["kind"] == "claim"]
    assert any("decided" in row["text"] for row in claims)
    assert all(row["timestamp"] is not None for row in claims), "claims must carry provenance"


def test_distill_is_incremental_per_video() -> None:
    _seed("vid_a", "first", segments=[(1.0, 5.0, "alpha ERROR 404 case")])
    conn = connect()
    try:
        before = conn.execute(
            "SELECT id FROM notes WHERE video_id = 'vid_a' ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    _seed("vid_b", "second", segments=[(1.0, 5.0, "beta ERROR 500 case")])
    conn = connect()
    try:
        after = conn.execute(
            "SELECT id FROM notes WHERE video_id = 'vid_a' ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    assert [r["id"] for r in before] == [r["id"] for r in after], (
        "indexing video B must not touch video A's notes"
    )


def test_ocr_screen_titles_become_entities() -> None:
    _seed("vid_ocr", "screencast", ocr=[(3.0, "CACHE TUTORIAL")])
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT text FROM notes WHERE video_id = 'vid_ocr' AND kind = 'entity'"
        ).fetchall()
    finally:
        conn.close()
    assert any(r["text"] == "CACHE TUTORIAL" for r in rows)


# --- synthesis -------------------------------------------------------------------

def test_cross_video_synthesis_cites_multiple_videos() -> None:
    _seed_related_library()
    answer = library_synthesize("what did we decide about the ERROR 502 and who owns the fix?")
    assert not answer.honest_floor
    cited_videos = {c.video_id for c in answer.citations}
    assert len(cited_videos) >= 2, f"expected multi-video citations, got {cited_videos}"
    assert "vid_standup" in cited_videos
    assert "502" in answer.text
    assert "@" in answer.text, "citations must carry timestamps"
    assert answer.corroborated, "ERROR 502 appears in two videos"


def test_honest_floor_when_library_does_not_know() -> None:
    _seed_related_library()
    answer = library_synthesize("what is the capital city of iceland volcanoes quiz")
    assert answer.honest_floor
    assert "does not clearly answer" in answer.text


def test_repeat_synthesis_hits_cache_and_counts_savings() -> None:
    _seed_related_library()
    first = library_synthesize("what did we decide about the ERROR 502?")
    assert not first.cached
    second = library_synthesize("what did we decide about the ERROR 502?")
    assert second.cached
    assert second.text == first.text
    overview = library_overview()
    assert overview["library_answers_cached"] >= 2  # both calls recorded in the meter


def test_new_video_invalidates_stale_synthesis() -> None:
    _seed_related_library()
    first = library_synthesize("what did we decide about the ERROR 502?")
    assert not first.cached
    _seed(
        "vid_followup", "followup meeting",
        segments=[(2.0, 9.0, "update: the ERROR 502 fix shipped and the cache layer is stable")],
    )
    third = library_synthesize("what did we decide about the ERROR 502?")
    assert not third.cached, "library grew — the cached synthesis is stale"


def test_empty_library_raises_structured_error() -> None:
    with pytest.raises(IndexError_) as excinfo:
        library_synthesize("anything")
    assert excinfo.value.code == "index.library_empty"


def test_overview_shape() -> None:
    _seed_related_library()
    overview = library_overview()
    assert overview["videos"] == 4
    assert overview["notes"].get("entity", 0) > 0
    assert overview["hours_indexed"] > 0
    entity_texts = {e["text"] for e in overview["cross_video_entities"]}
    assert any("502" in t for t in entity_texts)
    assert len(overview["recent_videos"]) == 4
