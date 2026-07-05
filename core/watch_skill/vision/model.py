"""The VisionModel protocol and its default client-backed implementation."""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol

from watch_skill.config import get_settings
from watch_skill.vision.client import VisionClient

Tier = Literal["cheap", "strong"]


def _parse_numbered(raw: str, count: int) -> list[str]:
    """Parse `N: description` lines; degrade gracefully for sloppy models.

    Small local models sometimes echo the placeholder (`N: ...`) or skip
    numbering entirely — when no numbered lines parse, non-empty lines are
    assigned in order rather than thrown away.
    """
    by_number: dict[int, str] = {}
    for line in raw.splitlines():
        head, _, rest = line.strip().partition(":")
        if head.strip().isdigit() and rest.strip():
            by_number[int(head)] = rest.strip()
    if by_number:
        return [by_number.get(i + 1, "") for i in range(count)]
    lines = []
    for line in raw.splitlines():
        text = line.strip().lstrip("-*• ").strip()
        if text.upper().startswith("N:"):
            text = text[2:].strip()
        if text:
            lines.append(text)
    return [lines[i] if i < len(lines) else "" for i in range(count)]


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
        """Describe frames in numbered batches.

        Batch size comes from settings (``vision_batch_size``); small local
        models get small batches — 24 images in one prompt overflows their
        context and wrecks the numbered-list format.
        """
        if not frames:
            return []
        batch_size = max(1, get_settings().vision_batch_size)
        out: list[str] = []
        for i in range(0, len(frames), batch_size):
            batch = frames[i : i + batch_size]
            out.extend(self._describe_batch_with_retry(batch, context))
        return out

    def _describe_batch_with_retry(self, batch: list[Path], context: str) -> list[str]:
        """One transient failure (timeout on a loaded machine) must not cost
        the whole indexing pass: retry the batch once, then degrade to empty
        descriptions for JUST this batch and keep going. Non-transient errors
        (missing key, unknown provider) still raise."""
        from watch_skill.errors import VisionError

        transient = ("vision.call_failed", "vision.http_error")
        for attempt in (1, 2):
            try:
                return self._describe_batch(batch, context)
            except VisionError as exc:
                if exc.code not in transient:
                    raise
                if attempt == 2:
                    import sys

                    print(
                        f"[watch-skill] describe batch dropped after retry ({exc.code})",
                        file=sys.stderr,
                    )
        return [""] * len(batch)

    def _describe_batch(self, frames: list[Path], context: str) -> list[str]:
        example = "\n".join(f"{i + 1}: <description of image {i + 1}>" for i in range(len(frames)))
        prompt = (
            f"You are indexing video frames.{' Context: ' + context if context else ''} "
            f"Describe EACH of the {len(frames)} images in ONE telegraphic line: "
            "max 12 words, concrete nouns and actions only, no articles, no "
            "filler (write 'terminal, red error banner, stack trace' not 'The "
            "image shows a terminal window that displays...'). Keep exact "
            "names/numbers/text visible on screen. Format:\n"
            f"{example}\nNo other text."
        )
        raw = self.client.generate(prompt, frames)
        return _parse_numbered(raw, len(frames))

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
