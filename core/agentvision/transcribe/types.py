"""Transcription data types shared across the ladder."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Segment:
    """One timestamped span of speech."""

    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "text": self.text}


@dataclass
class Transcript:
    """Full transcript plus where it came from.

    ``source`` is one of: ``captions``, ``whisper-local (<model>)``,
    ``whisper-groq``, ``whisper-openai``, or ``none``.
    """

    segments: list[Segment] = field(default_factory=list)
    source: str = "none"

    def __bool__(self) -> bool:
        return bool(self.segments)

    def filter_range(self, start: float | None, end: float | None) -> "Transcript":
        """Segments overlapping [start, end] (same semantics as the reference)."""
        if start is None and end is None:
            return self
        lo = start if start is not None else float("-inf")
        hi = end if end is not None else float("inf")
        kept = [s for s in self.segments if s.end >= lo and s.start <= hi]
        return Transcript(segments=kept, source=self.source)

    def formatted(self) -> str:
        """`[MM:SS] text` lines — the agent-facing rendering."""
        lines = []
        for seg in self.segments:
            start = int(seg.start)
            stamp = f"[{start // 60:02d}:{start % 60:02d}]"
            lines.append(f"{stamp} {seg.text}")
        return "\n".join(lines)
