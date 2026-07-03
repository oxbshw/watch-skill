"""The VisionModel protocol and its default client-backed implementation."""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol

from agentvision.config import get_settings
from agentvision.vision.client import VisionClient

Tier = Literal["cheap", "strong"]


class VisionModel(Protocol):
    """What the engine needs from any vision model."""

    def describe_frames(self, frames: list[Path], context: str = "") -> list[str]:
        """One-line visual description per frame (bulk, indexing-time)."""
        ...

    def answer_over_frames(self, question: str, frames: list[Path], context: str = "") -> str:
        """Answer a question grounded in the given frames + text context."""
        ...

    def compare_frames(self, before: Path, after: Path, prompt: str) -> str:
        """Describe the differences between two frames."""
        ...


class ClientVisionModel:
    """VisionModel over a :class:`VisionClient` (any provider)."""

    def __init__(self, client: VisionClient) -> None:
        self.client = client

    def describe_frames(self, frames: list[Path], context: str = "") -> list[str]:
        """Batch describe: one call, numbered one-liners out."""
        if not frames:
            return []
        prompt = (
            f"You are indexing video frames.{' Context: ' + context if context else ''} "
            f"For EACH of the {len(frames)} images, in order, output exactly one line: "
            "`N: <one-line visual description>` (N is 1-based). No other text."
        )
        raw = self.client.generate(prompt, frames)
        by_number: dict[int, str] = {}
        for line in raw.splitlines():
            head, _, rest = line.strip().partition(":")
            if head.strip().isdigit() and rest.strip():
                by_number[int(head)] = rest.strip()
        return [by_number.get(i + 1, "") for i in range(len(frames))]

    def answer_over_frames(self, question: str, frames: list[Path], context: str = "") -> str:
        prompt = (
            "Answer the question using the video frames shown and the context below. "
            "Cite timestamps from the context when possible; say so plainly when the "
            f"evidence is insufficient.\n\nContext:\n{context}\n\nQuestion: {question}"
        )
        return self.client.generate(prompt, frames)

    def compare_frames(self, before: Path, after: Path, prompt: str) -> str:
        full = (
            "The first image is BEFORE, the second is AFTER. "
            f"{prompt} Be specific about visual differences."
        )
        return self.client.generate(full, [before, after])


def get_vision(tier: Tier = "strong", provider: str | None = None, model: str | None = None) -> ClientVisionModel:
    """Build the configured vision model for a tier, with per-call overrides."""
    settings = get_settings()
    if tier == "cheap":
        resolved_provider = provider or settings.vision_cheap_provider
        resolved_model = model or settings.vision_cheap_model
    else:
        resolved_provider = provider or settings.vision_strong_provider
        resolved_model = model or settings.vision_strong_model
    return ClientVisionModel(VisionClient(provider=resolved_provider, model=resolved_model))
