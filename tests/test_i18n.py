"""Multilingual verification matrix: FTS search, OCR routing, transcription
language plumbing, and ask_video — parametrized over the eight launch
languages (Arabic has its own deeper file: test_arabic.py).

Everything here is offline: real SQLite + real normalizer + fake transcripts.
Real per-script OCR accuracy is benchmarked in docs/DECISIONS.md (the models
download on demand, so exercising them is integration-, not unit-, territory).
"""
from __future__ import annotations

from pathlib import Path

import pytest
from watch_skill.index.textnorm import normalize_for_search

# (lang, stored segment, query that must find it)
FTS_MATRIX = [
    ("ar", "ذهب أحمد إلى المدرسة صباحاً", "احمد"),
    ("zh", "本视频教你如何修理自行车的刹车和链条", "修理自行车"),
    ("zh-2char", "本视频教你如何修理自行车的刹车和链条", "刹车"),
    ("ja", "今日は自転車を修理します", "自転車"),
    ("ja-kana", "ビデオへようこそ皆さん", "ようこそ"),
    ("ko", "비디오에 오신 것을 환영합니다", "환영합니다"),
    ("ko-partial", "자전거를 수리하는 방법", "자전거"),
    ("ru", "Сегодня мы готовим итальянскую пасту", "пасту"),
    ("ru-case", "Добро Пожаловать На Видео", "пожаловать"),
    ("hi", "आज दिल्ली में बारिश होगी", "बारिश"),
    ("es", "Bienvenido al vídeo de enseñanza", "vídeo"),
    ("es-fold", "Bienvenido al vídeo de enseñanza", "video"),  # accent-insensitive
    ("fr", "Bienvenue dans la vidéo présentée", "présentée"),
    ("hi-matra", "मौसम का पूर्वानुमान देखिए", "पूर्वानुमान"),
]


@pytest.mark.parametrize("lang,stored,query", FTS_MATRIX, ids=[c[0] for c in FTS_MATRIX])
def test_fts_finds_text_in_language(lang: str, stored: str, query: str) -> None:
    """End-to-end through the real schema + query builder per language."""
    from watch_skill.index.db import connect
    from watch_skill.index.retrieval import _fts_query

    conn = connect()  # isolated data dir via conftest fixture
    try:
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, 'v1', 'segment', 1, 0.0)",
            (stored, normalize_for_search(stored)),
        )
        rows = conn.execute(
            "SELECT text FROM fts WHERE fts MATCH ?", (_fts_query(query),)
        ).fetchall()
    finally:
        conn.close()
    assert [r["text"] for r in rows] == [stored], f"[{lang}] query {query!r} missed"


def test_cjk_segmentation_is_scoped() -> None:
    """CJK chars get spaced; Latin/Arabic text passes through un-exploded."""
    assert normalize_for_search("修理する") == "修 理 す る"
    assert normalize_for_search("bike 修理 guide") == "bike 修 理 guide"
    assert normalize_for_search("Hello World") == "hello world"
    assert normalize_for_search("مدرسة") == normalize_for_search("مدرسه")


def test_migration_v4_renormalizes_cjk_rows(tmp_path: Path) -> None:
    """A pre-v4 index (CJK stored as one unsplittable token) becomes findable."""
    import sqlite3

    from watch_skill.index.db import MIGRATIONS, migrate

    db = tmp_path / "legacy dir" / "index.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(MIGRATIONS[0])
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        conn.execute("INSERT INTO schema_version VALUES (1)")
        conn.execute(
            "INSERT INTO fts (text, video_id, kind, ref_id, timestamp) "
            "VALUES ('自転車を修理します', 'v1', 'segment', 1, 1.0)"
        )
        assert migrate(conn) == len(MIGRATIONS)
        row = conn.execute(
            "SELECT text FROM fts WHERE fts MATCH ?", ('text_norm:"修 理"',)
        ).fetchone()
    finally:
        conn.close()
    assert row is not None and row["text"] == "自転車を修理します"


# ---- OCR language routing (script-model selection is the i18n contract) ----

OCR_ROUTES = [
    ("ar", "arabic"), ("fa", "arabic"), ("ru", "eslav"), ("uk", "eslav"),
    ("bg", "cyrillic"), ("hi", "devanagari"), ("ko", "korean"),
    ("zh", "default"), ("ja", "default"), ("es", "default"), ("fr", "default"),
    ("en", "default"), ("th", "th"), ("el", "el"),
]


@pytest.mark.parametrize("lang,expected", OCR_ROUTES, ids=[r[0] for r in OCR_ROUTES])
def test_ocr_routes_language_to_script_model(lang: str, expected: str) -> None:
    from watch_skill.perceive.ocr import resolve_ocr_lang

    assert resolve_ocr_lang(lang) == expected
    assert resolve_ocr_lang(f"{lang}-XX") == expected  # region tags fold


# ---- transcription language plumbing -------------------------------------

def test_detected_language_reaches_ocr(sample_video: Path, tmp_path: Path, monkeypatch) -> None:
    """The video's detected language must select the OCR engine (auto mode)."""
    pytest.importorskip("scenedetect", reason="perceive extra not installed")
    from watch_skill.perceive import engine as perceive_engine

    seen: list[str | None] = []

    def spy_ocr(path, min_confidence=0.5, lang=None):
        seen.append(lang)
        return []

    monkeypatch.setattr(perceive_engine.ocr, "ocr_frame", spy_ocr)
    perceive_engine.perceive(
        sample_video, tmp_path / "frames", run_ocr=True, max_frames=2, ocr_lang="ko"
    )
    assert seen and all(lang == "ko" for lang in seen)


# ---- ask_video per language (retrieval half of "answers your language") ---

ASK_MATRIX = [
    ("ru", "Сначала появляется красный экран предупреждения", "когда появляется предупреждение?", "предупреждени"),
    ("zh", "首先出现红色警告屏幕", "警告屏幕什么时候出现", "警告"),
    ("fr", "L'écran d'avertissement rouge apparaît en premier", "quand apparaît l'avertissement ?", "avertissement"),
    ("hi", "सबसे पहले लाल चेतावनी स्क्रीन दिखाई देती है", "चेतावनी कब दिखती है?", "चेतावनी"),
]


@pytest.mark.parametrize("lang,segment,question,must_hit", ASK_MATRIX, ids=[c[0] for c in ASK_MATRIX])
def test_ask_video_in_language(
    lang: str, segment: str, question: str, must_hit: str,
    sample_video: Path, tmp_path: Path,
) -> None:
    """A transcript in each language answers a question asked in that language."""
    pytest.importorskip("scenedetect", reason="perceive extra not installed")
    from watch_skill.index import ask_video, index_watch_result
    from watch_skill.transcribe.types import Segment, Transcript
    from watch_skill.watch import watch

    result = watch(
        str(sample_video), out_dir=tmp_path / f"work {lang}",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[Segment(0.5, 3.5, segment)], source="captions"
    )
    video_id = index_watch_result(result, describe_scenes=False)
    hits = ask_video(video_id, question)["hits"]
    assert hits, f"[{lang}] question returned no hits"
    assert any(must_hit in h["text"] for h in hits), f"[{lang}] relevant segment missing"
