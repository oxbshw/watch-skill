"""Search-time text normalization, primarily for Arabic.

SQLite FTS5's unicode61 tokenizer matches Arabic only byte-for-byte: a query
with a bare alef never finds a hamza-seated one, and any diacritized word is
unfindable without its exact diacritics. We therefore index a normalized
shadow column (``text_norm``) and normalize queries the same way — original
text is preserved untouched for display.

The rules are the standard Arabic IR folding set (alef/hamza unification,
ta marbuta, alef maqsura, diacritic + tatweel stripping) plus Unicode NFKC
and lowercasing, which also serves Latin scripts.
"""
from __future__ import annotations

import unicodedata

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
    return text.translate(_ARABIC_FOLD).lower().strip()
