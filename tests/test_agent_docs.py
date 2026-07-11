"""The agent matrix keeps its promises: every fenced config block in
docs/agents/*.md parses, every page is in the matrix, every matrix link
resolves. This is the same check contributors run via
templates/agent-adapter/validate.py.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT / "docs" / "agents"


def _load_validator():
    spec = importlib.util.spec_from_file_location(
        "agent_validate", ROOT / "templates" / "agent-adapter" / "validate.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_config_block_parses() -> None:
    validate = _load_validator()
    failures: list[str] = []
    for page in sorted(AGENTS_DIR.glob("*.md")):
        failures.extend(validate.check_file(page))
    assert not failures, "\n".join(failures)


def test_every_agent_page_is_in_the_matrix() -> None:
    matrix = (AGENTS_DIR / "README.md").read_text(encoding="utf-8")
    missing = [
        page.name
        for page in AGENTS_DIR.glob("*.md")
        if page.name != "README.md" and f"({page.name})" not in matrix
    ]
    assert not missing, f"pages not linked from the matrix: {missing}"


def test_matrix_links_resolve() -> None:
    matrix = (AGENTS_DIR / "README.md").read_text(encoding="utf-8")
    broken = [
        target
        for target in re.findall(r"\]\(([\w-]+\.md)\)", matrix)
        if not (AGENTS_DIR / target).is_file()
    ]
    assert not broken, f"matrix links to missing pages: {broken}"


def test_template_skeleton_validates_too() -> None:
    validate = _load_validator()
    skeleton = ROOT / "templates" / "agent-adapter" / "docs-skeleton.md"
    assert not validate.check_file(skeleton)
