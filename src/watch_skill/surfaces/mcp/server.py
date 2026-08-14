"""Watch Skill MCP server (FastMCP): stdio by default, streamable HTTP with --http.

Tools return text + image content blocks, capped at ``response_frame_cap``
images per response — retrieval is designed to make more unnecessary.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import anyio
from fastmcp import Context, FastMCP
from fastmcp.utilities.types import Image

from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.health.binaries import prepend_bin_dir_to_path
from watch_skill.perceive.budget import format_time, parse_time

mcp = FastMCP(
    name="watch-skill",
    instructions=(
        "Give this agent a video input. watch_video analyzes + indexes any "
        "source (URL, direct media, HLS/DASH, local file); ask_video answers "
        "follow-ups from the persistent index without re-processing; "
        "get_moment zooms into a timestamp; search_videos spans every video "
        "ever analyzed. Errors carry {error, message, fix} — act on `fix`."
    ),
)


def _error_payload(exc: WatchSkillError) -> str:
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
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

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


def _maybe_ui(video_id: str) -> list[Any]:
    """The inline viewer page, when the operator has it switched on.

    Off by default: it is a sizeable block, only some clients render it, and
    the ones that don't would otherwise be handed a page they cannot use.
    """
    if not get_settings().mcp_inline_ui:
        return []
    from watch_skill.surfaces.mcp.ui import video_ui

    block = video_ui(video_id)
    return [block] if block else []


def _watch_response(video_id: str, result: Any, question: str | None) -> list[Any]:
    from watch_skill.report import render_report

    header = f"video_id: {video_id}\n"
    if question:
        header += f"question (answer it from the frames + transcript below): {question}\n"
    frames = [str(f.path) for f in (result.perception.frames if result.perception else [])]
    # Text first, always: it is the answer. The UI block is an enhancement a
    # client may ignore, never the thing the answer lives in.
    return [header + render_report(result), *_frame_images(frames), *_maybe_ui(video_id)]


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
    from watch_skill import jobs

    if background:
        # Durable: the id outlives this process, so a client that reconnects
        # after a restart can still collect the result.
        durable = jobs.submit_and_run(
            "watch",
            {"source": source, "start": start, "end": end, "budget": budget},
            idempotency_key=f"watch:{source}:{start}:{end}:{budget}",
        )
        return [
            f"started background watch: job_id `{durable.job_id}`\n"
            f"Poll get_status('{durable.job_id}') every few seconds; when done "
            "it returns the video_id for ask_video. The job survives a server "
            "restart, and cancel_job stops it."
        ]

    job = jobs.start_job(
        "watch",
        lambda progress: _run_watch(source, start, end, budget, progress),
    )
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
    Returns state/stage/progress; when it succeeds it includes the video_id to
    use with ask_video. Poll every few seconds, not in a tight loop.

    Durable job ids survive a server restart. In-process ids (from an older
    session) do not, and say so."""
    from watch_skill import jobs

    try:
        job = jobs.get(job_id)
    except WatchSkillError:
        # Fall back to the in-process table so ids handed out by an older
        # build keep resolving for the life of this process.
        try:
            legacy = jobs.get_job(job_id)
        except WatchSkillError as exc:
            return _error_payload(exc)
        payload = legacy.to_dict()
        if legacy.status == "done" and legacy.result:
            video_id, result = legacy.result
            payload["video_id"] = video_id
            payload["next"] = f"ask_video('{video_id}', <your question>)"
            payload["transcript_source"] = result.transcript.source
        return json.dumps(payload, ensure_ascii=False, indent=2)

    payload = job.to_dict()
    payload["durable"] = True
    if job.state.value == "succeeded" and job.result_kind == "video_id":
        payload["video_id"] = job.result_ref
        payload["next"] = f"ask_video('{job.result_ref}', <your question>)"
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool
def cancel_job(job_id: str) -> str:
    """Stop a durable background job.

    A queued job stops immediately. A running one is asked to stop and
    acknowledges at its next stage checkpoint, so cancellation is real rather
    than a flag nobody reads — partial work is discarded, not half-committed."""
    from watch_skill import jobs

    try:
        job = jobs.cancel(job_id)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps(job.to_dict(), ensure_ascii=False, indent=2)


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
    from watch_skill.answer import answer_question

    try:
        answer = answer_question(
            video, question, include_frames=include_frames, verify=verify
        )
    except WatchSkillError as exc:
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
    the correction — Watch Skill learns from it locally (nothing uploaded):
    the mistake is classified, stored as a lesson, injected into future
    similar questions, and where possible the original question is re-asked
    immediately to confirm the lesson works. Do this whenever the user
    corrects a video answer; it makes every later answer better."""
    from watch_skill.lessons import report_mistake as report

    try:
        outcome = report(
            video, question, wrong_answer, correction,
            agent="mcp", session_id=session_id,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps(outcome, ensure_ascii=False, indent=2)


@mcp.tool
def stats() -> str:
    """Lifetime token-savings meter: how many tokens Watch Skill's text-first
    answers + semantic cache have saved vs naive raw-frame injection."""
    from watch_skill.answer.cache import lifetime_stats

    data = lifetime_stats()
    lines = [
        f"answers served: {data['answers_count']}",
        f"tokens saved: ~{data['tokens_saved_total']:,} vs raw-frame injection",
    ]
    if data.get("library_answers_count"):
        lines += [
            f"library syntheses: {data['library_answers_count']}",
            f"library tokens saved: ~{data['library_tokens_saved']:,}",
        ]
    return "\n".join(lines)


@mcp.tool(output_schema=None)
def get_moment(video: str, timestamp: str, window: float = 10.0) -> list[Any]:
    """Zoom into ONE SPECIFIC MOMENT of an indexed video — use when the user
    names a timestamp ("what happens at 2:30?") or when an ask_video hit
    needs more surrounding detail. Returns dense frames + transcript + OCR
    within `window` seconds around `timestamp` (SS, MM:SS, or HH:MM:SS).
    For a broad question about the whole video, use ask_video instead."""
    from watch_skill.index import get_moment as moment

    try:
        ts = parse_time(timestamp) or 0.0
        ctx = moment(video, ts, window=window)
    except WatchSkillError as exc:
        return [_error_payload(exc)]
    lines = [f"# Moment {format_time(ctx.timestamp)} ±{ctx.window / 2:.0f}s of {ctx.video_id}", ""]
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
    from watch_skill.index import search_videos as search

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
    from watch_skill.index import list_videos as videos

    rows = videos()
    if not rows:
        return "The index is empty — watch_video something first."
    lines = ["# Indexed videos", ""]
    for row in rows:
        lines.append(
            f"- `{row['id']}` — {row['title'] or row['source']} "
            f"({format_time(row['duration_seconds'])}, transcript: {row['transcript_source']}, "
            f"analyzed {row['last_analyzed_at']})"
        )
    return "\n".join(lines)


def _loop_state_report(state: Any) -> str:
    from watch_skill.loop.reportfmt import format_loop_state

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

    from watch_skill.index import index_watch_result
    from watch_skill.loop import capture as run_capture
    from watch_skill.report import render_report
    from watch_skill.watch import watch

    try:
        out_dir = Path(tempfile.mkdtemp(prefix="watch-skill-capture-"))
        cap = run_capture(target, out_dir, script=script, duration_seconds=duration)
        result = watch(str(cap.video_path), use_cache=False)
        result.acquisition.source = f"capture:{target}"
        video_id = index_watch_result(result)
    except WatchSkillError as exc:
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
    from watch_skill.loop import loop_start as start

    try:
        state = start(
            target, pass_criteria, script=script,
            max_iterations=max_iterations, duration_seconds=duration,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_iterate(loop_id: str) -> str:
    """CONTINUE THE LOOP — call this ONLY after you actually changed the code/
    UI in response to loop_start's issues. Re-captures the same target with
    the same script, re-critiques, and diffs against the previous iteration
    (fixed / unchanged / new issues). Stops on pass, max_iterations, or
    no-progress; on pass it renders the before/after MP4+GIF proof."""
    from watch_skill.loop import loop_iterate as iterate

    try:
        state = iterate(loop_id)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_status(loop_id: str) -> str:
    """Inspect a loop's persisted state (status, scores per iteration, artifacts)."""
    from watch_skill.loop import loop_status as status

    try:
        state = status(loop_id)
    except WatchSkillError as exc:
        return _error_payload(exc)
    scores = " -> ".join(str(it["critique"]["score"]) for it in state.iterations)
    return _loop_state_report(state) + f"\nscore history: {scores}"


@mcp.tool
def loop_video_gen(
    spec: str,
    generator_cmd: str,
    output: str,
    pass_criteria: str | None = None,
    workdir: str | None = None,
    max_iterations: int = 5,
    timeout: float = 600.0,
) -> str:
    """START A VIDEO-GENERATION LOOP when you are generating a video (Manim,
    Remotion, ffmpeg, any command) and need to verify the render matches the
    spec: runs generator_cmd, watches the video it writes at `output`, and
    critiques it against the spec/pass_criteria. YOU edit the generator
    (scene code, prompt, args) between iterations, then call loop_iterate —
    the same iterate/diff/artifact machinery as the UI loop."""
    from watch_skill.loop import loop_video_gen as start

    try:
        state = start(
            spec, generator_cmd, output, pass_criteria=pass_criteria,
            workdir=workdir, max_iterations=max_iterations, timeout_seconds=timeout,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_game(
    target: str,
    pass_criteria: str,
    run_cmd: str | None = None,
    script: list[dict[str, Any]] | None = None,
    duration: float = 10.0,
    max_iterations: int = 5,
) -> str:
    """START A GAME/SIMULATION LOOP to catch visual glitches or state failures
    in a running game or sim: optionally launches run_cmd, records gameplay
    from `target` (a canvas game URL, window:<title>, or screen:), and
    critiques the recording against your criteria (e.g. 'the score counter
    must never show negative numbers, no black flicker frames'). Fix the
    game code between iterations, then loop_iterate."""
    from watch_skill.loop import loop_game as start

    try:
        state = start(
            target, pass_criteria, run_cmd=run_cmd, script=script,
            duration_seconds=duration, max_iterations=max_iterations,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _loop_state_report(state)


@mcp.tool
def loop_monitor(
    source: str,
    condition: str,
    interval: float = 10.0,
    max_checks: int = 10,
    sample_seconds: float = 5.0,
) -> str:
    """WATCH a folder of videos or a live target until a described condition
    appears (e.g. 'a demo error screen shows'), then return a structured
    event. Bounded by max_checks — it always terminates. Folder sources
    consume each video once; live targets (URL / screen: / window:) sample
    `sample_seconds` every `interval`. Events also land in events.jsonl under
    the monitor's loop dir so other tools can react."""
    import json as _json

    from watch_skill.loop import loop_monitor as monitor

    try:
        result = monitor(
            source, condition, interval_seconds=interval,
            max_checks=max_checks, sample_seconds=sample_seconds,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _json.dumps(result.to_dict(), ensure_ascii=False, indent=2)


@mcp.tool
def generate_viewer(video: str, out_path: str | None = None) -> str:
    """Render a SHAREABLE, self-contained HTML page for an analyzed video:
    timeline + key frames (inlined — works offline, zero external requests),
    the transcript, on-screen text, and every cached answer with the exact
    evidence the engine cited. Give the user the returned path; the file can
    be opened directly in any browser or sent to anyone as-is."""
    from watch_skill.viewer import generate_viewer as run

    try:
        path = run(video, out_path=out_path)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return f"viewer written: {path}"


@mcp.tool
def watch_batch(sources: list[str], limit: int = 20) -> str:
    """Watch + index a WHOLE SET of videos in one call: a playlist/channel
    URL (auto-expanded), a folder of video files, or an explicit list of
    URLs/paths. Every video lands in the same persistent index, so one
    search_videos/ask_video afterwards spans the entire batch — cross-video
    questions become possible. One failing video never stops the rest."""
    from watch_skill.batch import watch_batch as run

    try:
        result = run(sources, limit=limit)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return result.report()


@mcp.tool
def extract_chapters(video: str) -> str:
    """Segment an already-watched video into titled chapters with start/end
    timestamps (from scene changes + transcript topic shifts). Use for
    navigation, summaries per section, or building a table of contents.
    Deterministic — no extra model calls, answers straight from the index."""
    import json as _json

    from watch_skill.extract import extract_chapters as run

    try:
        chapters = run(video)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _json.dumps([c.to_dict() for c in chapters], ensure_ascii=False, indent=2)


@mcp.tool
def extract_bug_report(video: str) -> str:
    """QA mode: pinpoint WHERE an error appears in a watched screen recording —
    the timestamp, the frame, the exact on-screen error text (OCR), and the
    steps/narration that led up to it. Returns found=false when no error
    signal exists rather than guessing."""
    import json as _json

    from watch_skill.extract import extract_bug_report as run

    try:
        report = run(video)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _json.dumps(report.to_dict(), ensure_ascii=False, indent=2)


@mcp.tool
def analyze_hook(video: str, seconds: float = 15.0) -> str:
    """Creator mode: score the first N seconds of a watched video as a hook —
    attention trigger in the opening line, speech pacing, visual change rate,
    on-screen text — each with an actionable critique plus a combined 0-100
    score and verdict (strong/promising/weak)."""
    import json as _json

    from watch_skill.extract import analyze_hook as run

    try:
        analysis = run(video, window_seconds=seconds)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return _json.dumps(analysis.to_dict(), ensure_ascii=False, indent=2)


@mcp.tool
def library_synthesize(question: str, k_videos: int = 5) -> str:
    """Answer a question from the WHOLE video library at once — use when no
    single video answers it ("what did the meetings decide about X?",
    "which tutorials cover Y and do they agree?"). Retrieves distilled notes
    across every indexed video, drills into real indexed evidence, and
    returns a synthesis where every finding carries a per-video timestamp
    citation. Says plainly when the library does not clearly know. For a
    question about ONE known video, use ask_video instead."""
    from watch_skill.library import library_synthesize as run

    try:
        answer = run(question, k_videos=k_videos)
    except WatchSkillError as exc:
        return _error_payload(exc)
    meta = (
        f"\n---\nconfidence: {answer.confidence} | videos consulted: "
        f"{answer.videos_consulted} | corroborated: {answer.corroborated} | "
        f"cached: {answer.cached} | ~{answer.tokens_saved_estimate:,} tokens saved"
    )
    return answer.text + meta


@mcp.tool
def library_overview() -> str:
    """What the video library knows: how many videos and hours are indexed,
    the note counts (entities/claims/chapters), the entities that recur
    across multiple videos, and the most recent additions. Use it to orient
    before library_synthesize, or when the user asks what has been watched."""
    from watch_skill.library import library_overview as run

    return json.dumps(run(), ensure_ascii=False, indent=2)


@mcp.tool
def check_source(video: str) -> str:
    """Whether an indexed video still matches what its source holds NOW, plus
    every revision recorded for it.

    Call this before treating an older analysis as current — especially for a
    local path, which can be overwritten between sessions. States: `fresh`,
    `stale`, `refresh_required`, `freshness_unknown`. Anything but `fresh`
    means re-watch before answering, or answer about a specific `video_id`
    and say which revision you are describing."""
    from watch_skill.index.store import check_freshness, source_revisions

    try:
        payload = check_freshness(video)
        payload["revisions"] = source_revisions(video)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool
def execution_plan(frames: int = 0, tier: str = "strong") -> str:
    """What a run would send and what it could cost, BEFORE it sends anything.

    Returns the provider, model, payload counts, the exact network actions,
    the estimated maximum spend, and the full effective policy (offline mode,
    egress channels, provider allowlist, ceilings). Use it to answer "will
    this upload my video?" without running anything."""
    from watch_skill.policy import execution_plan as plan

    settings = get_settings()
    provider = (settings.vision_cheap_provider if tier == "cheap"
                else settings.vision_strong_provider)
    model = (settings.vision_cheap_model if tier == "cheap"
             else settings.vision_strong_model)
    return json.dumps(
        plan(phase=f"vision.{tier}", provider=provider, model=model, frames=frames),
        ensure_ascii=False, indent=2,
    )


@mcp.tool
def verify_contract(
    title: str,
    checks: list[dict[str, Any]],
    working_dir: str = ".",
    allowed_origins: list[str] | None = None,
) -> str:
    """Decide whether an agent run actually succeeded, using deterministic
    checks rather than an opinion about a screenshot.

    `checks` is a list of {id, type, required, params}. Types: file_exists,
    file_digest, json_value, json_schema, sqlite_query, http_request,
    command_exit, numeric_invariant, visual_absent. The contract is frozen
    and digested before it runs, so it cannot be widened afterwards.

    Verdicts: `pass` only when every REQUIRED check passed; `fail` when one
    failed; `inconclusive` when one could not run, or when the contract has
    no required check at all — visual evidence alone is never a pass.
    Returns the verdict, the assurance level, what was not established, and
    a run_id whose evidence bundle is hash-bound against tampering."""
    from watch_skill.verify import draft_contract, verify_run

    try:
        contract = draft_contract(title, checks, created_by="mcp").freeze()
        bundle, attestation = verify_run(
            contract, working_dir=working_dir,
            allowed_origins=allowed_origins or [],
        )
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps({
        "run_id": bundle.run_id,
        "verdict": bundle.verdict,
        "assurance": bundle.assurance,
        "contract_digest": bundle.contract_digest,
        "limitations": bundle.limitations,
        "signature_status": attestation.signature_status,
        "checks": [
            {"id": r.check_id, "type": r.type, "required": r.required,
             "status": r.status.value, "expected": r.expected,
             "observed": r.observed, "summary": r.summary}
            for r in bundle.check_results
        ],
    }, ensure_ascii=False, indent=2, default=str)


@mcp.tool
def get_evidence(run_id: str) -> str:
    """Read back a verification run's evidence bundle and attestation.

    The attestation is re-checked against the bundle on the way out, so an
    edited evidence file raises instead of being reported as a verified
    pass."""
    from watch_skill.verify import load_run

    try:
        contract, bundle, attestation = load_run(run_id)
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps({
        "contract": contract.model_dump(mode="json"),
        "evidence": bundle.model_dump(mode="json"),
        "attestation": attestation.model_dump(mode="json"),
    }, ensure_ascii=False, indent=2, default=str)


@mcp.tool
def start_live_watch(
    target: str,
    kind: str = "file_replay",
    profile: str = "local-lite",
    fps: float = 2.0,
    buffer_seconds: float = 120.0,
) -> str:
    """Start WATCHING SOMETHING AS IT HAPPENS — a stream, or a local file
    replayed at real time. Events (scene changes, on-screen text changes)
    are produced while the source is still playing, not after it ends.

    Returns a session_id. Poll observe_live with the returned cursor to see
    what happens; ask_live answers questions about it; stop_live_watch ends
    it and can turn it into permanent searchable memory.

    kind: file_replay | stream. Others report honestly that this machine or
    build cannot record them — check capture_capabilities first."""
    from watch_skill.live import start_live

    try:
        session = start_live(target, kind=kind, profile=profile, fps=fps,
                             buffer_seconds=buffer_seconds)
    except WatchSkillError as exc:
        return _error_payload(exc)
    payload = session.to_public()
    payload["next"] = f"observe_live('{session.session_id}')"
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool
def observe_live(
    session_id: str,
    cursor: str = "",
    limit: int = 50,
    wait_seconds: float = 0.0,
    types: list[str] | None = None,
) -> str:
    """Read what has happened in a live session since your last cursor.

    Pass the `next_cursor` from the previous call to get only new events —
    repeating a cursor returns the same events, so a retry never loses or
    doubles anything. wait_seconds long-polls instead of returning empty."""
    from watch_skill.live import observe

    try:
        return json.dumps(
            observe(session_id, cursor=cursor or None, limit=limit,
                    timeout_seconds=wait_seconds, types=types),
            ensure_ascii=False, indent=2,
        )
    except WatchSkillError as exc:
        return _error_payload(exc)


@mcp.tool
def ask_live(
    session_id: str,
    question: str,
    scope: str = "recent",
    seconds: float = 30.0,
) -> str:
    """Ask what is happening right now, or what happened earlier in a live
    session. Answers come with the media timestamps they came from.

    scope: now | recent (last `seconds`) | session. When nothing observed
    supports an answer it says so rather than inventing one."""
    from watch_skill.live import ask_live as _ask

    try:
        return json.dumps(_ask(session_id, question, scope=scope, seconds=seconds),
                          ensure_ascii=False, indent=2)
    except WatchSkillError as exc:
        return _error_payload(exc)


@mcp.tool
def get_live_status(session_id: str = "") -> str:
    """How a live session is doing: state, frames captured vs analyzed,
    dropped frames, queue depths, buffer size. Omit session_id to list every
    live session on this machine."""
    from watch_skill.live import list_live, status

    try:
        if not session_id:
            return json.dumps({"sessions": list_live()}, ensure_ascii=False, indent=2)
        return json.dumps(status(session_id), ensure_ascii=False, indent=2)
    except WatchSkillError as exc:
        return _error_payload(exc)


@mcp.tool
def stop_live_watch(session_id: str, finalize: bool = True) -> str:
    """Stop a live session. With finalize=true the pinned evidence becomes an
    ordinary indexed video — ask_video and search_videos work on it
    afterwards, with no reprocessing of the media."""
    from watch_skill.live import stop_live
    from watch_skill.live.finalize import finalize_session

    try:
        payload = stop_live(session_id)
        if finalize:
            video_id = finalize_session(session_id)
            payload["finalized_video_id"] = video_id
            payload["next"] = f"ask_video('{video_id}', <your question>)"
    except WatchSkillError as exc:
        return _error_payload(exc)
    return json.dumps(payload, ensure_ascii=False, indent=2)


@mcp.tool
def capture_capabilities() -> str:
    """What this machine can actually record, and how each answer was
    established. Check before attempting screen/window/camera capture —
    nothing here is reported available on the strength of a code path
    existing."""
    from watch_skill.live import capability_matrix

    return json.dumps(capability_matrix(), ensure_ascii=False, indent=2)


@mcp.tool
def doctor() -> str:
    """Run this when ANY other tool fails with a dependency/download error, or
    on first use. Checks AND self-heals: installs missing ffmpeg/yt-dlp,
    updates a stale yt-dlp, verifies disk space, GPU, and API keys. Each
    failing check includes a `fix` you can act on."""
    from watch_skill.health.doctor import run_doctor

    return json.dumps(run_doctor(fix=True).to_dict(), indent=2)


def main(http: bool = False, host: str = "127.0.0.1", port: int = 8747) -> None:
    """Entry point used by `watch-skill serve`."""
    prepend_bin_dir_to_path()
    if http:
        mcp.run(transport="http", host=host, port=port)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
