"""Transcription data types shared across the ladder."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Segment:
    """One timestamped span of speech (``speaker`` set when diarization ran)."""

    start: float
    end: float
    text: str
    speaker: str | None = None

    def to_dict(self) -> dict:
        out = {"start": self.start, "end": self.end, "text": self.text}
        if self.speaker is not None:
            out["speaker"] = self.speaker
        return out


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

    def offset(self, seconds: float) -> Transcript:
        """Shift all timestamps (window-extracted audio back to source time)."""
        if not seconds:
            return self
        return Transcript(
            segments=[
                Segment(s.start + seconds, s.end + seconds, s.text, s.speaker)
                for s in self.segments
            ],
            source=self.source,
        )

    def filter_range(self, start: float | None, end: float | None) -> Transcript:
        """Segments overlapping [start, end] (same semantics as the reference)."""
        if start is None and end is None:
            return self
        lo = start if start is not None else float("-inf")
        hi = end if end is not None else float("inf")
        kept = [s for s in self.segments if s.end >= lo and s.start <= hi]
        return Transcript(segments=kept, source=self.source)

    def formatted(self) -> str:
        """`[MM:SS] text` lines (speaker-prefixed when diarized) — the agent-facing rendering."""
        lines = []
        for seg in self.segments:
            start = int(seg.start)
            stamp = f"[{start // 60:02d}:{start % 60:02d}]"
            who = f"{seg.speaker}: " if seg.speaker else ""
            lines.append(f"{stamp} {who}{seg.text}")
        return "\n".join(lines)
