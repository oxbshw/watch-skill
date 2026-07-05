"""Structured answers: what the self-healing loop returns instead of prose."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Evidence:
    """One cited moment. Timestamps here are the ONLY legal citation source."""

    timestamp: float | None
    kind: str  # segment | ocr | scene
    text: str
    score: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Answer:
    """The result of answer_question: text + the signals behind it."""

    video_id: str
    question: str
    text: str
    confidence: float
    verified: bool
    honest_floor: bool
    escalations_used: list[str] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    frames: list[str] = field(default_factory=list)  # paths worth attaching
    cached: bool = False
    budget_stopped: bool = False
    tokens_spent_estimate: int = 0
    tokens_saved_estimate: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["evidence"] = [e.to_dict() if isinstance(e, Evidence) else e for e in self.evidence]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Answer:
        evidence = [Evidence(**e) for e in data.pop("evidence", [])]
        return cls(evidence=evidence, **data)


def est_text_tokens(text: str) -> int:
    """Cheap, stable token estimate (≈4 chars/token) — used for budgets/savings."""
    return len(text) // 4 + 1


def est_frame_tokens(width: int = 512, height: int = 288) -> int:
    """Vision-token estimate for one frame (Anthropic-style w*h/750)."""
    return max(1, (width * height) // 750)
