"""Confidence scoring from real retrieval signals — no vibes.

Three measurable signals, blended:
- absolute strength of the top hit (hybrid score),
- margin between the top hit and the runner-up (a clear winner beats a
  crowd of look-alikes),
- evidence agreement: how many independent evidence kinds (transcript /
  OCR / scene description) land within a few seconds of the top hit.

A vision model's own stated certainty (when a verify pass runs) is merged
in by the engine afterwards; this module is model-free.
"""
from __future__ import annotations

from agentvision.index.retrieval import Hit

AGREEMENT_WINDOW_SECONDS = 6.0

# Calibrated on measured hybrid scores (see docs/DECISIONS.md, v0.6 audit):
# a genuine match tops ~0.9 with a ~0.29 margin over the runner-up; a fluent
# but ABSENT question still tops ~0.59 (stop-word bm25 + generic cosine) yet
# its margin collapses to ~0.02. Margin is therefore the dominant signal.
_TOP_SCORE_CEILING = 0.9
_MARGIN_CEILING = 0.25


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def evidence_agreement(hits: list[Hit], window: float = AGREEMENT_WINDOW_SECONDS) -> float:
    """Fraction of evidence kinds that corroborate the top hit's moment.

    Only hits scoring at least 40% of the top hit count as corroboration —
    otherwise indexed noise (a burned-in clock the OCR read, a stray scene
    line) near the right timestamp inflates confidence it did not earn.
    """
    if not hits or hits[0].timestamp is None:
        return 0.0
    anchor = hits[0].timestamp
    strength_gate = hits[0].score * 0.4
    kinds = {
        h.kind
        for h in hits[:6]
        if h.timestamp is not None
        and abs(h.timestamp - anchor) <= window
        and h.score >= strength_gate
    }
    return len(kinds) / 3.0


def _competitor_score(hits: list[Hit], window: float = AGREEMENT_WINDOW_SECONDS) -> float:
    """The strongest RIVAL to the top hit.

    A different-kind hit at the same moment (OCR text under the frame a
    transcript segment describes) corroborates — it is excluded. A same-kind
    hit is always a rival, however close in time: two transcript segments
    are two different statements, and treating adjacent ones as support let
    an absent answer fake a clear win on short clips (found live).
    """
    if len(hits) < 2:
        return 0.0
    anchor_ts = hits[0].timestamp
    rivals = [
        h.score for h in hits[1:]
        if h.kind == hits[0].kind
        or h.timestamp is None
        or anchor_ts is None
        or abs(h.timestamp - anchor_ts) > window
    ]
    return max(rivals) if rivals else 0.0


# question words carry no content; anything else ≥3 chars is a content term
_STOPWORDS = frozenset(
    "the a an is are was were does do did what when where who whom which why how "
    "about with from into over under this that these those there here they them "
    "and or not any some its his her their our your you say says said show shows "
    "shown appear appears happen happens video narrator".split()
)


def lexical_anchor(question: str, hits: list[Hit]) -> float:
    """Fraction of the question's content terms present in the top evidence.

    The discriminator retrieval similarity misses (found live): a fluent
    question about ABSENT content ('giraffe riding a bicycle') scores almost
    like a PRESENT one ('elephants trunks') on embeddings — but the present
    one's terms literally appear in the evidence text and the absent one's
    never do. Normalization matches Arabic folding and CJK segmentation.
    """
    from agentvision.index.textnorm import normalize_for_search  # noqa: PLC0415

    if not hits:
        return 0.0
    terms = [
        normalize_for_search(token)
        for token in question.split()
        if token.lower().strip("?!.,؟") not in _STOPWORDS
    ]
    terms = [t for t in terms if len(t.replace(" ", "")) >= 3]
    if not terms:
        return 0.0
    blob = " ".join(normalize_for_search(h.text) for h in hits[:5])
    found = sum(1 for t in terms if t in blob)
    return found / len(terms)


def retrieval_confidence(hits: list[Hit], question: str = "") -> float:
    """Blend the four retrieval signals into one 0..1 score."""
    if not hits:
        return 0.0
    top = _clamp(hits[0].score / _TOP_SCORE_CEILING)
    margin = _clamp((hits[0].score - _competitor_score(hits)) / _MARGIN_CEILING)
    agreement = _clamp(evidence_agreement(hits))
    anchor = lexical_anchor(question, hits) if question else 0.0
    return _clamp(0.25 * top + 0.3 * margin + 0.15 * agreement + 0.3 * anchor)


def merge_model_certainty(retrieval: float, model_certainty: float) -> float:
    """Fold the verify pass's stated certainty into the final score."""
    return _clamp(0.55 * retrieval + 0.45 * _clamp(model_certainty))
