"""Measure what the agent skills actually cost in context.

Reports two different numbers, because they are loaded at different times and
confusing them is how the "4x smaller" sort of claim gets made:

**discovery** — the YAML frontmatter of every skill, which an agent reads to
decide *which* skill to load. Every agent pays this on every session.
**body** — the instructions of one skill, paid only when that skill triggers.

Counting uses the real tokenizer when `tiktoken` is installed and a
characters-per-token estimate otherwise; the output says which, because a
figure whose method is unstated is not a measurement.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
CHARS_PER_TOKEN = 3.6  # measured against tiktoken on this repo's prose


def _counter():
    try:
        import tiktoken  # noqa: PLC0415

        encoding = tiktoken.get_encoding("cl100k_base")
        return (lambda text: len(encoding.encode(text))), "tiktoken/cl100k_base"
    except ImportError:
        return (lambda text: round(len(text) / CHARS_PER_TOKEN)), \
            f"estimate ({CHARS_PER_TOKEN} chars/token)"


def split_frontmatter(text: str) -> tuple[str, str]:
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    return (match.group(1), match.group(2)) if match else ("", text)


def measure() -> dict:
    count, method = _counter()
    skills = []
    for skill_md in sorted(SKILLS.glob("*/SKILL.md")):
        text = skill_md.read_text(encoding="utf-8")
        frontmatter, body = split_frontmatter(text)
        references = sorted(
            path for path in skill_md.parent.rglob("*.md") if path != skill_md
        )
        skills.append({
            "name": skill_md.parent.name,
            "discovery_tokens": count(frontmatter),
            "body_tokens": count(body),
            "reference_files": len(references),
            "reference_tokens": sum(
                count(path.read_text(encoding="utf-8")) for path in references
            ),
        })
    return {
        "method": method,
        "skill_count": len(skills),
        "discovery_total": sum(s["discovery_tokens"] for s in skills),
        "body_total": sum(s["body_tokens"] for s in skills),
        "reference_total": sum(s["reference_tokens"] for s in skills),
        "worst_body": max((s["body_tokens"] for s in skills), default=0),
        "skills": skills,
    }


def main() -> int:
    report = measure()
    if "--json" in sys.argv:
        print(json.dumps(report, indent=2))
        return 0
    print(f"counting with: {report['method']}\n")
    print(f"{'skill':<28} {'discovery':>10} {'body':>8} {'refs':>6} {'ref tok':>8}")
    print("-" * 64)
    for skill in report["skills"]:
        print(f"{skill['name']:<28} {skill['discovery_tokens']:>10} "
              f"{skill['body_tokens']:>8} {skill['reference_files']:>6} "
              f"{skill['reference_tokens']:>8}")
    print("-" * 64)
    print(f"{'TOTAL':<28} {report['discovery_total']:>10} "
          f"{report['body_total']:>8} {'':>6} {report['reference_total']:>8}")
    print(f"\ndiscovery cost, every session: {report['discovery_total']} tokens "
          f"across {report['skill_count']} skills")
    print(f"largest single body: {report['worst_body']} tokens")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
