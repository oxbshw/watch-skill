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
def version() -> None:
    """Print the AgentVision version."""
    print(__version__)


if __name__ == "__main__":
    sys.exit(app())
