"""Validate every fenced config block in the agent docs.

Usage:
    python scripts/validate_agent_docs.py [docs/agents/your-agent.md ...]

With no arguments it sweeps all of docs/agents/*.md. Two things must hold
for every page, and each of them has been wrong in a shipped file.

Every fenced block tagged json / jsonc / toml / yaml must parse. A matrix
row whose config cannot even parse is a lie about a config somebody will
paste.

And no page may still carry a template token. `agent-docs.template.md` is
written with `{{AGENT_NAME}}`-style holes precisely so that a half-filled
copy is detectable: a page that says "Watch Skill in {{AGENT_NAME}}" is
obviously unfinished, whereas the old `YOUR-AGENT` spelling looked enough
like prose to survive review. The template itself is the one file allowed
to contain them.

Exit code is the number of problems.

This is also the checker for new integration contributions: run it on your
page before opening the PR.
"""
from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FENCE = re.compile(r"^```(\w+)\n(.*?)^```", re.MULTILINE | re.DOTALL)

# The template's own holes, in the one syntax nothing else in the tree uses.
TOKEN = re.compile(r"\{\{[A-Z][A-Z0-9_]*\}\}")

# The file the tokens belong to. Anything else carrying one is unfinished.
TEMPLATE = ROOT / "templates" / "agent-integration" / "agent-docs.template.md"


def _strip_jsonc(text: str) -> str:
    # Enough for config examples: drop // comments outside strings.
    out_lines = []
    for line in text.splitlines():
        in_str = False
        prev = ""
        for i, ch in enumerate(line):
            if ch == '"' and prev != "\\":
                in_str = not in_str
            if not in_str and ch == "/" and line[i : i + 2] == "//":
                line = line[:i]
                break
            prev = ch
        out_lines.append(line)
    return "\n".join(out_lines)


def _parse(lang: str, body: str) -> str | None:
    """Return an error string, or None when the block parses."""
    try:
        if lang == "json":
            json.loads(body)
        elif lang == "jsonc":
            json.loads(_strip_jsonc(body))
        elif lang == "toml":
            tomllib.loads(body)
        elif lang == "yaml":
            import yaml

            yaml.safe_load(body)
        else:
            return None  # not a config language; skip
    except Exception as exc:  # noqa: BLE001 — report every parse failure
        return f"{type(exc).__name__}: {exc}"
    return None


def check_file(path: Path) -> list[str]:
    failures = []
    text = path.read_text(encoding="utf-8")
    for match in FENCE.finditer(text):
        lang, body = match.group(1).lower(), match.group(2)
        error = _parse(lang, body)
        if error:
            line = text[: match.start()].count("\n") + 1
            failures.append(f"{path.name}:{line} [{lang}] {error}")

    if path.resolve() != TEMPLATE.resolve():
        for match in TOKEN.finditer(text):
            line = text[: match.start()].count("\n") + 1
            failures.append(
                f"{path.name}:{line} unresolved template token {match.group(0)}"
            )
    return failures


def main(argv: list[str]) -> int:
    targets = [Path(a) for a in argv] or sorted((ROOT / "docs" / "agents").glob("*.md"))
    failures: list[str] = []
    checked = 0
    for path in targets:
        failures.extend(check_file(path))
        checked += 1
    for failure in failures:
        print(f"BROKEN {failure}")
    print(f"{checked} files checked, {len(failures)} broken config blocks")
    return len(failures)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
