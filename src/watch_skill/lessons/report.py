"""report_mistake: turn a wrong answer into a lesson — and prove it stuck.

Where the error class allows, the original question is immediately re-asked
with the fresh lesson injected; when the correction's key terms now surface
in the evidence, the lesson is marked validated.
"""
from __future__ import annotations

import re
from typing import Any

from watch_skill.index import embeddings as emb
from watch_skill.index.store import get_video
from watch_skill.lessons import store
from watch_skill.lessons.classify import classify_content_type, classify_error, derive_guidance

# classes whose fix is mechanical enough that a re-ask can demonstrate it
_REASKABLE = {"missed-ocr", "wrong-timestamp", "sampling-miss"}

_WORD_RE = re.compile(r"[\w؀-ۿ一-鿿]{3,}", re.UNICODE)


def report_mistake(
    video_id_or_source: str,
    question: str,
    wrong_answer: str,
    correction: str,
    *,
    agent: str | None = None,
    session_id: str | None = None,
    reask: bool = True,
) -> dict[str, Any]:
    """Record the mistake, classify it, and (when possible) re-answer with
    the lesson applied to confirm it works. Returns the lesson + outcome."""
    video = get_video(video_id_or_source)
    content_type = classify_content_type(video) if video else "generic"
    error_class = classify_error(question, wrong_answer, correction)
    guidance = derive_guidance(error_class, correction, content_type)

    vecs = emb.embed_texts([f"{question} || {correction}"])
    blob, dim = (emb.pack_vector(vecs[0]), len(vecs[0])) if vecs else (None, None)

    lesson_id = store.add_lesson(
        question=question,
        wrong_answer=wrong_answer,
        correction=correction,
        error_class=error_class,
        guidance=guidance,
        content_type=content_type,
        video_id=video["id"] if video else None,
        agent=agent,
        session_id=session_id,
        embedding=blob,
        dim=dim,
    )

    from watch_skill.lessons.profiles import update_profiles  # noqa: PLC0415

    update_profiles()

    outcome: dict[str, Any] = {
        "lesson_id": lesson_id,
        "error_class": error_class,
        "content_type": content_type,
        "guidance": guidance,
        "validated": False,
    }
    if reask and video is not None and error_class in _REASKABLE:
        outcome.update(_reask_and_validate(lesson_id, video, question, correction))
    return outcome


def _reask_and_validate(
    lesson_id: int, video: dict[str, Any], question: str, correction: str
) -> dict[str, Any]:
    """Re-run the question with the lesson live; validate against correction terms."""
    from watch_skill.answer import answer_question  # noqa: PLC0415

    try:
        answer = answer_question(video["id"], question, use_cache=False)
    except Exception as exc:  # a broken re-ask must not lose the lesson
        return {"reasked": True, "reask_error": str(exc)}

    key_terms = set(_WORD_RE.findall(correction.lower()))
    evidence_text = " ".join(e.text.lower() for e in answer.evidence)
    answer_blob = f"{answer.text.lower()} {evidence_text}"
    hits = [t for t in key_terms if t in answer_blob]
    validated = bool(key_terms) and len(hits) >= max(1, len(key_terms) // 3)
    if validated:
        store.mark_validated(lesson_id)
    return {
        "reasked": True,
        "validated": validated,
        "reask_confidence": answer.confidence,
        "matched_terms": hits[:8],
    }
