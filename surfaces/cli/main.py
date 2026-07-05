"""Watch Skill CLI entry point.

Milestone 0 ships `doctor` and `version`; watch/ask/loop/serve arrive with
their core modules. Progress goes to stderr, results to stdout, so agents can
pipe cleanly. `--json` flags emit machine-readable output.
"""
from __future__ import annotations

import json
import sys

import typer
from rich.console import Console

app = typer.Typer(
    name="watch-skill",
    help="Give any agent a video input: watch, index, ask, and iterate.",
    no_args_is_help=True,
    add_completion=False,
)

_console = Console(stderr=True)

_STATUS_STYLE = {"ok": "green", "warn": "yellow", "fail": "red"}


def _render_report(report) -> None:
    from rich.table import Table

    table = Table(title="watch-skill doctor")
    table.add_column("check")
    table.add_column("status")
    table.add_column("detail", overflow="fold")
    for check in report.checks:
        style = _STATUS_STYLE[check.status]
        detail = check.message
        if check.fix_applied:
            detail += f" (auto-fixed: {check.fix_applied})"
        table.add_row(check.name, f"[{style}]{check.status}[/{style}]", detail)
    _console.print(table)


@app.command()
def doctor(
    fix: bool = typer.Option(True, "--fix/--no-fix", help="Auto-remediate fixable issues."),
    as_json: bool = typer.Option(False, "--json", help="Emit machine-readable JSON to stdout."),
) -> None:
    """Check (and self-heal) dependencies: ffmpeg, yt-dlp, deno, disk, GPU, API keys."""
    from watch_skill.health.doctor import run_doctor

    report = run_doctor(fix=fix)
    if as_json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        _render_report(report)
    if not report.ok:
        raise typer.Exit(code=1) from None


@app.command()
def watch(
    source: str = typer.Argument(..., help="URL, direct media URL, manifest, or local path."),
    question: str | None = typer.Argument(None, help="Optional question (echoed in output)."),
    start: str | None = typer.Option(None, "--start", help="Range start (SS, MM:SS, HH:MM:SS)."),
    end: str | None = typer.Option(None, "--end", help="Range end (SS, MM:SS, HH:MM:SS)."),
    max_frames: int | None = typer.Option(None, "--max-frames", help="Override the frame cap."),
    resolution: int | None = typer.Option(None, "--resolution", help="Frame width px (default 512)."),
    timestamps: str | None = typer.Option(
        None, "--timestamps", help="Comma-separated absolute times to pin frames at."
    ),
    transcript_only: bool = typer.Option(
        False, "--transcript-only", help="Skip frames; captions-first fast path."
    ),
    no_ocr: bool = typer.Option(False, "--no-ocr", help="Skip the OCR pass."),
    no_whisper: bool = typer.Option(
        False, "--no-whisper", help="Disable local whisper fallback (captions only)."
    ),
    cloud_stt: bool = typer.Option(
        False, "--cloud-stt", help="OPT-IN: allow cloud STT for extracted audio."
    ),
    whisper_model: str | None = typer.Option(
        None, "--whisper-model", help="faster-whisper size (tiny..large-v3, default auto)."
    ),
    diarize: bool = typer.Option(
        False, "--diarize", help="Label transcript by speaker (diarize extra + HF token)."
    ),
    duration: float | None = typer.Option(
        None, "--duration", help="Bound live-stream capture to N seconds."
    ),
    out_dir: str | None = typer.Option(None, "--out-dir", help="Working directory."),
    no_cache: bool = typer.Option(False, "--no-cache", help="Bypass the download cache."),
    index: bool = typer.Option(
        True, "--index/--no-index", help="Persist to the searchable index (ask/search later)."
    ),
) -> None:
    """Watch a video: acquire -> scenes -> frames -> OCR -> transcript -> report."""
    from pathlib import Path

    from watch_skill.errors import WatchSkillError
    from watch_skill.perceive.budget import parse_time
    from watch_skill.report import render_report
    from watch_skill.watch import watch as run_watch

    cues = None
    if timestamps:
        cues = [t for t in (parse_time(tok) for tok in timestamps.split(",") if tok.strip()) if t is not None]
    try:
        result = run_watch(
            source,
            start_seconds=parse_time(start),
            end_seconds=parse_time(end),
            max_frames=max_frames,
            frame_width=resolution,
            cue_timestamps=cues,
            transcript_only=transcript_only,
            run_ocr=False if no_ocr else None,
            allow_local_whisper=False if no_whisper else None,
            allow_cloud_stt=True if cloud_stt else None,
            whisper_model=whisper_model,
            diarize=True if diarize else None,
            duration_cap=duration,
            out_dir=Path(out_dir) if out_dir else None,
            use_cache=not no_cache,
        )
    except WatchSkillError as exc:
        _console.print(f"[red]error:[/red] {exc}")
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    if index and result.perception is not None:
        from watch_skill.index import index_watch_result

        video_id = index_watch_result(result)
        print(f"> **Indexed:** video_id `{video_id}` — follow up with `watch-skill ask {video_id} ...`\n")
    if question:
        print(f"> **Question:** {question}\n")
    print(render_report(result))


@app.command()
def serve(
    http: bool = typer.Option(False, "--http", help="Streamable HTTP instead of stdio."),
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8747, "--port"),
) -> None:
    """Run the MCP server (stdio default; --http for streamable HTTP)."""
    from surfaces.mcp_server.server import main as mcp_main

    mcp_main(http=http, host=host, port=port)


@app.command()
def api(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8748, "--port"),
) -> None:
    """Run the REST API (FastAPI; OpenAPI spec at /openapi.json)."""
    from watch_skill.errors import WatchSkillError

    from surfaces.api import serve as api_serve

    try:
        api_serve(host=host, port=port)
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None


@app.command()
def ask(
    video: str = typer.Argument(..., help="video_id or the original source URL/path."),
    question: str = typer.Argument(...),
    max_frames: int = typer.Option(6, "--max-frames"),
    frames: bool = typer.Option(False, "--frames", help="Always list evidence frame paths."),
    no_verify: bool = typer.Option(False, "--no-verify", help="Skip the model verify pass."),
    no_cache: bool = typer.Option(False, "--no-cache", help="Bypass the semantic answer cache."),
) -> None:
    """Ask an already-indexed video a question (self-healing answer engine)."""
    from watch_skill.answer import answer_question
    from watch_skill.errors import WatchSkillError

    try:
        answer = answer_question(
            video, question,
            include_frames=True if frames else None,
            verify=False if no_verify else None,
            use_cache=not no_cache,
        )
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    print(answer.text)
    flags = [f"confidence: {answer.confidence:.2f}"]
    if answer.cached:
        flags.append("cached: true")
    if answer.verified:
        flags.append("verified: true")
    if answer.escalations_used:
        flags.append(f"escalations: {', '.join(answer.escalations_used)}")
    if answer.budget_stopped:
        flags.append("stopped at token budget")
    print(f"\n({' | '.join(flags)})")
    if answer.frames:
        print("Frames:")
        for path in answer.frames[:max_frames]:
            print(f"- `{path}`")
    print(f"~{answer.tokens_saved_estimate} tokens saved vs raw-frame injection")


@app.command()
def forget(
    video: str = typer.Argument(..., help="video_id or original source to remove from the index."),
) -> None:
    """Forget one video: its index rows, cached answers, and frames dir."""
    from watch_skill.errors import WatchSkillError
    from watch_skill.index.store import forget_video

    try:
        row = forget_video(video)
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    print(f"forgotten: {row['id']} — {row['title'] or row['source']}")


@app.command()
def stats() -> None:
    """Lifetime token savings and answer counts."""
    from watch_skill.answer.cache import lifetime_stats

    data = lifetime_stats()
    print(f"answers served : {data['answers_count']}")
    print(f"tokens saved   : ~{data['tokens_saved_total']:,} vs raw-frame injection")


@app.command("list")
def list_cmd() -> None:
    """List indexed videos."""
    from watch_skill.index import list_videos

    for row in list_videos():
        print(f"{row['id']}  {row['duration_seconds']:8.1f}s  {row['title'] or row['source']}")


@app.command()
def search(query: str = typer.Argument(...)) -> None:
    """Search across every indexed video."""
    from watch_skill.index import search_videos
    from watch_skill.perceive.budget import format_time

    for group in search_videos(query):
        video = group["video"] or {}
        print(f"\n## {video.get('title') or video.get('source')} ({video.get('id')})")
        for hit in group["hits"]:
            stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
            print(f"- [{stamp}] ({hit['kind']}, {hit['score']:.2f}) {hit['text']}")


loop_app = typer.Typer(help="THE LOOP: capture -> critique -> fix -> re-capture.")
app.add_typer(loop_app, name="loop")


def _print_loop_state(state) -> None:
    from watch_skill.loop.reportfmt import format_loop_state

    print(format_loop_state(state))


@app.command()
def capture(
    target: str = typer.Argument(..., help="URL, screen:, window:<title>, or video file."),
    duration: float = typer.Option(10.0, "--duration", help="Recording length in seconds."),
    script_json: str | None = typer.Option(
        None, "--script", help="Interaction script as JSON list of steps."
    ),
    out_dir: str | None = typer.Option(None, "--out-dir"),
) -> None:
    """Record a URL session / the screen / a window to video."""
    import tempfile
    from pathlib import Path

    from watch_skill.errors import WatchSkillError
    from watch_skill.loop import capture as run_capture

    try:
        script = json.loads(script_json) if script_json else None
        dest = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="watch-skill-capture-"))
        result = run_capture(target, dest, script=script, duration_seconds=duration)
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    print(f"captured {result.kind}: {result.video_path}")


@loop_app.command("start")
def loop_start_cmd(
    target: str = typer.Argument(...),
    pass_criteria: str = typer.Argument(..., help="Natural-language pass criteria."),
    script_json: str | None = typer.Option(None, "--script"),
    max_iterations: int = typer.Option(5, "--max-iterations"),
    duration: float = typer.Option(8.0, "--duration"),
) -> None:
    """Capture + critique the first iteration; prints loop_id and issues."""
    from watch_skill.errors import WatchSkillError
    from watch_skill.loop import loop_start

    try:
        script = json.loads(script_json) if script_json else None
        state = loop_start(
            target, pass_criteria, script=script,
            max_iterations=max_iterations, duration_seconds=duration,
        )
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    _print_loop_state(state)


@loop_app.command("iterate")
def loop_iterate_cmd(loop_id: str = typer.Argument(...)) -> None:
    """Re-capture + re-critique after you applied fixes; diffs vs previous."""
    from watch_skill.errors import WatchSkillError
    from watch_skill.loop import loop_iterate

    try:
        state = loop_iterate(loop_id)
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    _print_loop_state(state)


@loop_app.command("status")
def loop_status_cmd(loop_id: str = typer.Argument(...)) -> None:
    """Show a loop's persisted state."""
    from watch_skill.errors import WatchSkillError
    from watch_skill.loop import loop_status

    try:
        state = loop_status(loop_id)
    except WatchSkillError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    _print_loop_state(state)


@app.command()
def setup(
    yes: bool = typer.Option(False, "--yes", "-y", help="Configure all detected agents without prompting."),
    only: str | None = typer.Option(None, "--only", help="Comma list of agent keys (e.g. cursor,codex)."),
) -> None:
    """Detect installed AI agents and write the MCP config into each one.

    Backs up any existing config file before touching it. From clone to a
    working /watch in under two minutes.
    """
    from watch_skill.health.agents_setup import configure_agent, detect_agents

    wanted = {k.strip() for k in only.split(",")} if only else None
    targets = [t for t in detect_agents() if t.detected]
    if wanted is not None:
        targets = [t for t in targets if t.key in wanted]
    if not targets:
        print("No supported agents detected on this machine.")
        print("Manual configs for every agent: docs/agents/README.md")
        raise typer.Exit(code=0)

    _console.print("[bold]Detected agents:[/bold]")
    for t in targets:
        state = "already configured" if t.configured else "will configure"
        _console.print(f"  - {t.label}  ({state}; {t.config_path})")
    todo = [t for t in targets if not t.configured]
    if not todo:
        print("Everything already configured. Restart the agents to pick it up.")
        raise typer.Exit(code=0)
    if not yes and not typer.confirm(f"Write MCP config into {len(todo)} agent(s)?", default=True):
        raise typer.Exit(code=0)
    for t in todo:
        changed, message = configure_agent(t)
        _console.print(("[green]+[/green] " if changed else "[yellow]=[/yellow] ") + message)
    print("\nDone. Restart each agent, then try: \"watch this video ...\" in its chat.")


@app.command()
def clean(
    cache: bool = typer.Option(False, "--cache", help="Evict the download cache to its size cap."),
    all_cache: bool = typer.Option(False, "--all-cache", help="Empty the download cache entirely."),
    loops: bool = typer.Option(False, "--loops", help="Keep only the 10 most recent loops."),
    keep_loops: int = typer.Option(10, "--keep-loops", help="How many recent loops to keep."),
    orphans: bool = typer.Option(False, "--orphans", help="Remove frame dirs for de-indexed videos."),
    cache_answers: bool = typer.Option(
        False, "--cache-answers", help="Clear the semantic answer cache."
    ),
    everything: bool = typer.Option(False, "--all", help="Cache-to-cap + loops + orphans."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report only; delete nothing."),
) -> None:
    """Reclaim disk: bounded cache, bounded loop archives, orphaned frames."""
    from watch_skill.health.clean import clean_cache, clean_loops, clean_orphan_frames

    if everything:
        cache = loops = orphans = True
    if cache_answers:
        from watch_skill.answer.cache import clear as clear_answers

        removed = 0 if dry_run else clear_answers()
        print(f"answer cache: {'would clear' if dry_run else 'cleared'} ({removed} rows)")
        if not (cache or all_cache or loops or orphans):
            return
    if not (cache or all_cache or loops or orphans):
        print(
            "Nothing selected. Use --all, or any of "
            "--cache/--all-cache/--loops/--orphans/--cache-answers."
        )
        raise typer.Exit(code=1)
    total = 0
    for label, enabled, fn in (
        ("cache", cache or all_cache, lambda: clean_cache(all_entries=all_cache, dry_run=dry_run)),
        ("loops", loops, lambda: clean_loops(keep=keep_loops, dry_run=dry_run)),
        ("orphan frames", orphans, lambda: clean_orphan_frames(dry_run=dry_run)),
    ):
        if not enabled:
            continue
        report = fn()
        total += report.freed_bytes
        verb = "would free" if dry_run else "freed"
        print(f"{label}: {verb} {report.freed_bytes / 1024**2:.1f} MiB "
              f"({len(report.removed)} removed, {len(report.kept)} kept)")
    print(f"total {'reclaimable' if dry_run else 'reclaimed'}: {total / 1024**2:.1f} MiB")


lessons_app = typer.Typer(help="The local lessons store: learn from reported mistakes.")
app.add_typer(lessons_app, name="lessons")


@lessons_app.command("add")
def lessons_add(
    video: str = typer.Argument(..., help="video_id or original source."),
    question: str = typer.Argument(...),
    wrong: str = typer.Argument(..., help="The wrong answer that was given."),
    correction: str = typer.Argument(..., help="What the correct answer actually is."),
    session: str | None = typer.Option(None, "--session", help="Session id to group under."),
    no_reask: bool = typer.Option(False, "--no-reask", help="Skip the immediate re-ask check."),
) -> None:
    """Report a wrong answer + its correction; the system learns from it."""
    from watch_skill.lessons import report_mistake

    outcome = report_mistake(
        video, question, wrong, correction,
        agent="cli", session_id=session, reask=not no_reask,
    )
    print(json.dumps(outcome, ensure_ascii=False, indent=2))


@lessons_app.command("list")
def lessons_list(
    session: str | None = typer.Option(None, "--session"),
    limit: int = typer.Option(20, "--limit"),
) -> None:
    """List stored lessons (newest first)."""
    from watch_skill.lessons import list_lessons

    rows = list_lessons(session_id=session, limit=limit)
    if not rows:
        print("No lessons stored yet — report one with `watch-skill lessons add`.")
        return
    for row in rows:
        mark = "✓" if row["validated"] else " "
        print(f"[{mark}] #{row['id']} {row['error_class']:<15} ({row['content_type']}) "
              f"{row['guidance'][:90]}")


@lessons_app.command("rm")
def lessons_rm(
    ids: list[int] = typer.Argument(None, help="Lesson ids to remove."),
    session: str | None = typer.Option(None, "--session", help="Remove a whole session."),
) -> None:
    """Remove lessons by id or by session."""
    from watch_skill.lessons import remove_lessons

    removed = remove_lessons(ids=list(ids) if ids else None, session_id=session)
    print(f"removed {removed} lesson(s)")


@lessons_app.command("export-evals")
def lessons_export_evals() -> None:
    """Convert every lesson into a replayable eval case."""
    from watch_skill.lessons import export_evals

    print(f"eval cases written to {export_evals()}")


evals_app = typer.Typer(help="Replay lesson-derived evals against the current system.")
app.add_typer(evals_app, name="evals")


@evals_app.command("run")
def evals_run() -> None:
    """Replay the eval suite; pass-rate rising over time = it learns."""
    from watch_skill.lessons import run_evals

    result = run_evals()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["total"] and result["pass_rate"] is not None:
        print(f"\npass rate: {result['pass_rate']:.0%} "
              f"({result['passed']}/{result['total']}, {result['skipped']} skipped)")


profiles_app = typer.Typer(help="Adaptive per-content-type profiles learned from lessons.")
app.add_typer(profiles_app, name="profiles")


@profiles_app.command("show")
def profiles_show() -> None:
    """Show the active adaptive profiles (data, not code)."""
    from watch_skill.lessons import show_profiles

    rows = show_profiles()
    if not rows:
        print("No profiles earned yet — they aggregate from lesson statistics.")
        return
    print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))


@profiles_app.command("reset")
def profiles_reset() -> None:
    """Drop all adaptive profiles (lessons stay)."""
    from watch_skill.lessons import reset_profiles

    print(f"reset {reset_profiles()} profile(s)")


@app.command()
def version() -> None:
    """Print the Watch Skill version."""
    from watch_skill import __version__

    print(__version__)


if __name__ == "__main__":
    sys.exit(app())
