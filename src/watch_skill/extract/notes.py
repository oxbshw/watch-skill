"""`notes.md` — a readable write-up of an indexed video, every line cited.

Watch Skill could already answer questions about a video and hand back
evidence. What it could not do was produce the document a person actually
wants at the end: something you can read start to finish, send to a
colleague, or paste into an issue.

The obvious way to build one is to feed the transcript to a model and print
what comes back. That produces fluent pages that nobody can check, and it is
exactly the failure this repository spends its time avoiding — prose is very
good at sounding informative about a video it has partly invented.

So the rule here is that **nothing appears in the document that is not in the
index**. Every chapter heading comes from a real boundary, every quote from a
real transcript segment, every frame from a real extracted frame, and every
one of them carries the timestamp it came from. A reader who doubts a line
can jump to that second in the source and settle it. Rendering is
deterministic: same index, same bytes out, no model in the path.

That makes it narrower than a generated essay and considerably more useful:
it is a document whose claims are all checkable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.index.store import get_video

# A quote shorter than this is usually a filler fragment ("yeah", "so") that
# adds a citation without adding information.
_MIN_QUOTE_CHARS = 24
_MAX_QUOTE_CHARS = 220
_MAX_QUOTES_PER_CHAPTER = 3
_MAX_OCR_PER_CHAPTER = 4
_MAX_FRAMES_PER_CHAPTER = 2


def format_timestamp(seconds: float) -> str:
    """`H:MM:SS` for anything over an hour, `M:SS` below it."""
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


@dataclass
class NotesSection:
    """One chapter of the write-up, with the evidence behind it."""

    index: int
    start: float
    end: float
    title: str
    title_source: str
    quotes: list[dict[str, Any]] = field(default_factory=list)
    on_screen_text: list[dict[str, Any]] = field(default_factory=list)
    frames: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index, "start": self.start, "end": self.end,
            "title": self.title, "title_source": self.title_source,
            "quotes": self.quotes, "on_screen_text": self.on_screen_text,
            "frames": self.frames,
        }


@dataclass
class NotesDocument:
    """The whole write-up, plus what it was built from."""

    video_id: str
    title: str
    source: str
    duration_seconds: float
    transcript_source: str | None
    sections: list[NotesSection] = field(default_factory=list)
    entities: list[str] = field(default_factory=list)
    claims: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id, "title": self.title, "source": self.source,
            "duration_seconds": self.duration_seconds,
            "transcript_source": self.transcript_source,
            "sections": [s.to_dict() for s in self.sections],
            "entities": self.entities, "claims": self.claims, "counts": self.counts,
        }


def _clean(text: str) -> str:
    return " ".join((text or "").split())


def _pick_quotes(segments: list[dict], start: float, end: float) -> list[dict]:
    """The most substantial lines spoken inside a chapter, in time order.

    Longest-first to choose, then re-sorted by time to print: a chapter reads
    as a chapter, not as a ranking.
    """
    inside = [
        s for s in segments
        if s["start"] < end and s["end"] > start and len(_clean(s["text"])) >= _MIN_QUOTE_CHARS
    ]
    chosen = sorted(inside, key=lambda s: -len(_clean(s["text"])))[:_MAX_QUOTES_PER_CHAPTER]
    return [
        {"at": round(s["start"], 2), "end": round(s["end"], 2),
         "text": _clean(s["text"])[:_MAX_QUOTE_CHARS]}
        for s in sorted(chosen, key=lambda s: s["start"])
    ]


def _pick_on_screen(ocr: list[dict], start: float, end: float) -> list[dict]:
    """Distinct on-screen text in a chapter, first sighting of each string.

    A caption that stays up for ten seconds is one observation, not forty, so
    repeats of a string already seen in this chapter are dropped.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for row in ocr:
        if not (start <= row["timestamp"] < end):
            continue
        text = _clean(row["text"])
        key = text.lower()
        if len(text) < 3 or key in seen:
            continue
        seen.add(key)
        out.append({"at": round(row["timestamp"], 2), "text": text[:160]})
        if len(out) >= _MAX_OCR_PER_CHAPTER:
            break
    return out


def _pick_frames(scenes: list[dict], start: float, end: float) -> list[dict]:
    inside = [s for s in scenes if start <= s["timestamp"] < end and s.get("frame_path")]
    picked = inside[:_MAX_FRAMES_PER_CHAPTER]
    return [
        {"at": round(s["timestamp"], 2), "path": s["frame_path"],
         "description": _clean(s.get("description") or "")[:160]}
        for s in picked
    ]


def build_notes(video_id_or_source: str) -> NotesDocument:
    """Assemble the write-up for an already-indexed video."""
    from watch_skill.extract.chapters import extract_chapters

    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )
    video_id = video["id"]
    conn = connect()
    try:
        segments = [dict(r) for r in conn.execute(
            "SELECT start, end, text FROM segments WHERE video_id = ? ORDER BY start",
            (video_id,),
        ).fetchall()]
        scenes = [dict(r) for r in conn.execute(
            "SELECT timestamp, frame_path, description FROM scenes "
            "WHERE video_id = ? ORDER BY timestamp",
            (video_id,),
        ).fetchall()]
        ocr = [dict(r) for r in conn.execute(
            "SELECT timestamp, text FROM ocr_blocks WHERE video_id = ? ORDER BY timestamp",
            (video_id,),
        ).fetchall()]
        notes = [dict(r) for r in conn.execute(
            "SELECT kind, text, timestamp FROM notes WHERE video_id = ? "
            "ORDER BY weight DESC, timestamp",
            (video_id,),
        ).fetchall()]
    finally:
        conn.close()

    sections: list[NotesSection] = []
    for chapter in extract_chapters(video_id):
        sections.append(NotesSection(
            index=chapter.index, start=chapter.start, end=chapter.end,
            title=chapter.title, title_source=chapter.title_source,
            quotes=_pick_quotes(segments, chapter.start, chapter.end),
            on_screen_text=_pick_on_screen(ocr, chapter.start, chapter.end),
            frames=_pick_frames(scenes, chapter.start, chapter.end),
        ))

    entities = [n["text"] for n in notes if n["kind"] == "entity"][:12]
    claims = [
        {"text": _clean(n["text"])[:200], "at": n["timestamp"]}
        for n in notes if n["kind"] == "claim"
    ][:8]

    return NotesDocument(
        video_id=video_id,
        title=video.get("title") or video_id,
        source=video.get("source") or "",
        duration_seconds=float(video.get("duration_seconds") or 0.0),
        transcript_source=video.get("transcript_source"),
        sections=sections,
        entities=entities,
        claims=claims,
        counts={
            "chapters": len(sections),
            "transcript_segments": len(segments),
            "frames": len(scenes),
            "on_screen_text_blocks": len(ocr),
        },
    )


def render_notes(
    document: NotesDocument, *, frames_relative_to: Path | None = None
) -> str:
    """Render the document as Markdown. Deterministic — no model, no clock."""

    def frame_link(path: str) -> str:
        if frames_relative_to is None:
            return path
        try:
            return Path(path).resolve().relative_to(
                frames_relative_to.resolve()
            ).as_posix()
        except (ValueError, OSError):
            return Path(path).as_posix()

    lines: list[str] = [
        f"# {document.title}",
        "",
        f"`{document.video_id}` · {format_timestamp(document.duration_seconds)} · "
        f"{document.counts.get('chapters', 0)} chapters",
        "",
        "Every line below is drawn from the index and carries the timestamp it "
        "came from. Nothing here is generated prose about the video — if a "
        "statement is in this document, it is because it was observed at that "
        "second.",
        "",
    ]

    if document.transcript_source:
        lines += [f"Transcript source: `{document.transcript_source}`.", ""]

    if document.entities:
        lines += [
            "## Recurring subjects",
            "",
            ", ".join(f"`{e}`" for e in document.entities),
            "",
        ]

    lines += ["## Chapters", ""]
    for section in document.sections:
        lines += [
            f"### {section.index}. {section.title}",
            "",
            f"`{format_timestamp(section.start)} – {format_timestamp(section.end)}`"
            f"  ·  title from {section.title_source}",
            "",
        ]
        for frame in section.frames:
            caption = frame["description"] or f"Frame at {format_timestamp(frame['at'])}"
            lines += [
                f"![{caption}]({frame_link(frame['path'])})",
                f"*{format_timestamp(frame['at'])} — {caption}*",
                "",
            ]
        if section.quotes:
            for quote in section.quotes:
                lines += [
                    f"> {quote['text']}",
                    f"> — `{format_timestamp(quote['at'])}`",
                    "",
                ]
        if section.on_screen_text:
            lines.append("On screen:")
            lines.append("")
            for item in section.on_screen_text:
                lines.append(f"- `{format_timestamp(item['at'])}` — {item['text']}")
            lines.append("")
        if not section.quotes and not section.on_screen_text and not section.frames:
            lines += ["_No speech, on-screen text or kept frame in this span._", ""]

    if document.claims:
        lines += ["## Statements made", ""]
        for claim in document.claims:
            stamp = (
                f"`{format_timestamp(claim['at'])}` — " if claim.get("at") is not None else ""
            )
            lines.append(f"- {stamp}{claim['text']}")
        lines.append("")

    lines += [
        "## How to check any of this",
        "",
        "```bash",
        f"watch-skill ask {document.video_id} \"<your question>\"",
        "```",
        "",
        "The answer comes back with its own timestamped evidence, drawn from "
        "the same index this document was built from.",
        "",
        f"Built from {document.counts.get('transcript_segments', 0)} transcript "
        f"segments, {document.counts.get('frames', 0)} kept frames and "
        f"{document.counts.get('on_screen_text_blocks', 0)} on-screen text blocks.",
        "",
    ]
    return "\n".join(lines).rstrip() + "\n"
