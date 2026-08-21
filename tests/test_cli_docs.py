"""Documented CLI invocations must match the CLI that exists.

The README told readers to run `watch-skill loop start --source ... --criteria
...`. Neither option exists -- `loop start` takes two positional arguments --
so the flagship browser-verification example in the project's front door could
never have worked. Three skill files pointed at `watch-skill moment`, a command
that has never existed, and skills are executed by agents rather than read by
people who might notice.

The link checker could not catch any of this, because every link resolved. The
commands were real; their options were not.

Options are read from the command objects rather than from `--help` output.
Rendered help wraps to the terminal width, so a first version of this test
matched fine on a wide local terminal and failed on all four CI runners at
eighty columns -- checking a presentation layer for something that is data.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import typer.main

from watch_skill.surfaces.cli.main import app

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"node_modules", ".venv", "build", "dist", ".git"}

# `watch-skill <sub> [<sub2>] ...` -- the CLI nests at most two levels deep.
INVOCATION = re.compile(r"watch-skill\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?(.*)")
FLAG = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]+)")

_root = typer.main.get_command(app)


def _lookup(parts: tuple[str, ...]):
    """The command object for `watch-skill <parts>`, or None."""
    node = _root
    for part in parts:
        commands = getattr(node, "commands", None)
        if not commands or part not in commands:
            return None
        node = commands[part]
    return node


def _options(command) -> set[str]:
    """Every long option the command accepts, including inherited ones."""
    return {opt for param in command.params for opt in param.opts
            if opt.startswith("--")} | {"--help"}


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

        parts: tuple[str, ...] = (first,)
        if second and _lookup((first, second)) is not None:
            parts = (first, second)
        command = _lookup(parts)
        if command is None:
            problems.append(f"`{line[:70]}` -> no such command: {' '.join(parts)}")
            continue

        allowed = _options(command)
        if len(parts) == 2:
            parent = _lookup((first,))
            if parent is not None:
                allowed |= _options(parent)
        allowed |= _options(_root)

        missing = sorted(f for f in FLAG.findall(rest) if f not in allowed)
        if missing:
            problems.append(f"`{line[:70]}` -> unknown {missing}")

    assert not problems, "\n".join(problems)
