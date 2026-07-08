"""Search-time text normalization across scripts.

SQLite FTS5's unicode61 tokenizer matches non-Latin scripts largely
byte-for-byte, so a query that differs only in a letter variant, a digit
system, or word segmentation silently misses. We therefore index a normalized
shadow column (``text_norm``) and normalize queries the same way — the
original text is preserved untouched for display.

What this folds, and why the tokenizer can't do it alone:

- **Arabic** — alef/hamza unification, ta marbuta, alef maqsura, harakat +
  tatweel stripping (the standard Arabic IR set).
- **Persian / Urdu** — Farsi yeh (ی), keheh (ک), and the heh variants are
  *distinct letters* from their Arabic counterparts, not diacritics, so the
  tokenizer never unifies them; a separate fold table maps them onto the
  Arabic canonical forms (``ايران`` ↔ ``ایران``, ``كتاب`` ↔ ``کتاب``).
- **Cross-script digits** — Arabic-Indic, Persian, Devanagari, Bengali, Thai,
  Lao, Tibetan, Myanmar and Khmer digits fold to ASCII, so ``٢٠٢٦`` matches
  ``2026``.
- **Scriptless SEA + CJK** — Thai/Lao/Khmer/Myanmar/Tibetan and Han/Kana/
  Hangul don't separate words with spaces, so unicode61 indexes a whole run
  as ONE token and no substring query can match. Each base char (plus its
  trailing combining vowel/tone marks) becomes its own token; the query
  builder turns a multi-token run into an FTS5 phrase query.
- **Latin / Greek / Cyrillic diacritics** — folded via targeted NFD (café ↔
  cafe, Việt ↔ Viet, τόνος ↔ τονος, ёлка ↔ елка). The tokenizer's
  ``remove_diacritics`` covers most of this for matching, but folding it here
  keeps ``text_norm`` and the answer-cache key self-consistent.
- **Letter-level odds and ends the tokenizer misses** — German ß→ss, Greek
  final sigma ς→σ, Hebrew niqqud stripping + final-form folding (ך→כ …).

Indic (Devanagari/Bengali) vowel signs are word-forming and deliberately
left in place — only the scriptless runs above are segmented.
"""
from __future__ import annotations

import unicodedata

# --- scriptless (no inter-word spaces) ranges we segment char-by-char ------
# Han (incl. ext A), Hiragana, Katakana (+ phonetic extensions), Hangul
# syllables, CJK compatibility ideographs.
_CJK_RANGES = (
    (0x3040, 0x30FF),
    (0x31F0, 0x31FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xAC00, 0xD7AF),
    (0xF900, 0xFAFF),
)
# Southeast-Asian scripts that don't space words — same failure mode as CJK.
_SEA_RANGES = (
    (0x0E00, 0x0E7F),  # Thai
    (0x0E80, 0x0EFF),  # Lao
    (0x0F00, 0x0FFF),  # Tibetan
    (0x1000, 0x109F),  # Myanmar
    (0x1780, 0x17FF),  # Khmer
)
_SEGMENT_RANGES = _CJK_RANGES + _SEA_RANGES

# Latin / Greek / Cyrillic blocks whose diacritics we fold by decomposition.
_WESTERN_RANGES = (
    (0x00C0, 0x024F),  # Latin-1 supplement + extended-A/B
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x04FF),  # Cyrillic
    (0x1E00, 0x1EFF),  # Latin extended additional (Vietnamese)
)


def _in_ranges(cp: int, ranges: tuple[tuple[int, int], ...]) -> bool:
    return any(lo <= cp <= hi for lo, hi in ranges)


def _is_segmentable(ch: str) -> bool:
    return _in_ranges(ord(ch), _SEGMENT_RANGES)


# --- mark stripping --------------------------------------------------------
# Marks removed outright (not word-forming for search): Arabic harakat +
# superscript alef, and Hebrew niqqud + cantillation (the Mn points/accents).
_STRIP_MARKS = (
    {chr(cp) for cp in range(0x064B, 0x0653)}
    | {"ٰ"}
    | {chr(cp) for cp in range(0x0591, 0x05C8) if unicodedata.category(chr(cp)) == "Mn"}
)

# --- letter fold tables ----------------------------------------------------
_ARABIC_FOLD = str.maketrans(
    {
        "أ": "ا",  # alef + hamza above -> alef
        "إ": "ا",  # alef + hamza below -> alef
        "آ": "ا",  # alef madda        -> alef
        "ٱ": "ا",  # alef wasla        -> alef
        "ؤ": "و",  # waw + hamza       -> waw
        "ئ": "ي",  # ya + hamza        -> ya
        "ة": "ه",  # ta marbuta        -> ha
        "ى": "ي",  # alef maqsura      -> ya
        "ـ": None,  # tatweel           -> removed
    }
)

# Persian/Urdu letters that are distinct code points from Arabic — unify onto
# the Arabic canonical forms so a query in either convention matches.
_PERSIAN_FOLD = str.maketrans(
    {
        "ی": "ي",  # farsi yeh    -> arabic yeh
        "ک": "ك",  # keheh        -> arabic kaf
        "ۀ": "ه",  # heh + yeh above -> heh
        "ہ": "ه",  # heh goal (urdu) -> heh
        "ھ": "ه",  # heh doachashmee -> heh
    }
)

# Hebrew final forms -> their base letters.
_HEBREW_FOLD = str.maketrans(
    {
        "ך": "כ",  # final kaf   -> kaf
        "ם": "מ",  # final mem   -> mem
        "ן": "נ",  # final nun   -> nun
        "ף": "פ",  # final pe    -> pe
        "ץ": "צ",  # final tsadi -> tsadi
    }
)

# Letter-level folds the tokenizer misses (applied after lowercasing).
_MISC_FOLD = str.maketrans(
    {
        "ς": "σ",  # greek final sigma -> sigma
        "ё": "е",  # cyrillic yo (ё)   -> ye (е)
        "ß": "ss",       # german eszett     -> ss
    }
)

# Cross-script decimal digits -> ASCII (each block's zero is the base).
_DIGIT_FOLD = str.maketrans(
    {
        chr(base + d): str(d)
        for base in (
            0x0660,  # Arabic-Indic
            0x06F0,  # Extended Arabic-Indic (Persian/Urdu)
            0x0966,  # Devanagari
            0x09E6,  # Bengali
            0x0E50,  # Thai
            0x0ED0,  # Lao
            0x0F20,  # Tibetan
            0x1040,  # Myanmar
            0x17E0,  # Khmer
        )
        for d in range(10)
    }
)


def _fold_western_diacritics(text: str) -> str:
    """Drop combining diacritics whose base is Latin/Greek/Cyrillic.

    Folds café→cafe, naïve→naive, τόνος→τονος, Việt→Viet, ёлка→елка while
    leaving Arabic/Hebrew letters and the word-forming vowel signs of
    Indic/SEA scripts untouched.
    """
    out: list[str] = []
    for ch in text:
        if ch.isascii():
            out.append(ch)
            continue
        decomp = unicodedata.normalize("NFD", ch)
        base = decomp[0]
        # Precomposed Latin letters (incl. Vietnamese ế, à) decompose onto an
        # ASCII base; Greek/Cyrillic onto their own blocks. Everything else
        # (Arabic, Hebrew, Indic, SEA, CJK) is left untouched.
        if base.isascii() or _in_ranges(ord(base), _WESTERN_RANGES):
            out.append("".join(c for c in decomp if unicodedata.category(c) != "Mn"))
        else:
            out.append(ch)
    return "".join(out)


def _segment(text: str) -> str:
    """Space-separate each scriptless base char (plus its combining marks)."""
    if not any(_is_segmentable(ch) for ch in text):
        return text
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        if _is_segmentable(text[i]):
            j = i + 1
            while j < n and unicodedata.category(text[j]) in ("Mn", "Mc"):
                j += 1
            out.append(f" {text[i:j]} ")
            i = j
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def normalize_for_search(text: str) -> str:
    """Fold ``text`` for indexing/matching; display text stays untouched."""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if ch not in _STRIP_MARKS)
    text = _fold_western_diacritics(text)
    text = text.lower()
    text = text.translate(_ARABIC_FOLD)
    text = text.translate(_PERSIAN_FOLD)
    text = text.translate(_HEBREW_FOLD)
    text = text.translate(_MISC_FOLD)
    text = text.translate(_DIGIT_FOLD)
    text = _segment(text)
    return " ".join(text.split()).strip()
