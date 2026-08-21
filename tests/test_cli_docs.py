"""Documented CLI invocations must match the CLI that exists.

The README told readers to run `watch-skill loop start --source ... --criteria
...`. Neither option exists -- `loop start` takes two positional arguments --
so the flagship browser-verification example in the project's front door could
never have worked. Two skill files pointed at `watch-skill moment`, a command
that has never existed, and skills are executed by agents rather than read by
people who might notice.

The link checker could not catch any of this, because every link resolved. The
commands were real; their options were not.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from watch_skill.surfaces.cli.main import app

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"node_modules", ".venv", "build", "dist", ".git"}

# `watch-skill <sub> [<sub2>] ...` -- the CLI nests at most two levels deep.
INVOCATION = re.compile(r"watch-skill\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?(.*)")
FLAG = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]+)")

_runner = CliRunner()
_help_cache: dict[tuple[str, ...], str] = {}


def _help(parts: tuple[str, ...]) -> str:
    if parts not in _help_cache:
        result = _runner.invoke(app, [*parts, "--help"])
        _help_cache[parts] = result.output if result.exit_code == 0 else ""
    return _help_cache[parts]


def _documents() -> list[Path]:
    return sorted(
        p for p in ROOT.rglob("*.md")
        if not SKIP_DIRS & set(p.relative_to(ROOT).parts)
    )


def _invocations(text: str) -> list[str]:
    """Every `watch-skill ...` command line inside a fenced code block.

    Fenced blocks only. Prose legitimately begins a sentence with the product
    name -- "watch-skill does not compete with browser agents" is English, not
    a command, and reading it as one produces a false failure.
    """
    joined = re.sub(r"\\\s*\n\s*", " ", text)
    found, in_fence = [], False
    for raw in joined.splitlines():
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            continue
        line = raw.strip().lstrip("$").strip()
        line = line.removeprefix("uv run ").removeprefix("uvx ")
        if line.startswith("watch-skill "):
            found.append(line)
    return found


@pytest.mark.parametrize("doc", _documents(), ids=lambda p: p.relative_to(ROOT).as_posix())
def test_documented_cli_options_exist(doc: Path) -> None:
    problems: list[str] = []
    for line in _invocations(doc.read_text(encoding="utf-8", errors="replace")):
        match = INVOCATION.match(line)
        if not match:
            continue
        first, second, rest = match.group(1), match.group(2), match.group(3) or ""
        flags = set(FLAG.findall(rest))

        # Prefer the two-word form when it is a real subcommand.
        parts: tuple[str, ...] = (first,)
        if second and _help((first, second)):
            parts = (first, second)
        text = _help(parts)
        if not text:
            problems.append(f"`{line[:70]}` -> no such command: {' '.join(parts)}")
            continue
        # Options of the parent are not repeated in a subcommand's help.
        parent = _help((first,)) if len(parts) == 2 else ""
        missing = sorted(f for f in flags if f not in text and f not in parent)
        if missing:
            problems.append(f"`{line[:70]}` -> unknown {missing}")

    assert not problems, "\n".join(problems)
