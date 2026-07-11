"""Heuristic classifiers: video content-type and mistake error-class.

Deliberately transparent rules over measurable index statistics — a wrong
classification is inspectable and correctable, which matters more here than
squeezing accuracy out of a black box.
"""
from __future__ import annotations

import re
from typing import Any

ERROR_CLASSES = (
    "missed-ocr",
    "wrong-timestamp",
    "hallucination",
    "language",
    "sampling-miss",
)

_TS_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")


def classify_content_type(video: dict[str, Any]) -> str:
    """Classify from index statistics: aspect ratio, OCR density, cut rate."""
    from watch_skill.index.db import connect  # noqa: PLC0415

    width = video.get("width") or 0
    height = video.get("height") or 0
    duration = video.get("duration_seconds") or 0.0
    if width and height and height > width:
        return "vertical"

    conn = connect()
    try:
        scenes = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (video["id"],)
        ).fetchone()["n"]
        ocr_blocks = conn.execute(
            "SELECT COUNT(*) AS n FROM ocr_blocks WHERE video_id = ?", (video["id"],)
        ).fetchone()["n"]
        speech_seconds = conn.execute(
            "SELECT COALESCE(SUM(end - start), 0) AS s FROM segments WHERE video_id = ?",
            (video["id"],),
        ).fetchone()["s"]
    finally:
        conn.close()

    ocr_density = ocr_blocks / scenes if scenes else 0.0
    cut_rate = scenes / duration if duration else 0.0
    speech_ratio = speech_seconds / duration if duration else 0.0

    if ocr_density >= 1.5:
        return "screencast"
    if cut_rate >= 0.5:
        return "fast-cut"
    if speech_ratio >= 0.6 and cut_rate < 0.2:
        return "talking-head"
    return "generic"


def classify_error(question: str, wrong_answer: str, correction: str) -> str:
    """Pick the error class from the report's own wording."""
    corr = correction.lower()

    if any(k in corr for k in ("on-screen", "on screen", "ocr", "text says", "caption says",
                               "the text", "label", "written")):
        return "missed-ocr"
    if any(k in corr for k in ("language", "arabic", "translat", "english version",
                               "wrong language", "original language")):
        return "language"
    wrong_ts = set(_TS_RE.findall(wrong_answer))
    corr_ts = set(_TS_RE.findall(correction))
    if corr_ts and wrong_ts and corr_ts != wrong_ts:
        return "wrong-timestamp"
    if corr_ts and not wrong_ts:
        return "wrong-timestamp"
    if any(k in corr for k in ("not in the video", "doesn't show", "does not show",
                               "never happens", "never shows", "made up", "isn't there",
                               "is not there", "no such", "refuse")):
        return "hallucination"
    if any(k in corr for k in ("look closer", "zoom", "frame", "moment", "briefly",
                               "for a second", "missed the scene")):
        return "sampling-miss"
    return "sampling-miss"


_GUIDANCE_TEMPLATES = {
    "missed-ocr": "Read the on-screen text carefully — {hint}.",
    "wrong-timestamp": "Verify the timestamp against the evidence before citing — {hint}.",
    "hallucination": "Do not assert what the evidence does not show — {hint}.",
    "language": "Answer from the original-language track — {hint}.",
    "sampling-miss": "Sample the relevant moment densely before concluding — {hint}.",
}


def derive_guidance(error_class: str, correction: str, content_type: str) -> str:
    """One imperative sentence a future prompt can carry."""
    hint = correction.strip().rstrip(".")
    if len(hint) > 140:
        hint = hint[:137] + "..."
    template = _GUIDANCE_TEMPLATES.get(error_class, _GUIDANCE_TEMPLATES["sampling-miss"])
    sentence = template.format(hint=hint)
    if content_type != "generic":
        sentence += f" (applies to {content_type} videos)"
    return sentence
