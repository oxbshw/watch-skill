"""v0.7 i18n fixes: per-script search-recall proof for the scripts that were
silently broken (or missing) in the v0.6 normalizer.

Each block proves a query now matches where it previously failed:
  - Southeast-Asian scriptless scripts (Thai/Lao/Khmer/Myanmar/Tibetan) were
    indexed as ONE token — no substring query could match (the CJK bug, for
    five more scripts).
  - Persian/Urdu letter variants (ی ک heh forms) are distinct code points
    from Arabic and were never unified, so cross-convention queries missed.
  - Cross-script digits never folded to ASCII (٢٠٢٦ ≠ 2026).
  - Hebrew final forms / niqqud, Greek final sigma / tonos, German ß, and
    Cyrillic ё were not folded.

The existing 8-language matrix (test_i18n.py) and the Arabic suite
(test_arabic.py) must stay green alongside these.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.index.textnorm import normalize_for_search as norm


def _fts_find(stored: str, query: str) -> list[str]:
    """Store one segment and return the display texts a query matches."""
    from watch_skill.index.db import connect
    from watch_skill.index.retrieval import _fts_query

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
    return [r["text"] for r in rows]


# --- Southeast-Asian scriptless scripts -----------------------------------

# (lang, first word, second word) — stored = word1+word2 (no space), query = word2.
SEA_WORDS = [
    ("th", "ยินดีต้อนรับ", "กรุงเทพ"),   # "welcome" + "Bangkok"
    ("lo", "ຍິນດີຕ້ອນຮັບ", "ນະຄອນຫຼວງ"),  # "welcome" + "capital"
    ("km", "សូមស្វាគមន៍", "ភ្នំពេញ"),      # "welcome" + "Phnom Penh"
    ("my", "ကြိုဆိုပါသည်", "ရန်ကုန်"),      # "welcome" + "Yangon"
    ("bo", "བཀྲཤིས", "བདེལེགས"),          # "tashi" + "delek"
]


@pytest.mark.parametrize("lang,w1,w2", SEA_WORDS, ids=[c[0] for c in SEA_WORDS])
def test_sea_scripts_now_segment(lang: str, w1: str, w2: str) -> None:
    """A multi-syllable SEA word gains internal spaces (was one token)."""
    normalized = norm(w2)
    assert " " in normalized, f"[{lang}] {w2!r} did not segment: {normalized!r}"


@pytest.mark.parametrize("lang,w1,w2", SEA_WORDS, ids=[c[0] for c in SEA_WORDS])
def test_sea_fts_substring_recall(lang: str, w1: str, w2: str) -> None:
    """A word embedded in a longer unspaced run is now findable."""
    stored = w1 + w2
    assert _fts_find(stored, w2) == [stored], f"[{lang}] {w2!r} missed in {stored!r}"


# --- Persian / Urdu unification -------------------------------------------

def test_persian_yeh_and_keheh_fold_to_arabic() -> None:
    assert norm("ایران") == norm("ايران")  # farsi yeh (ی) vs arabic yeh (ي)
    assert norm("کتاب") == norm("كتاب")     # keheh (ک) vs arabic kaf (ك)


def test_urdu_heh_variants_fold() -> None:
    assert norm("خانہ") == norm("خانه")  # urdu heh goal (ہ) vs heh (ه)
    assert norm("پھر") == norm("پهر")     # heh doachashmee (ھ) vs heh (ه)


def test_persian_fts_cross_convention() -> None:
    """A Persian segment written with Farsi letters is found by an Arabic-form query."""
    stored = "ایران کشور زیبایی است"
    assert _fts_find(stored, "ايران") == [stored]  # arabic-yeh query hits farsi-yeh text


# --- cross-script digits ---------------------------------------------------

DIGIT_CASES = [
    ("arabic-indic", "٢٠٢٦"),
    ("persian", "۲۰۲۶"),
    ("devanagari", "२०२६"),
    ("bengali", "২০২৬"),
    ("thai", "๒๐๒๖"),
]


@pytest.mark.parametrize("system,digits", DIGIT_CASES, ids=[c[0] for c in DIGIT_CASES])
def test_digits_fold_to_ascii(system: str, digits: str) -> None:
    assert norm(digits) == "2026", f"[{system}] {digits!r} did not fold"


def test_digits_fts_match_both_directions() -> None:
    assert _fts_find("سنة ٢٠٢٦ الجديدة", "2026") == ["سنة ٢٠٢٦ الجديدة"]
    assert _fts_find("release year 2026", "٢٠٢٦") == ["release year 2026"]


# --- Hebrew ----------------------------------------------------------------

def test_hebrew_final_forms_fold() -> None:
    assert norm("ן") == norm("נ")  # final nun -> nun
    assert norm("ץ") == norm("צ")  # final tsadi -> tsadi


def test_hebrew_niqqud_stripped() -> None:
    assert norm("שָׁלוֹם") == norm("שלום")


# --- Greek -----------------------------------------------------------------

def test_greek_final_sigma_and_tonos_fold() -> None:
    assert norm("λόγος") == "λογοσ"          # tonos stripped, final sigma -> sigma
    assert norm("Ελληνικά") == "ελληνικα"    # uppercase + tonos


# --- German ----------------------------------------------------------------

def test_german_eszett_and_umlaut_fold() -> None:
    assert norm("Straße") == "strasse"
    assert norm("Müller") == norm("Muller")


# --- Cyrillic / Vietnamese -------------------------------------------------

def test_cyrillic_yo_folds() -> None:
    assert norm("ёлка") == norm("елка")
    assert norm("Ёлка") == norm("елка")


def test_vietnamese_diacritics_fold() -> None:
    assert norm("Tiếng Việt") == "tieng viet"


# --- forward migration -----------------------------------------------------

def test_migration_v6_refolds_sea_and_digits(tmp_path: Path) -> None:
    """A pre-v6 index (SEA run as one token, question with Arabic digits)
    becomes findable / re-keyed after the migration, losing no display text."""
    import sqlite3

    from watch_skill.index.db import MIGRATIONS, migrate

    db = tmp_path / "legacy dir" / "index.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        # Build a v5 database by hand, then insert rows carrying the OLD folding.
        conn.executescript(MIGRATIONS[0])  # v1 base schema
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        conn.execute("INSERT INTO schema_version VALUES (1)")
        # Apply v2..v5 so fts (with text_norm/tokenizer) and answers exist.
        assert migrate(conn) == len(MIGRATIONS)  # v6 included: full chain

        stored = "ยินดีต้อนรับกรุงเทพ"
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, 'v1', 'segment', 1, 0.0)",
            (stored, stored),  # deliberately UNfolded (pre-v6 state)
        )
        conn.execute(
            "INSERT INTO videos (id, source) VALUES ('v1', 'src')"
        )
        conn.execute(
            "INSERT INTO answers (video_id, question, question_norm, answer_json) "
            "VALUES ('v1', ?, ?, '{}')",
            ("سنة ٢٠٢٦", "سنة ٢٠٢٦"),  # unfolded digits
        )
        # Re-run just the v6 transform (idempotent) by rolling the version back.
        conn.execute("DELETE FROM schema_version")
        conn.execute("INSERT INTO schema_version VALUES (5)")
        assert migrate(conn) == len(MIGRATIONS)

        from watch_skill.index.retrieval import _fts_query

        rows = conn.execute(
            "SELECT text FROM fts WHERE fts MATCH ?", (_fts_query("กรุงเทพ"),)
        ).fetchall()
        assert [r["text"] for r in rows] == [stored]

        q = conn.execute(
            "SELECT question_norm FROM answers WHERE video_id = 'v1'"
        ).fetchone()
        assert "2026" in q["question_norm"]  # digits re-folded
    finally:
        conn.close()
