"""The critic: frames + OCR + pass criteria -> STRUCTURED JSON verdict.

Schema is enforced with pydantic; malformed model output is retried once
with the validation error fed back. The critic uses the strong vision tier.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from agentvision.errors import LoopError, VisionError
from agentvision.perceive.types import PerceptionResult
from agentvision.vision import get_vision

_MAX_CRITIC_FRAMES = 10


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
    frames = perception.frames
    if len(frames) <= _MAX_CRITIC_FRAMES:
        return frames
    idx = [round(i * (len(frames) - 1) / (_MAX_CRITIC_FRAMES - 1)) for i in range(_MAX_CRITIC_FRAMES)]
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
    prompt = _PROMPT_TEMPLATE.format(
        criteria=pass_criteria.strip(), timeline=timeline, ocr_section=ocr_section
    )
    return prompt, [f.path for f in frames]


def parse_critique(raw: str) -> Critique:
    """Extract and validate the JSON object from model output."""
    match = _JSON_RE.search(raw)
    if match is None:
        raise ValueError("no JSON object found in critic output")
    return Critique.model_validate(json.loads(match.group(0)))


def critique_recording(
    perception: PerceptionResult,
    pass_criteria: str,
    provider: str | None = None,
    model: str | None = None,
) -> Critique:
    """Run the strong-tier critic over a recording's perception result.

    Retries once on malformed JSON, feeding the validation error back.
    """
    vision = get_vision("strong", provider=provider, model=model)
    prompt, frame_paths = _build_prompt(perception, pass_criteria)
    last_error: Exception | None = None
    for attempt in range(2):
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
        except VisionError:
            raise
    raise LoopError(
        f"critic returned malformed JSON twice: {last_error}",
        code="loop.critic_malformed",
        fix="try a stronger model for vision.strong, or simplify the pass criteria",
    )
