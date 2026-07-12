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


def test_every_agent_guide_has_its_avatar() -> None:
    assets = ROOT / "docs" / "assets" / "agents"
    missing: list[str] = []
    for page in AGENTS_DIR.glob("*.md"):
        if page.name == "README.md":
            continue
        expected = f'../assets/agents/{page.stem}.webp'
        if expected not in page.read_text(encoding="utf-8"):
            missing.append(page.name)
        assert (assets / f"{page.stem}.webp").is_file(), f"avatar missing for {page.name}"
    assert not missing, f"agent guides without avatar markup: {missing}"


def test_readme_agent_gallery_covers_every_named_agent() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    missing = [
        page.stem
        for page in AGENTS_DIR.glob("*.md")
        if page.name not in {"README.md", "frameworks.md"}
        and f"docs/assets/agents/{page.stem}.webp" not in readme
    ]
    assert not missing, f"README gallery missing agents: {missing}"
