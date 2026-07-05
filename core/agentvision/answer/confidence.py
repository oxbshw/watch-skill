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


def retrieval_confidence(hits: list[Hit]) -> float:
    """Blend the three retrieval signals into one 0..1 score."""
    if not hits:
        return 0.0
    top = _clamp(hits[0].score / _TOP_SCORE_CEILING)
    runner_up = hits[1].score if len(hits) > 1 else 0.0
    margin = _clamp((hits[0].score - runner_up) / _MARGIN_CEILING)
    agreement = _clamp(evidence_agreement(hits))
    return _clamp(0.3 * top + 0.5 * margin + 0.2 * agreement)


def merge_model_certainty(retrieval: float, model_certainty: float) -> float:
    """Fold the verify pass's stated certainty into the final score."""
    return _clamp(0.55 * retrieval + 0.45 * _clamp(model_certainty))
