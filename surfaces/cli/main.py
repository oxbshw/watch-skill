"""AgentVision CLI entry point.

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
    name="agentvision",
    help="Give any agent a video input: watch, index, ask, and iterate.",
    no_args_is_help=True,
    add_completion=False,
)

_console = Console(stderr=True)

_STATUS_STYLE = {"ok": "green", "warn": "yellow", "fail": "red"}


def _render_report(report) -> None:
    from rich.table import Table

    table = Table(title="agentvision doctor")
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
    from agentvision.health.doctor import run_doctor

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

    from agentvision.errors import AgentVisionError
    from agentvision.perceive.budget import parse_time
    from agentvision.report import render_report
    from agentvision.watch import watch as run_watch

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
    except AgentVisionError as exc:
        _console.print(f"[red]error:[/red] {exc}")
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    if index and result.perception is not None:
        from agentvision.index import index_watch_result

        video_id = index_watch_result(result)
        print(f"> **Indexed:** video_id `{video_id}` — follow up with `agentvision ask {video_id} ...`\n")
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
    from agentvision.errors import AgentVisionError

    from surfaces.api import serve as api_serve

    try:
        api_serve(host=host, port=port)
    except AgentVisionError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None


@app.command()
def ask(
    video: str = typer.Argument(..., help="video_id or the original source URL/path."),
    question: str = typer.Argument(...),
    max_frames: int = typer.Option(6, "--max-frames"),
) -> None:
    """Ask an already-indexed video a question (retrieval, no re-processing)."""
    from agentvision.errors import AgentVisionError
    from agentvision.index import ask_video
    from agentvision.perceive.budget import format_time

    try:
        result = ask_video(video, question, max_frames=max_frames)
    except AgentVisionError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    print(f"# Evidence for: {question}\n")
    for hit in result["hits"]:
        stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
        print(f"- [{stamp}] ({hit['kind']}, score {hit['score']:.2f}) {hit['text']}")
    print("\nFrames:")
    for frame in result["frames"]:
        print(f"- t={format_time(frame['timestamp'])}: `{frame['frame_path']}`")


@app.command("list")
def list_cmd() -> None:
    """List indexed videos."""
    from agentvision.index import list_videos

    for row in list_videos():
        print(f"{row['id']}  {row['duration_seconds']:8.1f}s  {row['title'] or row['source']}")


@app.command()
def search(query: str = typer.Argument(...)) -> None:
    """Search across every indexed video."""
    from agentvision.index import search_videos
    from agentvision.perceive.budget import format_time

    for group in search_videos(query):
        video = group["video"] or {}
        print(f"\n## {video.get('title') or video.get('source')} ({video.get('id')})")
        for hit in group["hits"]:
            stamp = format_time(hit["timestamp"]) if hit["timestamp"] is not None else "--:--"
            print(f"- [{stamp}] ({hit['kind']}, {hit['score']:.2f}) {hit['text']}")


loop_app = typer.Typer(help="THE LOOP: capture -> critique -> fix -> re-capture.")
app.add_typer(loop_app, name="loop")


def _print_loop_state(state) -> None:
    from agentvision.loop.reportfmt import format_loop_state

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

    from agentvision.errors import AgentVisionError
    from agentvision.loop import capture as run_capture

    try:
        script = json.loads(script_json) if script_json else None
        dest = Path(out_dir) if out_dir else Path(tempfile.mkdtemp(prefix="agentvision-capture-"))
        result = run_capture(target, dest, script=script, duration_seconds=duration)
    except AgentVisionError as exc:
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
    from agentvision.errors import AgentVisionError
    from agentvision.loop import loop_start

    try:
        script = json.loads(script_json) if script_json else None
        state = loop_start(
            target, pass_criteria, script=script,
            max_iterations=max_iterations, duration_seconds=duration,
        )
    except AgentVisionError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    _print_loop_state(state)


@loop_app.command("iterate")
def loop_iterate_cmd(loop_id: str = typer.Argument(...)) -> None:
    """Re-capture + re-critique after you applied fixes; diffs vs previous."""
    from agentvision.errors import AgentVisionError
    from agentvision.loop import loop_iterate

    try:
        state = loop_iterate(loop_id)
    except AgentVisionError as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1) from None
    _print_loop_state(state)


@loop_app.command("status")
def loop_status_cmd(loop_id: str = typer.Argument(...)) -> None:
    """Show a loop's persisted state."""
    from agentvision.errors import AgentVisionError
    from agentvision.loop import loop_status

    try:
        state = loop_status(loop_id)
    except AgentVisionError as exc:
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
    from agentvision.health.agents_setup import configure_agent, detect_agents

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
    everything: bool = typer.Option(False, "--all", help="Cache-to-cap + loops + orphans."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report only; delete nothing."),
) -> None:
    """Reclaim disk: bounded cache, bounded loop archives, orphaned frames."""
    from agentvision.health.clean import clean_cache, clean_loops, clean_orphan_frames

    if everything:
        cache = loops = orphans = True
    if not (cache or all_cache or loops or orphans):
        print("Nothing selected. Use --all, or any of --cache/--all-cache/--loops/--orphans.")
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


@app.command()
def version() -> None:
    """Print the AgentVision version."""
    from agentvision import __version__

    print(__version__)


if __name__ == "__main__":
    sys.exit(app())
