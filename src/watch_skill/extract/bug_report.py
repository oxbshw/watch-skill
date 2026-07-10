"""Bug-report mode: pinpoint where an error appears in a screen recording.

Scans the indexed OCR text and scene descriptions for error signals, picks
the EARLIEST strong hit, and assembles a QA-ready report: the frame, the
on-screen error text, and a repro description from the transcript/actions
leading up to it. Deterministic — same index, same report.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.index.retrieval import frames_near
from watch_skill.index.store import get_video
from watch_skill.perceive.budget import format_time

# strong signals first; a bare 3-digit code only counts next to an error word
_ERROR_PATTERNS: tuple[tuple[str, int], ...] = (
    (r"\btraceback\b|\bstack ?trace\b", 5),
    (r"\bexception\b|\bpanic\b|\bfatal\b|\bcrash(ed)?\b", 5),
    (r"\berror\b[:\s]*[A-Z0-9_-]*\d+", 5),   # ERROR 502 / error: 0x80…
    (r"\buncaught\b|\bunhandled\b", 4),
    (r"\berror\b|\bfail(ed|ure)?\b", 3),
    (r"\bnan\b|\bundefined\b|\bnull reference\b", 3),
    (r"\b(4\d\d|5\d\d)\b.{0,24}\b(error|bad|not found|denied|unavailable)\b", 3),
)


@dataclass
class BugReport:
    """Where the error shows, what it says, and how the video got there."""

    video_id: str
    found: bool
    timestamp: float | None = None
    frame_path: str | None = None
    error_text: str = ""
    signal: str = ""
    severity: int = 0
    repro_steps: list[str] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return vars(self)


def _score(text: str) -> tuple[int, str]:
    """(severity, matched signal) for one piece of on-screen/scene text."""
    best, signal = 0, ""
    low = text.lower()
    for pattern, severity in _ERROR_PATTERNS:
        match = re.search(pattern, low, re.IGNORECASE)
        if match and severity > best:
            best, signal = severity, match.group(0)
    return best, signal


def extract_bug_report(video_id_or_source: str, min_severity: int = 3) -> BugReport:
    """Locate the first on-screen error in an indexed screen recording."""
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )
    conn = connect()
    try:
        candidates: list[tuple[float, int, str, str]] = []  # (ts, severity, signal, text)
        for row in conn.execute(
            "SELECT timestamp, text FROM ocr_blocks WHERE video_id = ? ORDER BY timestamp",
            (video["id"],),
        ):
            severity, signal = _score(row["text"])
            if severity >= min_severity:
                candidates.append((row["timestamp"], severity, signal, row["text"]))
        for row in conn.execute(
            "SELECT timestamp, description FROM scenes "
            "WHERE video_id = ? AND description IS NOT NULL ORDER BY timestamp",
            (video["id"],),
        ):
            severity, signal = _score(row["description"] or "")
            if severity >= min_severity:
                candidates.append(
                    (row["timestamp"], severity, signal, row["description"] or "")
                )
        if not candidates:
            return BugReport(
                video_id=video["id"], found=False,
                summary="No on-screen error signal found in OCR or scene descriptions.",
            )

        # earliest moment wins; higher severity breaks ties at the same time
        candidates.sort(key=lambda c: (c[0], -c[1]))
        timestamp, severity, signal, text = candidates[0]

        # every on-screen text at that moment = the full error context
        window = [
            r["text"] for r in conn.execute(
                "SELECT text FROM ocr_blocks WHERE video_id = ? "
                "AND timestamp BETWEEN ? AND ? ORDER BY timestamp",
                (video["id"], timestamp - 0.75, timestamp + 0.75),
            )
        ]
        error_text = " / ".join(dict.fromkeys(window)) or text

        frames = frames_near(conn, video["id"], timestamp, limit=1)
        frame_path = frames[0]["frame_path"] if frames else None

        # repro: what was said/done before the error surfaced
        steps = [
            f"[{format_time(r['start'])}] {r['text']}"
            for r in conn.execute(
                "SELECT start, text FROM segments WHERE video_id = ? AND start <= ? "
                "ORDER BY start DESC LIMIT 4",
                (video["id"], timestamp),
            )
        ][::-1]
    finally:
        conn.close()

    stamp = format_time(timestamp)
    return BugReport(
        video_id=video["id"],
        found=True,
        timestamp=round(timestamp, 3),
        frame_path=frame_path,
        error_text=error_text[:500],
        signal=signal,
        severity=severity,
        repro_steps=steps,
        summary=(
            f"Error appears at {stamp}: \"{error_text[:120]}\". "
            + (f"Preceded by: {steps[-1]}" if steps else "No transcript context before it.")
        ),
    )
