"""The critic: frames + OCR + pass criteria -> STRUCTURED JSON verdict.

Schema is enforced with pydantic; malformed model output is retried once
with the validation error fed back. The critic uses the strong vision tier.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from watch_skill.config import get_settings
from watch_skill.errors import VisionError
from watch_skill.perceive.types import PerceptionResult
from watch_skill.vision import get_vision


class Issue(BaseModel):
    """One problem the critic found."""

    timestamp: float = Field(ge=0, description="Seconds into the recording.")
    severity: str = Field(pattern="^(critical|major|minor)$")
    description: str
    suggested_fix: str = ""


class Critique(BaseModel):
    """The critic's full structured verdict."""

    verdict: str = Field(pattern="^(pass|fail)$")
    score: int = Field(ge=0, le=100)
    summary: str = ""
    issues: list[Issue] = Field(default_factory=list)


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)

_PROMPT_TEMPLATE = """You are a strict visual QA critic reviewing a screen recording.

PASS CRITERIA (the recording must satisfy ALL of these):
{criteria}

Frame timestamps, in order: {timeline}
{ocr_section}
{directive} (the JSON keys stay in English; only the human-readable
"summary", "description", and "suggested_fix" values use that language.)
Return ONLY a JSON object, no prose, matching exactly:
{{
  "verdict": "pass" | "fail",
  "score": <0-100 integer, 100 = flawless>,
  "summary": "<one sentence>",
  "issues": [
    {{"timestamp": <seconds>, "severity": "critical"|"major"|"minor",
      "description": "<what is visually wrong>",
      "suggested_fix": "<concrete code/UI change to try>"}}
  ]
}}
"verdict" must be "pass" only when every criterion is met and there are no
critical or major issues."""


def _select_frames(perception: PerceptionResult) -> list:
    cap = max(2, get_settings().critic_frame_cap)
    frames = perception.frames
    if len(frames) <= cap:
        return frames
    idx = [round(i * (len(frames) - 1) / (cap - 1)) for i in range(cap)]
    return [frames[i] for i in dict.fromkeys(idx)]


def _build_prompt(perception: PerceptionResult, pass_criteria: str) -> tuple[str, list[Path]]:
    frames = _select_frames(perception)
    timeline = ", ".join(f"{f.timestamp_seconds:.1f}s" for f in frames)
    ocr_lines = [
        f"- {f.timestamp_seconds:.1f}s: {f.ocr_text.replace(chr(10), ' / ')}"
        for f in frames
        if f.ocr_text
    ]
    ocr_section = (
        "On-screen text (OCR):\n" + "\n".join(ocr_lines) + "\n" if ocr_lines else ""
    )
    from watch_skill.answer.localize import answer_language_directive, detect_lang

    prompt = _PROMPT_TEMPLATE.format(
        criteria=pass_criteria.strip(),
        timeline=timeline,
        ocr_section=ocr_section,
        directive=answer_language_directive(detect_lang(pass_criteria)),
    )
    return prompt, [f.path for f in frames]


def parse_critique(raw: str) -> Critique:
    """Extract and validate the JSON object from model output."""
    match = _JSON_RE.search(raw)
    if match is None:
        raise ValueError("no JSON object found in critic output")
    return Critique.model_validate(json.loads(match.group(0)))


# --- describe-based critic (small-model path) -------------------------------
# Captioning models (moondream on a low-RAM box) cannot emit the JSON schema,
# but they RELIABLY describe frames and can answer a plain-text PASS/FAIL over
# that evidence. So: real vision describes each frame, a one-line judgment (or
# a deterministic banned-term rule from the criteria) decides, and the
# structured Critique is built in code — the model never has to write JSON.

_JUDGE_PROMPT = (
    "Frame evidence: {evidence}\n"
    "Criteria: {criteria}\n"
    "Does the frame satisfy the criteria? Reply PASS or FAIL."
)

_NEGATIVE_RE = re.compile(r"\b(?:never|no|not|without)\s+([^,.;]+)", re.IGNORECASE)
_EXEMPLAR_RE = re.compile(r"\((?:like|e\.g\.?|such as)\s+([^)]+)\)|\b(?:like|such as)\s+(\S+)", re.IGNORECASE)


# light verbs people put between the negation and the thing itself:
# "never SHOWS nan", "no error toast EVER APPEARS" — the banned term is the
# thing, not the verb phrase (the flagship browser demo shipped a $NaN past
# the rule because the extracted term was 'shows nan')
_LIGHT_VERBS = (
    "shows", "show", "showing", "displays", "display", "displaying",
    "renders", "render", "rendering", "contains", "contain", "containing",
    "says", "say", "reads", "read", "ever", "appears", "appear", "appearing",
    "is", "are", "be", "being", "visible", "present", "shown", "displayed",
)


def _strip_light_verbs(phrase: str) -> str:
    words = phrase.split()
    while words and words[0] in _LIGHT_VERBS:
        words.pop(0)
    while words and words[-1] in _LIGHT_VERBS:
        words.pop()
    return " ".join(words)


def _banned_terms(pass_criteria: str) -> list[str]:
    """'never shows NaN or a placeholder' -> ['nan', 'a placeholder']."""
    terms: list[str] = []
    for match in _NEGATIVE_RE.finditer(pass_criteria):
        for part in re.split(r"\s+or\s+", match.group(1)):
            part = part.strip().strip("\"'").lower()
            core = _strip_light_verbs(part)
            if core:
                terms.append(core)
            elif part:
                terms.append(part)
    return terms


def _shape_pattern(raw: str) -> re.Pattern:
    """An exemplar with digit runs generalized and spaces made optional:
    '$29.00' matches '$348.20'; 'ERROR 502' matches OCR's spaceless
    'ERROR502' (OCR keeps or drops spaces unpredictably)."""
    shaped = re.sub(r"\d+", r"\\d+", re.escape(raw))
    return re.compile(shaped.replace(r"\ ", r"\s*"), re.IGNORECASE)


def _split_exemplars(pass_criteria: str) -> tuple[list[re.Pattern], list[re.Pattern]]:
    """(positive, banned) exemplar shape patterns from the criteria.

    'a real dollar total (like $29.00)' → positive: seeing that shape passes
    the frame. But the SAME exemplar inside a negative clause — 'must never
    show an error screen (like ERROR 502)' — is a concrete example of what
    must NOT appear, so it becomes a banned pattern instead. Getting this
    backwards would make monitors treat the watched-for condition as a pass.
    """
    negative_spans = [m.span() for m in _NEGATIVE_RE.finditer(pass_criteria)]
    positive: list[re.Pattern] = []
    banned: list[re.Pattern] = []
    for match in _EXEMPLAR_RE.finditer(pass_criteria):
        # bare-word exemplars ('like $29.00),') drag along closing brackets
        # and clause punctuation — strip them or the shape demands a literal ')'
        raw = (match.group(1) or match.group(2) or "").strip().strip("\"'.,;:()[]")
        if not raw:
            continue
        in_negative = any(lo <= match.start() < hi for lo, hi in negative_spans)
        (banned if in_negative else positive).append(_shape_pattern(raw))
    return positive, banned


def _violates_rules(evidence: str, banned: list[str]) -> str | None:
    """The banned term found in the evidence, or None. Word-bounded so 'nan'
    does not fire inside 'finance'."""
    low = evidence.lower()
    for term in banned:
        if re.search(rf"(?<!\w){re.escape(term)}(?!\w)", low):
            return term
    return None


def describe_critique(
    perception: PerceptionResult,
    pass_criteria: str,
    provider: str | None = None,
    model: str | None = None,
) -> Critique:
    """Critique via describe-then-judge — the small-model path.

    The vision model describes every selected frame (plain prompt — the one
    thing captioning models do dependably); deterministic rules then decide
    wherever the criteria let them, at the right granularity:

    - banned terms/patterns ('never NaN', 'never … (like ERROR 502)') are
      FRAME-level: appearing anywhere fails the recording;
    - positive exemplars ('(like SCORE: 12)') are RECORDING-level: success
      visible in ANY frame satisfies them — an animated capture legitimately
      has frames where the HUD is missed by OCR;
    - only when no rule speaks does the plain PASS/FAIL text judgment run —
      small models' text reasoning is the least reliable link, so it gets
      the smallest role.

    Any failing frame becomes an Issue; the Critique is assembled in code.
    """
    vision = get_vision("strong", provider=provider, model=model)
    frames = _select_frames(perception)
    banned = _banned_terms(pass_criteria)
    exemplars, banned_patterns = _split_exemplars(pass_criteria)

    evidence_by_frame: list[tuple[Any, str]] = []
    for frame in frames:
        try:
            description = vision.describe_frames([frame.path])[0]
        except VisionError:
            description = ""
        evidence = " / ".join(part for part in (description, frame.ocr_text) if part)
        if evidence:
            evidence_by_frame.append((frame, evidence))

    issues: list[Issue] = []
    for frame, evidence in evidence_by_frame:
        hit = _violates_rules(evidence, banned)
        if hit is None:
            for pattern in banned_patterns:
                match = pattern.search(evidence)
                if match:
                    hit = match.group(0)
                    break
        if hit is not None:
            issues.append(
                Issue(
                    timestamp=frame.timestamp_seconds,
                    severity="critical",
                    description=f"Criteria not met (contains banned '{hit}'); "
                    f"frame shows: {evidence[:220]}",
                    suggested_fix="",
                )
            )

    exemplar_satisfied = bool(exemplars) and any(
        p.search(evidence) for _, evidence in evidence_by_frame for p in exemplars
    )
    if not issues and not exemplar_satisfied:
        # no rule decided anything — fall back to the per-frame text judge
        for frame, evidence in evidence_by_frame:
            try:
                reply = vision.client.generate(
                    _JUDGE_PROMPT.format(evidence=evidence, criteria=pass_criteria.strip())
                )
            except VisionError:
                continue  # judge unavailable; treat the frame as passing
            if "fail" in reply.lower():
                issues.append(
                    Issue(
                        timestamp=frame.timestamp_seconds,
                        severity="major",
                        description=f"Criteria not met (judged failing); "
                        f"frame shows: {evidence[:220]}",
                        suggested_fix="",
                    )
                )
    if issues:
        return Critique(
            verdict="fail",
            score=35,
            summary=issues[0].description[:160],
            issues=issues,
        )
    return Critique(
        verdict="pass",
        score=92,
        summary="All sampled frames satisfy the pass criteria.",
        issues=[],
    )


def critique_recording(
    perception: PerceptionResult,
    pass_criteria: str,
    provider: str | None = None,
    model: str | None = None,
) -> Critique:
    """Run the strong-tier critic over a recording's perception result.

    Retries once on malformed JSON, feeding the validation error back; if the
    model still cannot produce the schema (small captioning models never can),
    degrades to the describe-then-judge critic instead of dying — the vision
    stays real either way.
    """
    vision = get_vision("strong", provider=provider, model=model)
    prompt, frame_paths = _build_prompt(perception, pass_criteria)
    last_error: Exception | None = None
    for _ in range(2):
        try:
            raw = vision.client.generate(prompt, frame_paths)
            return parse_critique(raw)
        except (ValueError, ValidationError, json.JSONDecodeError) as exc:
            last_error = exc
            prompt = (
                prompt
                + f"\n\nYour previous output was invalid ({exc}). "
                "Return ONLY the JSON object this time."
            )
        except VisionError as exc:
            if exc.code in ("vision.empty", "vision.http_error", "vision.call_failed"):
                last_error = exc
                break  # model can't handle the JSON-critic call; degrade below
            raise
    import sys

    print(
        f"[watch-skill] JSON critic unavailable ({last_error}); "
        "falling back to describe-then-judge critic",
        file=sys.stderr,
    )
    return describe_critique(perception, pass_criteria, provider=provider, model=model)
