"""Auto-chapters: segment an indexed video into titled chapters.

Boundaries come from what the index already knows — scene changes (visual
cuts) reconciled with transcript pauses (topic shifts). Titles prefer the
first spoken line of the chapter, then the scene description, then OCR.
Deterministic: same index, same chapters.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.index.store import get_video

_MIN_CHAPTER_SECONDS = 8.0
_TRANSCRIPT_GAP_SECONDS = 2.5  # a pause this long suggests a topic shift
_TITLE_MAX_CHARS = 70


@dataclass
class Chapter:
    """One titled span of the video."""

    index: int
    start: float
    end: float
    title: str
    title_source: str  # transcript | scene | ocr | none

    def to_dict(self) -> dict[str, Any]:
        return vars(self)


def _boundaries(scenes: list[dict], segments: list[dict], duration: float) -> list[float]:
    """Candidate chapter starts: scene cuts + starts after long speech pauses."""
    marks = {0.0}
    marks.update(row["timestamp"] for row in scenes)
    previous_end: float | None = None
    for seg in segments:
        if previous_end is not None and seg["start"] - previous_end >= _TRANSCRIPT_GAP_SECONDS:
            marks.add(seg["start"])
        previous_end = seg["end"]
    ordered = sorted(m for m in marks if 0.0 <= m < duration)

    # enforce a minimum chapter length: 8 s normally, proportionally smaller
    # for short clips (a 12 s clip legitimately has 3 s scene-cut chapters),
    # proportionally larger for very long videos (a 2 h talk should not get
    # hundreds of chapters)
    min_len = max(duration / 40, min(_MIN_CHAPTER_SECONDS, duration / 4))
    kept: list[float] = []
    for mark in ordered:
        if not kept or mark - kept[-1] >= min_len:
            kept.append(mark)
    return kept or [0.0]


def _clean_title(text: str) -> str:
    text = " ".join(text.split())
    if len(text) > _TITLE_MAX_CHARS:
        text = text[: _TITLE_MAX_CHARS - 1].rstrip() + "…"
    return text


def _title_for(
    start: float, end: float,
    segments: list[dict], scenes: list[dict], ocr: list[dict],
) -> tuple[str, str]:
    """(title, source) for one chapter span."""
    for seg in segments:
        if seg["start"] >= start - 0.5 and seg["start"] < end and seg["text"].strip():
            return _clean_title(seg["text"]), "transcript"
    for row in scenes:
        if start - 0.5 <= row["timestamp"] < end and (row["description"] or "").strip():
            return _clean_title(row["description"]), "scene"
    for row in ocr:
        if start - 0.5 <= row["timestamp"] < end and row["text"].strip():
            return _clean_title(row["text"]), "ocr"
    return f"Chapter at {int(start // 60)}:{int(start % 60):02d}", "none"


def extract_chapters(video_id_or_source: str) -> list[Chapter]:
    """Titled chapters with timestamps for an already-indexed video."""
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )
    duration = float(video.get("duration_seconds") or 0.0)
    conn = connect()
    try:
        scenes = [dict(r) for r in conn.execute(
            "SELECT timestamp, description FROM scenes WHERE video_id = ? ORDER BY timestamp",
            (video["id"],),
        ).fetchall()]
        segments = [dict(r) for r in conn.execute(
            "SELECT start, end, text FROM segments WHERE video_id = ? ORDER BY start",
            (video["id"],),
        ).fetchall()]
        ocr = [dict(r) for r in conn.execute(
            "SELECT timestamp, text FROM ocr_blocks WHERE video_id = ? ORDER BY timestamp",
            (video["id"],),
        ).fetchall()]
    finally:
        conn.close()
    if duration <= 0.0:
        duration = max(
            [row["timestamp"] for row in scenes]
            + [seg["end"] for seg in segments]
            + [1.0]
        )

    starts = _boundaries(scenes, segments, duration)
    chapters: list[Chapter] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else duration
        title, source = _title_for(start, end, segments, scenes, ocr)
        chapters.append(Chapter(index=i + 1, start=round(start, 2), end=round(end, 2),
                                title=title, title_source=source))
    return chapters
