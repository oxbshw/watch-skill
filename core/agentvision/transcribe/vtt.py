"""WebVTT parsing with rolling-duplicate collapse (ported from the reference).

YouTube auto-subs emit each line 2-3 times as it scrolls; consecutive
identical or extended cues are merged with their time ranges.
"""
from __future__ import annotations

import re
from pathlib import Path

from agentvision.transcribe.types import Segment, Transcript

_TS_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})"
)
_TAG_RE = re.compile(r"<[^>]+>")


def _to_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_vtt(path: Path) -> Transcript:
    """Parse a VTT file into a deduplicated, timestamped transcript."""
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()

    segments: list[Segment] = []
    i = 0
    while i < len(lines):
        match = _TS_RE.match(lines[i])
        if not match:
            i += 1
            continue
        start = _to_seconds(*match.groups()[:4])
        end = _to_seconds(*match.groups()[4:])
        i += 1
        cue_lines: list[str] = []
        while i < len(lines) and lines[i].strip():
            cleaned = _TAG_RE.sub("", lines[i]).strip()
            if cleaned:
                cue_lines.append(cleaned)
            i += 1
        cue_text = " ".join(cue_lines).strip()
        if cue_text:
            segments.append(Segment(start=round(start, 2), end=round(end, 2), text=cue_text))
        i += 1

    return Transcript(segments=_dedupe(segments), source="captions")


def _dedupe(segments: list[Segment]) -> list[Segment]:
    """Collapse rolling duplicates common in YouTube auto-subs."""
    out: list[Segment] = []
    for seg in segments:
        if out and seg.text == out[-1].text:
            out[-1].end = seg.end
            continue
        if out and seg.text.startswith(out[-1].text + " "):
            out[-1].text = seg.text
            out[-1].end = seg.end
            continue
        out.append(seg)
    return out
