"""AgentVision MCP server (FastMCP): stdio by default, streamable HTTP with --http.

Tools return text + image content blocks, capped at ``response_frame_cap``
images per response â€” retrieval is designed to make more unnecessary.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import anyio
from agentvision.config import get_settings
from agentvision.errors import AgentVisionError
from agentvision.health.binaries import prepend_bin_dir_to_path
from agentvision.perceive.budget import format_time, parse_time
from fastmcp import Context, FastMCP
from fastmcp.utilities.types import Image

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


def _run_watch(
    source: str,
    start: str | None,
    end: str | None,
    budget: int | None,
    progress_cb,
) -> tuple[str, Any]:
    """The synchronous watch+index pipeline shared by both watch paths."""
    from agentvision.index import index_watch_result
    from agentvision.watch import watch

    result = watch(
        source,
        start_seconds=parse_time(start),
        end_seconds=parse_time(end),
        max_frames=budget,
        on_progress=progress_cb,
    )
    progress_cb("indexing (search + embeddings + scene descriptions)", 0.9)
    video_id = index_watch_result(result)
    return video_id, result


def _watch_response(video_id: str, result: Any, question: str | None) -> list[Any]:
    from agentvision.report import render_report

    header = f"video_id: {video_id}\n"
    if question:
        header += f"question (answer it from the frames + transcript below): {question}\n"
    frames = [str(f.path) for f in (result.perception.frames if result.perception else [])]
    return [header + render_report(result), *_frame_images(frames)]


@mcp.tool(output_schema=None)
async def watch_video(
    source: str,
    question: str | None = None,
    start: str | None = None,
    end: str | None = None,
    budget: int | None = None,
    background: bool = False,
    ctx: Context | None = None,
) -> list[Any]:
    """FIRST LOOK at any video — use when given a video you have NOT analyzed
    yet. Accepts any URL yt-dlp supports (1800+ sites), direct media URLs,
    HLS/DASH manifests, and local file paths. Downloads, extracts scene-aware
    deduplicated frames, OCRs them, transcribes (captions first, then local
    whisper), and INDEXES everything. Returns a report + key frames as
    images. For follow-ups about the same video call ask_video — never
    re-watch. start/end (SS, MM:SS, HH:MM:SS) zoom into a section with denser
    sampling; budget caps frame count. Long video or strict client timeout?
    Pass background=true for an instant job_id, then poll get_status."""
    from agentvision import jobs

    job = jobs.start_job(
        "watch",
        lambda progress: _run_watch(source, start, end, budget, progress),
    )
    if background:
        return [
            f"started background watch: job_id `{job.job_id}`\n"
            f"Poll get_status('{job.job_id}') every few seconds; when done it "
            "returns the video_id for ask_video."
        ]
    while job.status == "running":
        if ctx is not None:
            try:
                await ctx.report_progress(job.progress, total=1.0, message=job.phase)
            except Exception:
                pass  # client may not support progress notifications
        await anyio.sleep(1.5)
    if job.status == "failed":
        return [json.dumps(job.error, ensure_ascii=False, indent=2)]
    video_id, result = job.result
    return _watch_response(video_id, result, question)


@mcp.tool
def get_status(job_id: str) -> str:
    """Check a background job started with watch_video(background=true).
    Returns status/phase/progress; when done it includes the video_id to use
    with ask_video. Poll every few seconds, not in a tight loop."""
    from agentvision import jobs

    try:
        job = jobs.get_job(job_id)
    except AgentVisionError as exc:
        return _error_payload(exc)
    payload = job.to_dict()
    if job.status == "done":
        video_id, result = job.result
        payload["video_id"] = video_id
        payload["next"] = f"ask_video('{video_id}', <your question>)"
        payload["transcript_source"] = result.transcript.source
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool(output_schema=None)
def ask_video(
    video: str,
    question: str,
    max_frames: int = 6,
    include_frames: bool | None = None,
    verify: bool | None = None,
) -> list[Any]:
    """ANY follow-up question about a video you (or anyone) already watched —
    ALWAYS prefer this over re-running watch_video: the self-healing answer
    engine retrieves from the persistent index, scores its own confidence,
    escalates (dense re-sampling, zoom-crop re-OCR, stronger model) when
    unsure, and states plainly when the video does not clearly show the
    answer — it never guesses. Responses are TEXT-FIRST with timestamps
    (near-zero image tokens); frames attach only when include_frames=true or
    the engine could not verify and you should look yourself. Accepts a
    video_id or the original source URL/path. Works across sessions."""
    from agentvision.answer import answer_question

    try:
        answer = answer_question(
            video, question, include_frames=include_frames, verify=verify
        )
    except AgentVisionError as exc:
        return [_error_payload(exc)]
    meta = [f"confidence: {answer.confidence:.2f}", f"verified: {str(answer.verified).lower()}"]
    if answer.cached:
        meta.append("cached: true")
    if answer.escalations_used:
        meta.append(f"escalations_used: {', '.join(answer.escalations_used)}")
    if answer.budget_stopped:
        meta.append("stopped at the per-question token budget")
    lines = [
        answer.text,
        "",
        f"({' | '.join(meta)})",
        f"~{answer.tokens_saved_estimate} tokens saved vs raw-frame injection",
    ]
    if answer.frames:
        lines.insert(-1, "Evidence frames attached (look for yourself).")
        return ["\n".join(lines), *_frame_images(answer.frames, cap=max_frames)]
    return ["\n".join(lines)]


@mcp.tool
def report_mistake(
    video: str,
    question: str,
    wrong_answer: str,
    correction: str,
    session_id: str | None = None,
) -> str:
    """The answer to a video question turned out WRONG? Report it here with
    the correction — AgentVision learns from it locally (nothing uploaded):
    the mistake is classified, stored as a lesson, injected into future
    similar questions, and where possible the original question is re-asked
    immediately to confirm the lesson works. Do this whenever the user
    corrects a video answer; it makes every later answer better."""
    from agentvision.lessons import report_mistake as report

    try:
        outcome = report(
            video, question, wrong_answer, correction,
            agent="mcp", session_id=session_id,
        )
    except AgentVisionError as exc:
        return _error_payload(exc)
    return json.dumps(outcome, ensure_ascii=False, indent=2)


@mcp.tool
def stats() -> str:
    """Lifetime token-savings meter: how many tokens AgentVision's text-first
    answers + semantic cache have saved vs naive raw-frame injection."""
    from agentvision.answer.cache import lifetime_stats

    data = lifetime_stats()
    return (
        f"answers served: {data['answers_count']}\n"
        f"tokens saved: ~{data['tokens_saved_total']:,} vs raw-frame injection"
    )


@mcp.tool(output_schema=None)
def get_moment(video: str, timestamp: str, window: float = 10.0) -> list[Any]:
    """Zoom into ONE SPECIFIC MOMENT of an indexed video — use when the user
    names a timestamp ("what happens at 2:30?") or when an ask_video hit
    needs more surrounding detail. Returns dense frames + transcript + OCR
    within `window` seconds around `timestamp` (SS, MM:SS, or HH:MM:SS).
    For a broad question about the whole video, use ask_video instead."""
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
    """Find something across EVERY video ever watched, when you don't know
    which video contains it ("which video mentioned X?"). Hybrid keyword +
    semantic search; Arabic and other scripts are matched with proper
    normalization. Returns videos with timestamped evidence — follow up with
    ask_video or get_moment on a hit. For a question about one known video,
    use ask_video directly."""
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
    """See what is already in the index (id, title, duration, source) — check
    here BEFORE watch_video when the video might have been analyzed in an
    earlier session; if it's listed, go straight to ask_video."""
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
    """Record NEW footage when none exists yet — a live web page (headless
    browser session with optional goto/click/fill/scroll/wait script),
    `screen:` (full desktop), `window:<exact title>`, or adopt an existing
    video file. The recording is analyzed and indexed; returns video_id for
    ask_video. To record AND judge against pass criteria, use loop_start
    instead — capture alone never critiques."""
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
    """START THE LOOP when you built/changed something visual and need to
    VERIFY it actually looks right: records the target (URL / screen: /
    window:<title> / video file), watches the recording, and critiques it
    against your natural-language pass criteria with the strong vision
    model. Returns loop_id + structured issues with timestamps and suggested
    fixes. YOU apply the fixes in code, then call loop_iterate — the loop
    observes, it never edits anything itself."""
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
    """CONTINUE THE LOOP — call this ONLY after you actually changed the code/
    UI in response to loop_start's issues. Re-captures the same target with
    the same script, re-critiques, and diffs against the previous iteration
    (fixed / unchanged / new issues). Stops on pass, max_iterations, or
    no-progress; on pass it renders the before/after MP4+GIF proof."""
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
    """Run this when ANY other tool fails with a dependency/download error, or
    on first use. Checks AND self-heals: installs missing ffmpeg/yt-dlp,
    updates a stale yt-dlp, verifies disk space, GPU, and API keys. Each
    failing check includes a `fix` you can act on."""
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
