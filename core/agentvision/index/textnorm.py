"""Search-time text normalization for Arabic, CJK, and Latin scripts.

SQLite FTS5's unicode61 tokenizer matches Arabic only byte-for-byte: a query
with a bare alef never finds a hamza-seated one, and any diacritized word is
unfindable without its exact diacritics. We therefore index a normalized
shadow column (``text_norm``) and normalize queries the same way — original
text is preserved untouched for display.

The rules are the standard Arabic IR folding set (alef/hamza unification,
ta marbuta, alef maqsura, diacritic + tatweel stripping) plus Unicode NFKC
and lowercasing, which also serves Latin scripts.

CJK gets character segmentation: unicode61 treats an unspaced run like
``修理自行车的刹车`` as ONE token, so no substring query can ever match.
Each Han/Kana/Hangul character is indexed as its own token, and the query
builder turns CJK query runs into FTS5 phrase queries (adjacent tokens) —
which also beats the trigram tokenizer, since two-character queries work.
"""
from __future__ import annotations

import unicodedata

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


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)

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
        "ـ": None,      # tatweel           -> removed
    }
)

# Arabic harakat/diacritic ranges + superscript alef.
_DIACRITICS = {chr(cp) for cp in range(0x064B, 0x0653)} | {"ٰ"}


def normalize_for_search(text: str) -> str:
    """Fold ``text`` for indexing/matching; display text stays untouched."""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if ch not in _DIACRITICS)
    text = text.translate(_ARABIC_FOLD).lower()
    if any(_is_cjk(ch) for ch in text):
        text = "".join(f" {ch} " if _is_cjk(ch) else ch for ch in text)
        text = " ".join(text.split())
    return text.strip()
