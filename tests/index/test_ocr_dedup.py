"""Near-identical OCR from one persistent on-screen text gets one slot, not twelve.

Found in a real Claude Desktop acceptance test. Asked what a "second brain"
keeps that ordinary AI memory loses, retrieval returned this top-8:

     1. [00:50] segment  0.8442  'even consider a second brain? as you know...'
     2. [01:03] ocr      0.7985  'the second brain'
     3. [01:00] ocr      0.7985  'the second brain'
     4. [01:01] ocr      0.7985  'the second brain'
     5. [01:02] ocr      0.7985  'the second brain'
     6. [01:00] ocr      0.7985  'the second brain'
     7. [01:01] ocr      0.7985  'the second brain'
     8. [01:02] ocr      0.7985  'the second brain'

Eleven readings of one static caption, every one scoring an identical 0.7985,
holding ranks 2-12. The transcript line that actually answered the question —
"the details and so on. However, second brain keeps every decision and the" —
sat at **rank 15**, unreachable by any top-8. The answer was only obtainable by
rephrasing the question until different text happened to retrieve.

A caption held on screen across a dozen frames is one thing the video showed.
It is not a dozen independent witnesses, and it must not be able to outvote the
narration by sheer repetition.

What is deliberately NOT done here: no global dedup by text (the same caption
recurring later is a real second occurrence), no penalty on OCR as a modality
(a silent screencast may have nothing else), and no larger K to bury the
problem — a bigger K filled with the same redundancy is the same defect.
"""
from __future__ import annotations

import pytest

from watch_skill.index.retrieval import Hit, collapse_ocr_duplicates


def _ocr(ref: int, ts: float, text: str, score: float = 0.8) -> Hit:
    return Hit("v1", "ocr", ref, ts, text, score)


def _seg(ref: int, ts: float, text: str, score: float = 0.8) -> Hit:
    return Hit("v1", "segment", ref, ts, text, score)


def _texts(hits: list[Hit]) -> list[str]:
    return [h.text for h in hits]


# --- A: the reported defect -------------------------------------------------

def test_same_text_on_adjacent_frames_collapses_to_one() -> None:
    """The acceptance case, in miniature."""
    hits = [_ocr(i, 60.0 + i * 0.4, "the second brain") for i in range(11)]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 1, f"11 readings of one caption kept {len(kept)} slots"
    assert kept[0].duplicate_count == 11, "the representative must say what it covers"
    assert kept[0].duplicate_first == pytest.approx(60.0)
    assert kept[0].duplicate_last == pytest.approx(60.0 + 10 * 0.4)


def test_representative_keeps_its_own_score() -> None:
    """Collapsing removes competitors; it does not re-weight the survivor.

    Inflating a representative because it "stands for" several readings would
    make repetition count again through the back door.
    """
    hits = [_ocr(i, 60.0 + i, "the second brain", score=0.7985) for i in range(4)]

    kept = collapse_ocr_duplicates(hits)

    assert kept[0].score == pytest.approx(0.7985)


# --- B: recurrence is not duplication ---------------------------------------

def test_same_text_much_later_stays_separate() -> None:
    """A caption that comes back is a second occurrence, not a duplicate."""
    hits = [
        _ocr(1, 60.0, "the second brain"),
        _ocr(2, 60.5, "the second brain"),
        _ocr(3, 420.0, "the second brain"),  # seven minutes later
        _ocr(4, 420.5, "the second brain"),
    ]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 2, "two distinct on-screen occurrences must both survive"
    stamps = sorted(h.timestamp for h in kept)
    assert stamps[0] < 100.0 and stamps[1] > 400.0


def test_a_caption_held_a_long_time_is_still_one_occurrence() -> None:
    """Chaining is by gap, not by total span.

    A caption sampled every few seconds for two minutes is one occurrence; a
    fixed total-span cap would split it into arbitrary pieces.
    """
    hits = [_ocr(i, 60.0 + i * 5.0, "the second brain") for i in range(24)]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 1
    assert kept[0].duplicate_count == 24


# --- C: recognition noise ---------------------------------------------------

def test_ocr_noise_variants_cluster_when_adjacent() -> None:
    """The same caption misread slightly is still the same caption."""
    hits = [
        _ocr(1, 62.0, "every decision"),
        _ocr(2, 62.5, "every decislon"),   # l/i confusion
        _ocr(3, 63.0, "every decision "),  # trailing space
        _ocr(4, 63.5, "every  decision"),  # doubled space
    ]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 1, f"noise variants did not cluster: {_texts(kept)}"
    assert kept[0].duplicate_count == 4


# --- D: distinct text must survive ------------------------------------------

def test_different_nearby_text_is_not_collapsed() -> None:
    """Adjacency alone must never merge two different statements."""
    hits = [
        _ocr(1, 60.0, "the second brain"),
        _ocr(2, 60.5, "a second brain is two folders"),
        _ocr(3, 61.0, "why even consider a second brain?"),
        _ocr(4, 61.5, "the model's memory"),
    ]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 4, f"distinct captions were merged: {_texts(kept)}"


def test_short_text_does_not_absorb_a_longer_line_containing_it() -> None:
    """Containment is not identity.

    "the second brain" appearing inside "a second brain that remembers you"
    must not let the short read swallow the longer, more informative one.
    """
    hits = [
        _ocr(1, 60.0, "the second brain"),
        _ocr(2, 60.5, "a second brain that remembers you."),
    ]

    assert len(collapse_ocr_duplicates(hits)) == 2


# --- E: modality independence ------------------------------------------------

def test_transcript_is_never_absorbed_into_an_ocr_cluster() -> None:
    """Two modalities, two evidence streams. Never merged."""
    hits = [
        _ocr(1, 60.0, "the second brain"),
        _seg(2, 60.2, "the second brain"),   # identical text, different kind
        _ocr(3, 60.4, "the second brain"),
    ]

    kept = collapse_ocr_duplicates(hits)

    kinds = sorted(h.kind for h in kept)
    assert kinds == ["ocr", "segment"], f"modalities were merged: {kinds}"


def test_adjacent_transcript_segments_are_never_collapsed() -> None:
    """Two adjacent segments are two different statements, even if alike."""
    hits = [
        _seg(1, 55.0, "this memory is just like a summary of your preferences"),
        _seg(2, 58.0, "this memory is just like a summary of your preferences"),
    ]

    assert len(collapse_ocr_duplicates(hits)) == 2


def test_repeated_ocr_cannot_monopolize_top_k() -> None:
    """The defect, stated as the ranking outcome it caused.

    Repeated OCR outscores the transcript here, so without collapsing it takes
    every slot. Collapsed, the transcript is reachable again — and note the OCR
    representative still ranks *first*: this is not an OCR penalty.
    """
    k = 4
    repeated = [_ocr(i, 60.0 + i * 0.3, "the second brain", score=0.80) for i in range(8)]
    transcript = [
        _seg(100, 55.0, "this memory is just a summary of your preferences", 0.78),
        _seg(101, 58.0, "it doesn't contain the details. however, second brain "
                        "keeps every decision", 0.77),
    ]
    ranked = sorted(repeated + transcript, key=lambda h: h.score, reverse=True)

    before = ranked[:k]
    assert all(h.kind == "ocr" for h in before), "precondition: OCR floods top-k"

    after = collapse_ocr_duplicates(ranked)[:k]

    kinds = [h.kind for h in after]
    assert kinds[0] == "ocr", "the strongest hit is still OCR — no modality penalty"
    assert "segment" in kinds, f"transcript still crowded out: {kinds}"
    assert any("every decision" in h.text for h in after), (
        "the segment that answers the question must be reachable")


# --- F: OCR-only videos ------------------------------------------------------

def test_silent_video_keeps_full_ocr_evidence() -> None:
    """No transcript at all: distinct OCR must remain fully usable."""
    hits = [
        _ocr(1, 10.0, "error: connection refused"),
        _ocr(2, 25.0, "retrying in 5 seconds"),
        _ocr(3, 40.0, "build failed with exit code 1"),
        _ocr(4, 55.0, "see logs for details"),
    ]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 4, "a silent screencast lost evidence it depends on"


# --- G: non-Latin scripts ----------------------------------------------------

def test_arabic_ocr_clusters_through_project_normalization() -> None:
    """Dedup runs on normalized text, so Arabic folding applies here too.

    These differ only by diacritics and alef form — the same folding the query
    path uses. A byte-level dedup would silently never fire on Arabic.
    """
    hits = [
        _ocr(1, 60.0, "الدماغ الثاني"),
        _ocr(2, 60.5, "الدماغ الثانى"),  # final ya vs alef maqsura
        _ocr(3, 61.0, "الدِماغ الثاني"),  # with a diacritic
    ]

    kept = collapse_ocr_duplicates(hits)

    assert len(kept) == 1, f"Arabic variants did not cluster: {_texts(kept)}"


def test_distinct_arabic_lines_are_not_merged() -> None:
    """Folding must not make different Arabic sentences look identical."""
    hits = [
        _ocr(1, 60.0, "الدماغ الثاني"),
        _ocr(2, 60.5, "هذا مجلد الملاحظات"),
    ]

    assert len(collapse_ocr_duplicates(hits)) == 2


def test_cjk_ocr_clusters_when_adjacent() -> None:
    """The segmentation path is exercised too, not just the folding path."""
    hits = [
        _ocr(1, 60.0, "第二大脑"),
        _ocr(2, 60.5, "第二大脑"),
        _ocr(3, 61.0, "第二大脑"),
    ]

    kept = collapse_ocr_duplicates(hits)
    assert len(kept) == 1
    assert kept[0].duplicate_count == 3


# --- switches and edges ------------------------------------------------------

def test_dedup_can_be_turned_off(monkeypatch: pytest.MonkeyPatch) -> None:
    from watch_skill.config import reset_settings

    monkeypatch.setenv("WATCHSKILL_RETRIEVAL_OCR_DEDUP_ENABLED", "false")
    reset_settings()

    hits = [_ocr(i, 60.0 + i * 0.3, "the second brain") for i in range(5)]
    assert len(collapse_ocr_duplicates(hits)) == 5


def test_hits_without_timestamps_are_left_alone() -> None:
    """No timestamp means no temporal claim, so no temporal clustering."""
    hits = [
        Hit("v1", "ocr", 1, None, "the second brain", 0.8),
        Hit("v1", "ocr", 2, None, "the second brain", 0.8),
    ]

    assert len(collapse_ocr_duplicates(hits)) == 2


def test_clusters_do_not_span_videos() -> None:
    """A cross-video search must not merge two videos' captions."""
    hits = [
        Hit("v1", "ocr", 1, 60.0, "the second brain", 0.8),
        Hit("v2", "ocr", 2, 60.2, "the second brain", 0.8),
    ]

    kept = collapse_ocr_duplicates(hits)
    assert {h.video_id for h in kept} == {"v1", "v2"}


# --- end to end, through the real retrieval path -----------------------------

def _seed_video(
    video_id: str,
    segments: list[tuple[float, float, str]] = (),
    ocr: list[tuple[float, str]] = (),
) -> str:
    """A real index row set: ocr_blocks/segments plus FTS and embeddings.

    Written straight to the isolated index rather than through `watch`, so the
    test states the exact evidence shape under test — a persistent caption on
    many adjacent frames — without depending on a fixture video happening to
    contain one.
    """
    from watch_skill.index.db import connect
    from watch_skill.index.store import _index_texts

    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, title, duration_seconds) VALUES (?, ?, ?, ?)",
                (video_id, f"src-{video_id}", f"video {video_id}", 600.0),
            )
            items: list[tuple] = []
            for start, end, text in segments:
                cur = conn.execute(
                    "INSERT INTO segments (video_id, start, end, text) VALUES (?, ?, ?, ?)",
                    (video_id, start, end, text),
                )
                items.append(("segment", cur.lastrowid, start, text))
            for ts, text in ocr:
                cur = conn.execute(
                    "INSERT INTO ocr_blocks (video_id, timestamp, text, confidence) "
                    "VALUES (?, ?, ?, ?)",
                    (video_id, ts, text, 0.9),
                )
                items.append(("ocr", cur.lastrowid, ts, text))
            _index_texts(conn, video_id, items)
    finally:
        conn.close()
    return video_id


def test_hybrid_search_lets_transcript_through_a_wall_of_repeated_ocr() -> None:
    """The acceptance defect, end to end through `hybrid_search`.

    A caption OCR'd on twelve adjacent frames, and one transcript line that
    actually answers. Before the fix the caption took every slot.
    """
    from watch_skill.index.retrieval import hybrid_search

    vid = _seed_video(
        "dedupe2e",
        segments=[
            (55.0, 58.0, "this memory is just like a summary of your preferences"),
            (58.0, 61.0, "it doesn't contain the details. however, second brain "
                         "keeps every decision and every detail"),
            (300.0, 303.0, "unrelated talk about templates and folders"),
        ],
        ocr=[(60.0 + i * 0.3, "the second brain") for i in range(12)],
    )

    hits = hybrid_search("what does a second brain keep that memory loses?", video_id=vid, k=8)

    ocr_hits = [h for h in hits if h.kind == "ocr"]
    assert len(ocr_hits) <= 1, (
        f"the repeated caption still holds {len(ocr_hits)} slots: "
        f"{[h.timestamp for h in ocr_hits]}")
    assert any("every decision" in h.text for h in hits), (
        f"the answering transcript line is still crowded out: "
        f"{[(h.kind, h.text[:40]) for h in hits]}")


def test_hybrid_search_keeps_ocr_evidence_on_a_silent_video() -> None:
    """No transcript anywhere: OCR must still fill the evidence set."""
    from watch_skill.index.retrieval import hybrid_search

    vid = _seed_video(
        "silent2e",
        ocr=[
            (10.0, "error: connection refused"),
            (25.0, "retrying in 5 seconds"),
            (40.0, "build failed with exit code 1"),
            (55.0, "see logs for details"),
        ],
    )

    hits = hybrid_search("what error is shown?", video_id=vid, k=8)

    assert hits, "a silent video returned no evidence at all"
    assert all(h.kind == "ocr" for h in hits)
    assert len(hits) >= 3, f"OCR evidence was thinned on a silent video: {len(hits)}"
