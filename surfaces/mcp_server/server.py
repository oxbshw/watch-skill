"""AgentVision MCP server (FastMCP): stdio by default, streamable HTTP with --http.

Tools return text + image content blocks, capped at ``response_frame_cap``
images per response â€” retrieval is designed to make more unnecessary.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from fastmcp.utilities.types import Image

from agentvision.config import get_settings
from agentvision.errors import AgentVisionError
from agentvision.health.binaries import prepend_bin_dir_to_path
from agentvision.perceive.budget import format_time, parse_time

mcp = FastMCP(
    name="agentvision",
    instructions=(
        "Give this agent a video input. watch_video analyzes + indexes any "
        "source (URL, direct media, HLS/DASH, local file); ask_video answers "
        "follow-ups from the persistent index without re-processing; "
        "get_moment zooms into a timestamp; search_videos spans every video "
        "ever analyzed. Errors carry {error, message, fix} â€” act on `fix`."
    ),
)


def _error_payload(exc: AgentVisionError) -> str:
    return json.dumps(exc.to_dict(), ensure_ascii=False, indent=2)


def _frame_images(frame_paths: list[str], cap: int | None = None) -> list[Image]:
    limit = cap if cap is not None else get_settings().response_frame_cap
    paths = [Path(p) for p in frame_paths if Path(p).is_file()]
    if len(paths) > limit:  # even-sample, first + last kept
        idx = [round(i * (len(paths) - 1) / (limit - 1)) for i in range(limit)]
        paths = [paths[i] for i in dict.fromkeys(idx)]
    return [Image(path=p) for p in paths]


@mcp.tool(output_schema=None)
def watch_video(
    source: str,
    question: str | None = None,
    start: str | None = None,
    end: str | None = None,
    budget: int | None = None,
) -> list[Any]:
    """Watch ANY video (URL, direct media URL, HLS/DASH manifest, local path):
    downloads, extracts scene-aware deduped frames, transcribes
    (captions -> local whisper), OCRs, and INDEXES it for follow-up questions.
    Returns a report plus key frames as images. Use start/end (SS, MM:SS or
    HH:MM:SS) to zoom into a section with denser sampling; budget caps frames."""
    from agentvision.index import index_watch_result
    from agentvision.report import render_report
    from agentvision.watch import watch

    try:
        result = watch(
            source,
            start_seconds=parse_time(start),
            end_seconds=parse_time(end),
            max_frames=budget,
        )
        video_id = index_watch_result(result)
    except AgentVisionError as exc:
        return [_error_payload(exc)]
    header = f"video_id: {video_id}\n"
    if question:
        header += f"question (answer it from the frames + transcript below): {question}\n"
    frames = [str(f.path) for f in (result.perception.frames if result.perception else [])]
    return [header + render_report(result), *_frame_images(frames)]


@mcp.tool(output_schema=None)
def ask_video(video: str, question: str, max_frames: int = 6) -> list[Any]:
    """Ask about an ALREADY-ANALYZED video (by video_id or original source URL).
    Answers come from the persistent index via hybrid keyword+vector retrieval â€”
    fast, no re-processing. Returns evidence with timestamps + relevant frames."""
    from agentvision.index import ask_video as ask

    try:
        result = ask(video, question, max_frames=max_frames)
    except AgentVisionError as exc:
        return [_error_payload(exc)]
    lines = [
        f"# Evidence for: {result['question']}",
        f"video: {result['video']['title'] or result['video']['source']} "
        f"(id {result['video']['id']}, {format_time(result['video']['duration_seconds'])})",
        "",
    ]
    for hit in result["hits"]:
        stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
        lines.append(f"- [{stamp}] ({hit['kind']}, score {hit['score']:.2f}) {hit['text']}")
    if not result["hits"]:
        lines.append("_No matching evidence in the index for this question._")
    lines.append("")
    lines.append("Frames nearest the evidence follow as images (chronology in captions).")
    for frame in result["frames"]:
        lines.append(f"- frame at t={format_time(frame['timestamp'])}: `{frame['frame_path']}`")
    return ["\n".join(lines), *_frame_images([f["frame_path"] for f in result["frames"]])]


@mcp.tool(output_schema=None)
def get_moment(video: str, timestamp: str, window: float = 10.0) -> list[Any]:
    """Zoom into one moment of an indexed video: frames + transcript + OCR
    within `window` seconds around `timestamp` (SS, MM:SS, or HH:MM:SS)."""
    from agentvision.index import get_moment as moment

    try:
        ts = parse_time(timestamp) or 0.0
        ctx = moment(video, ts, window=window)
    except AgentVisionError as exc:
        return [_error_payload(exc)]
    lines = [f"# Moment {format_time(ctx.timestamp)} آ±{ctx.window / 2:.0f}s of {ctx.video_id}", ""]
    if ctx.segments:
        lines.append("Transcript:")
        lines += [f"- [{format_time(s['start'])}] {s['text']}" for s in ctx.segments]
    if ctx.ocr:
        lines.append("On-screen text (OCR):")
        lines += [f"- [{format_time(o['timestamp'])}] {o['text']}" for o in ctx.ocr]
    lines.append("Frames:")
    lines += [f"- t={format_time(f['timestamp'])}: `{f['frame_path']}`" for f in ctx.frames]
    return ["\n".join(lines), *_frame_images([f["frame_path"] for f in ctx.frames])]


@mcp.tool
def search_videos(query: str) -> str:
    """Search across EVERY video ever analyzed (hybrid keyword + semantic).
    Returns matching videos with timestamped evidence; follow up with
    ask_video/get_moment on a hit."""
    from agentvision.index import search_videos as search

    groups = search(query)
    if not groups:
        return f"No indexed content matches {query!r}. Use list_videos to see what is indexed."
    lines = [f"# Matches for {query!r}", ""]
    for group in groups:
        video = group["video"] or {}
        lines.append(f"## {video.get('title') or video.get('source')} (id {video.get('id')})")
        for hit in group["hits"]:
            stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
            lines.append(f"- [{stamp}] ({hit['kind']}, {hit['score']:.2f}) {hit['text']}")
        lines.append("")
    return "\n".join(lines)


@mcp.tool
def list_videos() -> str:
    """List every video in the persistent index (id, title, duration, source)."""
    from agentvision.index import list_videos as videos

    rows = videos()
    if not rows:
        return "The index is empty â€” watch_video something first."
    lines = ["# Indexed videos", ""]
    for row in rows:
        lines.append(
            f"- `{row['id']}` â€” {row['title'] or row['source']} "
            f"({format_time(row['duration_seconds'])}, transcript: {row['transcript_source']}, "
            f"analyzed {row['last_analyzed_at']})"
        )
    return "\n".join(lines)


def _loop_state_report(state: Any) -> str:
    from agentvision.loop.reportfmt import format_loop_state

    return format_loop_state(state)


@mcp.tool(output_schema=None)
def capture(
    target: str,
    duration: float = 10.0,
    script: list[dict[str, Any]] | None = None,
) -> list[Any]:
    """Record a target to video and index it: an http(s) URL (headless browser
    session, optional interaction script of goto/click/fill/scroll/wait steps),
    `screen:` (full desktop), `window:<exact title>`, or an existing video file.
    Returns the video_id for follow-up ask_video/get_moment calls."""
    import tempfile

    from agentvision.index import index_watch_result
    from agentvision.loop import capture as run_capture
    from agentvision.report import render_report
    from agentvision.watch import watch

    try:
        out_dir = Path(tempfile.mkdtemp(prefix="agentvision-capture-"))
        cap = run_capture(target, out_dir, script=script, duration_seconds=duration)
        result = watch(str(cap.video_path), use_cache=False)
        result.acquisition.source = f"capture:{target}"
        video_id = index_watch_result(result)
    except AgentVisionError as exc:
        return [_error_payload(exc)]
    frames = [str(f.path) for f in (result.perception.frames if result.perception else [])]
    return [
        f"video_id: {video_id}\ncaptured {cap.kind} -> {cap.video_path}\n\n" + render_report(result),
        *_frame_images(frames),
    ]


@mcp.tool
def loop_start(
    target: str,
    pass_criteria: str,
    script: list[dict[str, Any]] | None = None,
    max_iterations: int = 5,
    duration: float = 8.0,
) -> str:
    """START THE LOOP: capture the target (URL/screen:/window:/file), watch the
    recording, and critique it against your natural-language pass criteria via
    the strong vision model. Returns loop_id + structured issues. YOU apply the
    suggested fixes, then call loop_iterate -- the loop never edits code itself."""
    from agentvision.loop import loop_start as start

    try:
        state = start(
            target, pass_criteria, script=script,
            max_iterations=max_iterations, duration_seconds=duration,
        )
    except AgentVisionError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_iterate(loop_id: str) -> str:
    """CONTINUE THE LOOP after you applied fixes: re-captures the same target
    with the same script, re-critiques, and diffs against the previous
    iteration (fixed / unchanged / new issues). Stops on pass, max_iterations,
    or no-progress; on pass it renders a before/after MP4+GIF proof."""
    from agentvision.loop import loop_iterate as iterate

    try:
        state = iterate(loop_id)
    except AgentVisionError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_status(loop_id: str) -> str:
    """Inspect a loop's persisted state (status, scores per iteration, artifacts)."""
    from agentvision.loop import loop_status as status

    try:
        state = status(loop_id)
    except AgentVisionError as exc:
        return _error_payload(exc)
    scores = " -> ".join(str(it["critique"]["score"]) for it in state.iterations)
    return _loop_state_report(state) + f"\nscore history: {scores}"


@mcp.tool
def doctor() -> str:
    """Health check + self-heal: ffmpeg/yt-dlp presence (bootstraps if missing),
    yt-dlp freshness (self-updates), disk space, GPU, API keys."""
    from agentvision.health.doctor import run_doctor

    return json.dumps(run_doctor(fix=True).to_dict(), indent=2)


def main(http: bool = False, host: str = "127.0.0.1", port: int = 8747) -> None:
    """Entry point used by `agentvision serve`."""
    prepend_bin_dir_to_path()
    if http:
        mcp.run(transport="http", host=host, port=port)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
