"""answer_question: retrieval → confidence → escalate → verify → honest floor.

The reconciliation of accuracy (spend tokens) and economy (save them):
model-free steps run first, model calls only on genuine uncertainty, and a
hard per-question token budget caps the whole ladder. Citation timestamps
can only come from indexed evidence — model prose never invents one.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from watch_skill.answer import cache
from watch_skill.answer.confidence import (
    lexical_anchor,
    merge_model_certainty,
    retrieval_confidence,
)
from watch_skill.answer.ladder import (
    _profile_for,
    dense_resample,
    estimate_verify_cost,
    zoom_crops_reocr,
)
from watch_skill.answer.localize import (
    answer_language_directive,
    detect_lang,
    is_rtl,
    isolate,
    messages,
)
from watch_skill.answer.types import Answer, Evidence, est_frame_tokens, est_text_tokens
from watch_skill.config import get_settings
from watch_skill.errors import IndexError_, VisionError
from watch_skill.index.retrieval import Hit, frames_near, hybrid_search
from watch_skill.index.store import get_video
from watch_skill.perceive.budget import format_time

_TS_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

_VERIFY_PROMPT = """You are verifying an answer against video evidence.
Question: {question}

Indexed evidence (the ONLY citable moments):
{evidence}
{lessons}
The attached frames are the moments about to be cited. Confirm what is
actually visible/audible. {directive} Return ONLY a JSON object:
{{"supported": true/false, "certainty": <0.0-1.0>, "answer": "<one- or two-sentence answer grounded in the evidence, or an explanation of what is missing>"}}"""


def _evidence_from_hits(hits: list[Hit]) -> list[Evidence]:
    return [Evidence(h.timestamp, h.kind, h.text, round(h.score, 4)) for h in hits]


def _grounded_confidence(hits: list[Hit], question: str, floor: float) -> float:
    """Retrieval confidence, capped below the floor when the question has
    ZERO lexical grounding in the evidence — with none of the question's
    content terms present anywhere, only a model verify (which can still
    raise the score later) may clear the floor. No grounding, no confidence."""
    confidence = retrieval_confidence(hits, question)
    if hits and lexical_anchor(question, hits) == 0.0:
        confidence = min(confidence, max(0.0, floor - 0.01))
    return confidence


def _legal_timestamps(evidence: list[Evidence]) -> list[float]:
    return [e.timestamp for e in evidence if e.timestamp is not None]


def _sanitize_timestamps(text: str, legal: list[float]) -> str:
    """Strip timestamp-looking tokens the evidence does not back."""

    def _ok(token: str) -> bool:
        parts = [int(p) for p in token.split(":")]
        seconds = parts[-1] + parts[-2] * 60 + (parts[-3] * 3600 if len(parts) == 3 else 0)
        return any(abs(seconds - ts) <= 2.0 for ts in legal)

    return _TS_RE.sub(lambda m: m.group(0) if _ok(m.group(0)) else "[see evidence]", text)


def _evidence_lines(evidence: list[Evidence], lang: str = "en") -> str:
    """Evidence bullets. In RTL languages the timestamp is isolated so the
    bidi algorithm cannot reorder it or reverse its digits."""
    rtl = is_rtl(lang)
    lines = []
    for e in evidence[:8]:
        stamp = format_time(e.timestamp) if e.timestamp is not None else "--:--"
        stamp = isolate(f"[{stamp}]") if rtl else f"[{stamp}]"
        lines.append(f"- {stamp} ({e.kind}) {e.text}")
    return "\n".join(lines)


def _lesson_lines(question: str, video: dict) -> str:
    """Learned corrections, when the lessons store has relevant ones."""
    settings = get_settings()
    if not settings.lessons_enabled:
        return ""
    try:
        from watch_skill.lessons import relevant_guidance  # noqa: PLC0415

        lines = relevant_guidance(question, video)
    except Exception:  # lessons must never break an answer
        return ""
    if not lines:
        return ""
    return "Learned corrections (from past mistakes on similar videos):\n" + "\n".join(
        f"- {line}" for line in lines
    ) + "\n"


def _frames_for_evidence(video_id: str, evidence: list[Evidence], limit: int = 4) -> list[str]:
    from watch_skill.index.db import connect  # noqa: PLC0415

    conn = connect()
    try:
        out: list[str] = []
        seen: set[str] = set()
        for e in evidence:
            if e.timestamp is None or len(out) >= limit:
                continue
            for frame in frames_near(conn, video_id, e.timestamp, limit=1):
                path = frame["frame_path"]
                if path not in seen and Path(path).is_file():
                    seen.add(path)
                    out.append(path)
        return out
    finally:
        conn.close()


def _try_model_verify(
    question: str,
    evidence: list[Evidence],
    frames: list[str],
    lessons: str,
    tier: str,
    lang: str = "en",
) -> tuple[bool, float, str] | None:
    """One structured verify/answer call; None when no model is reachable.

    The model is told to answer in the QUESTION's language, so a Spanish
    question about a Japanese video comes back in Spanish (cross-lingual by
    contract, not by luck)."""
    from watch_skill.vision import get_vision  # noqa: PLC0415

    prompt = _VERIFY_PROMPT.format(
        question=question,
        evidence=_evidence_lines(evidence),
        lessons=lessons,
        directive=answer_language_directive(lang),
    )
    try:
        vision = get_vision(tier)
        raw = vision.client.generate(prompt, [Path(p) for p in frames][:4])
    except VisionError as exc:
        print(f"[watch-skill] verify pass unavailable ({exc.code})", file=sys.stderr)
        return None
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match is None:
        return None
    try:
        data = json.loads(match.group(0))
        return bool(data["supported"]), float(data["certainty"]), str(data.get("answer", ""))
    except (KeyError, ValueError, json.JSONDecodeError):
        return None


def _honest_floor_text(question: str, evidence: list[Evidence], lang: str = "en") -> str:
    msg = messages(lang)
    # English keeps the exact repr()-quoted wording the trust-contract tests
    # assert; other languages supply their own punctuation in the template.
    q = repr(question) if lang == "en" else question
    lines = [
        msg["floor_headline"].format(q=q),
        msg["floor_noguess"],
    ]
    if evidence:
        lines.append(_evidence_lines(evidence[:5], lang))
    else:
        lines.append(msg["floor_nothing"])
    lines.append(msg["floor_hint"])
    return "\n".join(lines)


def _answer_text(
    question: str, evidence: list[Evidence], model_answer: str | None, lang: str = "en"
) -> str:
    legal = _legal_timestamps(evidence)
    lines = []
    if model_answer:
        lines.append(_sanitize_timestamps(model_answer.strip(), legal))
        lines.append("")
    lines.append(messages(lang)["evidence_label"])
    lines.append(_evidence_lines(evidence, lang))
    return "\n".join(lines)


def answer_question(
    video_id_or_source: str,
    question: str,
    *,
    include_frames: bool | None = None,
    use_cache: bool = True,
    verify: bool | None = None,
    k: int = 8,
) -> Answer:
    """The self-healing ask: never unverified silently, never invented."""
    settings = get_settings()
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )

    if use_cache:
        hit = cache.lookup(video["id"], question)
        if hit is not None:
            hit.tokens_saved_estimate += hit.tokens_spent_estimate  # repeat = free
            cache.record_savings(hit.tokens_spent_estimate)
            return hit

    lang = detect_lang(question)
    lessons = _lesson_lines(question, video)
    profile = _profile_for(video)
    target = min(0.95, settings.answer_confidence_target + profile.get("confidence_target_bump", 0.0))
    floor = min(target, settings.answer_confidence_floor + profile.get("confidence_floor_bump", 0.0))
    budget = settings.answer_token_budget
    spent = est_text_tokens(question) + est_text_tokens(lessons)
    escalations: list[str] = []
    budget_stopped = False

    hits = hybrid_search(question, video_id=video["id"], k=k)
    confidence = _grounded_confidence(hits, question, floor)
    verified = False
    model_answer: str | None = None

    # --- escalation ladder: stop as soon as confidence clears the target ----
    # (adaptive profiles may reorder: screencasts with missed-OCR history
    # try the OCR-recovery step first)
    steps = [("dense_resample", dense_resample), ("zoom_crops_reocr", zoom_crops_reocr)]
    if profile.get("ocr_first"):
        steps.reverse()
    for step_name, step in steps:
        if confidence >= target:
            break
        new_items, cost = step(video, hits)
        escalations.append(step_name)
        spent += cost
        if new_items:
            hits = hybrid_search(question, video_id=video["id"], k=k)
            confidence = _grounded_confidence(hits, question, floor)

    evidence = _evidence_from_hits(hits)
    frames = _frames_for_evidence(video["id"], evidence)

    # --- verify / model answer (cheap first, strong on low confidence) ------
    do_verify = verify if verify is not None else settings.answer_verify_enabled
    model_rejected = False
    if do_verify and evidence:
        tiers = ["cheap"] if confidence >= target else ["cheap", "strong"]
        for tier in tiers:
            call_cost = estimate_verify_cost(len(frames), question + lessons)
            if spent + call_cost > budget:
                budget_stopped = True
                break
            result = _try_model_verify(question, evidence, frames, lessons, tier, lang)
            if result is None:
                break  # no provider reachable — degrade gracefully, model-free
            spent += call_cost
            if tier == "strong":
                escalations.append("strong_tier")
            supported, certainty, answer_text = result
            confidence = merge_model_certainty(confidence, certainty if supported else certainty * 0.3)
            if supported:
                verified = True
                model_rejected = False
                model_answer = answer_text
                break
            # the model looked at the exact frames and did NOT see the claim —
            # retrieval strength cannot override an eyewitness rejection
            model_rejected = True
            model_answer = None

    # --- compose -------------------------------------------------------------
    honest_floor = confidence < floor or not evidence or model_rejected
    if honest_floor:
        text = _honest_floor_text(question, evidence, lang)
    else:
        text = _answer_text(question, evidence, model_answer, lang)

    # auto frame policy: attach only in the uncertain band — confident answers
    # (verified or high-retrieval) stay text-only, floor answers point at
    # get_moment instead. include_frames overrides in either direction.
    uncertain = not verified and confidence < target
    attach = include_frames if include_frames is not None else (uncertain and not honest_floor)
    frame_tokens = est_frame_tokens() * len(frames)
    spent += est_text_tokens(text) + (frame_tokens if attach else 0)

    # naive baseline: a claude-video-style tool injects every indexed frame
    naive = _naive_token_baseline(video["id"]) + est_text_tokens(text)
    answer = Answer(
        video_id=video["id"],
        question=question,
        text=text,
        confidence=round(confidence, 3),
        verified=verified,
        honest_floor=honest_floor,
        escalations_used=escalations,
        evidence=evidence,
        frames=frames if attach else [],
        budget_stopped=budget_stopped,
        tokens_spent_estimate=spent,
        tokens_saved_estimate=max(0, naive - spent),
    )
    cache.put(answer)
    cache.record_savings(answer.tokens_saved_estimate)
    return answer


def _naive_token_baseline(video_id: str) -> int:
    """What a raw-frame-injection approach would have cost for this question:
    every indexed frame of the video, straight into the prompt."""
    from watch_skill.index.db import connect  # noqa: PLC0415

    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (video_id,)
        ).fetchone()
        return int(row["n"]) * est_frame_tokens()
    finally:
        conn.close()
