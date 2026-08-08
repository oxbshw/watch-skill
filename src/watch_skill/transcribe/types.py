"""Transcription data types shared across the ladder."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Word:
    """One word with its own span.

    A segment can run for ten seconds, so "when was X said" answered from
    segment bounds is only ever accurate to the segment. These carry the
    real moment.
    """

    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "text": self.text}


@dataclass
class Segment:
    """One timestamped span of speech (``speaker`` set when diarization ran)."""

    start: float
    end: float
    text: str
    speaker: str | None = None
    # Populated only when word timestamps were requested and the backend
    # produced them; captions and cloud STT leave it empty.
    words: list[Word] = field(default_factory=list)

    def to_dict(self) -> dict:
        out = {"start": self.start, "end": self.end, "text": self.text}
        if self.speaker is not None:
            out["speaker"] = self.speaker
        if self.words:
            out["words"] = [w.to_dict() for w in self.words]
        return out

    def word_at(self, seconds: float) -> Word | None:
        """The word being spoken at ``seconds``, when words are available."""
        for word in self.words:
            if word.start <= seconds <= word.end:
                return word
        return None

    def find_word(self, needle: str) -> Word | None:
        """First word matching ``needle`` (case- and punctuation-insensitive)."""
        target = "".join(ch for ch in needle.lower() if ch.isalnum())
        if not target:
            return None
        for word in self.words:
            if "".join(ch for ch in word.text.lower() if ch.isalnum()) == target:
                return word
        return None


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
                Segment(
                    s.start + seconds,
                    s.end + seconds,
                    s.text,
                    s.speaker,
                    # shift the words too, or they point at the window's
                    # timeline while the segment points at the source's
                    [Word(w.start + seconds, w.end + seconds, w.text) for w in s.words],
                )
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
