"""Arabic search support: normalization, FTS matching, migration transform.

Regression tests for a real bug: FTS5 unicode61 matches Arabic only
byte-for-byte, so hamza variants, alef maqsura, and diacritized words were
unfindable (query 'احمد' missed 'أحمد', etc.).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from agentvision.index.textnorm import normalize_for_search


def test_normalize_folds_hamza_variants() -> None:
    assert normalize_for_search("أحمد") == normalize_for_search("احمد")
    assert normalize_for_search("إسلام") == normalize_for_search("اسلام")
    assert normalize_for_search("آمال") == normalize_for_search("امال")
    assert normalize_for_search("مسؤول") == normalize_for_search("مسوول")


def test_normalize_strips_diacritics_and_tatweel() -> None:
    assert normalize_for_search("مُحَمَّد") == "محمد"
    # tatweel removed; ta marbuta folds too, so compare normalized forms
    assert normalize_for_search("العـــربية") == normalize_for_search("العربية")


def test_normalize_ta_marbuta_and_alef_maqsura() -> None:
    assert normalize_for_search("مدرسة") == normalize_for_search("مدرسه")
    assert normalize_for_search("مستشفى") == normalize_for_search("مستشفي")


def test_normalize_lowercases_latin() -> None:
    assert normalize_for_search("Hello WORLD") == "hello world"


@pytest.mark.parametrize(
    "stored,query",
    [
        ("ذهب أحمد إلى المدرسة صباحاً", "احمد"),
        ("الذكاء الاصطناعي يغير العالم", "الاصطناعى"),
        ("مُحَمَّد يشرح الخوارزمية", "محمد"),
        ("شرح مفصل للبرمجة الحديثة", "الحديثه"),  # ta-marbuta-less query
    ],
)
def test_fts_arabic_variants_match(stored: str, query: str) -> None:
    """End-to-end through the real schema + query builder."""
    from agentvision.index.db import connect
    from agentvision.index.retrieval import _fts_query
    from agentvision.index.textnorm import normalize_for_search as norm

    conn = connect()  # isolated data dir via conftest fixture
    try:
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, 'v1', 'segment', 1, 0.0)",
            (stored, norm(stored)),
        )
        rows = conn.execute(
            "SELECT text FROM fts WHERE fts MATCH ?", (_fts_query(query),)
        ).fetchall()
    finally:
        conn.close()
    assert [r["text"] for r in rows] == [stored], f"query {query!r} missed {stored!r}"


def test_migration_v2_normalizes_legacy_rows(tmp_path: Path) -> None:
    """A v1 database's rows survive the fts rebuild and become findable."""
    from agentvision.index.db import MIGRATIONS, migrate

    db = tmp_path / "legacy dir" / "index.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        # hand-build a v1 database
        conn.executescript(MIGRATIONS[0])
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        conn.execute("INSERT INTO schema_version VALUES (1)")
        conn.execute(
            "INSERT INTO fts (text, video_id, kind, ref_id, timestamp) "
            "VALUES ('قصة أحمد الكاملة', 'v1', 'segment', 1, 2.5)"
        )
        assert migrate(conn) == len(MIGRATIONS)
        row = conn.execute(
            "SELECT text, timestamp FROM fts WHERE fts MATCH 'text_norm:\"احمد\"'"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None and row["text"] == "قصة أحمد الكاملة"
    assert row["timestamp"] == 2.5


def test_ask_video_arabic_question(sample_video: Path, tmp_path: Path) -> None:
    """Arabic transcript indexed via the normal path answers an Arabic question."""
    pytest.importorskip("scenedetect", reason="perceive extra not installed")
    from agentvision.index import ask_video, index_watch_result
    from agentvision.transcribe.types import Segment, Transcript
    from agentvision.watch import watch

    result = watch(
        str(sample_video), out_dir=tmp_path / "عمل بالعربية",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "تظهر شاشة التحذير الحمراء أولاً"),
            Segment(4.5, 7.5, "ثم تظهر أعمدة المعايرة الملوّنة"),
        ],
        source="captions",
    )
    video_id = index_watch_result(result, describe_scenes=False)
    hits = ask_video(video_id, "متى تظهر شاشة التحذير؟")["hits"]
    assert hits, "Arabic question returned no hits"
    assert any("التحذير" in h["text"] for h in hits)
