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
from rich.table import Table

from agentvision import __version__
from agentvision.health.doctor import DoctorReport, run_doctor

app = typer.Typer(
    name="agentvision",
    help="Give any agent a video input: watch, index, ask, and iterate.",
    no_args_is_help=True,
    add_completion=False,
)

_console = Console(stderr=True)

_STATUS_STYLE = {"ok": "green", "warn": "yellow", "fail": "red"}


def _render_report(report: DoctorReport) -> None:
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
    """Check (and self-heal) dependencies: ffmpeg, yt-dlp, disk, GPU, API keys."""
    report = run_doctor(fix=fix)
    if as_json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        _render_report(report)
    if not report.ok:
        raise typer.Exit(code=1)


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
    duration: float | None = typer.Option(
        None, "--duration", help="Bound live-stream capture to N seconds."
    ),
    out_dir: str | None = typer.Option(None, "--out-dir", help="Working directory."),
    no_cache: bool = typer.Option(False, "--no-cache", help="Bypass the download cache."),
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
            duration_cap=duration,
            out_dir=Path(out_dir) if out_dir else None,
            use_cache=not no_cache,
        )
    except AgentVisionError as exc:
        _console.print(f"[red]error:[/red] {exc}")
        print(json.dumps(exc.to_dict(), indent=2))
        raise typer.Exit(code=1)
    if question:
        print(f"> **Question:** {question}\n")
    print(render_report(result))


@app.command()
def version() -> None:
    """Print the AgentVision version."""
    print(__version__)


if __name__ == "__main__":
    sys.exit(app())
