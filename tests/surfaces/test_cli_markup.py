"""What the CLI prints says what it means, brackets included.

`watch-skill doctor` on a base install reports which optional tiers are missing
and how to add them. The instruction is
``pip install "watch-skill[perceive, index, mcp]"`` -- and the terminal showed
``pip install "watch-skill"``, because Rich reads ``[...]`` as a style tag and
drops what it cannot resolve. The command left standing reinstalls what the
reader already has, so following it exactly changes nothing and the reader is
told the same thing again.

Nothing looked broken from the inside: `--json` carried the whole string, and
the tests read the JSON. This reads the rendering, which is the surface a
person actually gets, and covers the two other places non-authored text meets
the markup parser -- an error's own message, and a model's own words.
"""
from __future__ import annotations

import io

from rich.console import Console

from watch_skill.health.doctor import CheckResult, DoctorReport
from watch_skill.surfaces.cli import main as cli


def _rendered(report: DoctorReport) -> str:
    """The doctor table as a terminal wide enough not to wrap it."""
    buffer = io.StringIO()
    console = Console(file=buffer, width=200, no_color=True, highlight=False)
    original = cli._console
    cli._console = console
    try:
        cli._render_report(report)
    finally:
        cli._console = original
    return buffer.getvalue()


def _report(*checks: CheckResult) -> DoctorReport:
    return DoctorReport(checks=list(checks))


def test_the_extras_survive_the_terminal() -> None:
    """The fix names the extras, or it is not a fix."""
    text = _rendered(_report(CheckResult(
        "features", "warn",
        'not installed — perceive: scene detection. Add with: '
        'pip install "watch-skill[perceive, index, mcp]"',
    )))
    assert "watch-skill[perceive, index, mcp]" in text, (
        "the extras were parsed as markup and dropped, leaving a command that "
        f"reinstalls the base package: {text!r}")


def test_a_status_is_still_coloured() -> None:
    """Escaping the detail must not disarm the markup this file does author."""
    buffer = io.StringIO()
    console = Console(file=buffer, width=200, force_terminal=True, highlight=False)
    original = cli._console
    cli._console = console
    try:
        cli._render_report(_report(CheckResult("ffmpeg", "fail", "not found")))
    finally:
        cli._console = original
    assert "\x1b[" in buffer.getvalue(), "the status column lost its styling"


def test_a_fix_applied_note_is_not_parsed_either() -> None:
    text = _rendered(_report(CheckResult(
        "ocr-models", "ok", "cached", fix_applied='downloaded [latin]')))
    assert "[latin]" in text


def test_plain_leaves_ordinary_text_alone() -> None:
    """Escaping is not rewriting: text without brackets comes back unchanged."""
    assert cli._plain("ffmpeg 9.0 at C:/tools/ffmpeg.exe") == (
        "ffmpeg 9.0 at C:/tools/ffmpeg.exe")


def test_a_model_s_own_words_decide_nothing_about_the_terminal() -> None:
    """Observed content is data. It does not get to format the screen."""
    assert cli._plain("a slide reading [bold red]DELETED[/bold red]") != (
        "a slide reading [bold red]DELETED[/bold red]")
    buffer = io.StringIO()
    Console(file=buffer, width=200, force_terminal=True, highlight=False).print(
        cli._plain("a slide reading [bold red]DELETED[/bold red]"))
    assert "DELETED" in buffer.getvalue()
    assert "\x1b[1;31m" not in buffer.getvalue(), (
        "a model's output styled the terminal")
