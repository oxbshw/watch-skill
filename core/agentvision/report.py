"""Render a WatchResult as the agent-facing markdown report.

The format is deliberately compatible with the reference project's proven
contract: header facts, a frame list with `t=MM:SS` + selection reason, and a
fenced timestamped transcript. Agents already know how to consume this.
"""
from __future__ import annotations

from agentvision.perceive.budget import format_time
from agentvision.watch import WatchResult

LONG_VIDEO_WARN_SECONDS = 600


def _header_lines(result: WatchResult) -> list[str]:
    meta = result.metadata
    info = result.acquisition.info
    lines = ["# agentvision: video report", ""]
    lines.append(f"- **Source:** {result.acquisition.source}")
    if info.get("title"):
        lines.append(f"- **Title:** {info['title']}")
    if info.get("uploader"):
        lines.append(f"- **Uploader:** {info['uploader']}")
    lines.append(
        f"- **Duration:** {format_time(meta.duration_seconds)} ({meta.duration_seconds:.1f}s)"
    )
    if result.focused:
        lo = result.start_seconds or 0.0
        hi = result.end_seconds if result.end_seconds is not None else meta.duration_seconds
        lines.append(f"- **Focus range:** {format_time(lo)} -> {format_time(hi)} ({hi - lo:.1f}s)")
    if meta.width and meta.height:
        lines.append(f"- **Resolution:** {meta.width}x{meta.height} ({meta.codec or 'unknown codec'})")
    lines.append(f"- **Acquired via:** {result.acquisition.acquirer}"
                 + (" (cache)" if result.acquisition.from_cache else ""))
    return lines


def _frames_lines(result: WatchResult) -> list[str]:
    lines = ["", "## Frames", ""]
    perception = result.perception
    if perception is None or not perception.frames:
        lines.append("_No frames extracted._")
        return lines
    lines.append(
        f"- **Selection:** {len(perception.frames)} kept from {perception.candidate_count} "
        f"candidates ({perception.engine} engine, {perception.scene_count} scenes, "
        f"{perception.deduped_count} near-duplicates dropped)"
    )
    ocr_frames = sum(1 for f in perception.frames if f.ocr_blocks)
    if ocr_frames:
        lines.append(f"- **OCR:** on-screen text found in {ocr_frames} frames (inline below)")
    lines.append("")
    lines.append(
        "**Read each frame path below with the Read tool to view the image.** "
        "Frames are chronological; `t=MM:SS` is the absolute source timestamp."
    )
    lines.append("")
    for frame in perception.frames:
        line = (
            f"- `{frame.path}` (t={format_time(frame.timestamp_seconds)}, "
            f"scene={frame.scene_id}, reason={frame.reason})"
        )
        if frame.ocr_text:
            snippet = frame.ocr_text.replace("\n", " / ")
            if len(snippet) > 160:
                snippet = snippet[:157] + "..."
            line += f"\n  - OCR: {snippet}"
        lines.append(line)
    return lines


def _transcript_lines(result: WatchResult) -> list[str]:
    lines = ["", "## Transcript", ""]
    transcript = result.transcript
    if transcript:
        lines.append(f"_Source: {transcript.source}._")
        lines.append("")
        lines.append("```")
        lines.append(transcript.formatted())
        lines.append("```")
    else:
        lines.append(
            "_No transcript available — captions missing and no whisper rung succeeded. "
            "Proceed with frames only; run `agentvision doctor` if local whisper should work._"
        )
    return lines


def render_report(result: WatchResult) -> str:
    """Full markdown report for a WatchResult."""
    lines = _header_lines(result)
    lines += _frames_lines(result)

    if (
        not result.focused
        and result.metadata.duration_seconds > LONG_VIDEO_WARN_SECONDS
        and result.perception is not None
    ):
        mins = int(result.metadata.duration_seconds // 60)
        lines += [
            "",
            f"> **Warning:** this is a {mins}-minute video — frame coverage is sparse. "
            "Re-run focused (`--start/--end`) on the section that matters.",
        ]

    lines += _transcript_lines(result)
    lines += ["", "---", f"_Work dir: `{result.work_dir}` — frames live here._"]
    return "\n".join(lines)
