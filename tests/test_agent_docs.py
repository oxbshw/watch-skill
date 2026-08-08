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


def _has_avatar(page: Path) -> bool:
    return (ROOT / "docs" / "assets" / "agents" / f"{page.stem}.webp").is_file()


def test_a_page_with_an_avatar_actually_shows_it() -> None:
    """Art that exists but is not referenced is art nobody sees.

    The avatar is deliberately not required to *add* an agent: every avatar
    is hand-drawn, and gating a new page on someone producing one contradicts
    the twenty-minute contribution path CONTRIBUTING promises. A page without
    art still belongs in the matrix; it just does not appear in the README
    gallery until the art exists.
    """
    missing = [
        page.name
        for page in AGENTS_DIR.glob("*.md")
        if page.name != "README.md"
        and _has_avatar(page)
        and f"../assets/agents/{page.stem}.webp" not in page.read_text(encoding="utf-8")
    ]
    assert not missing, f"avatar exists but the page does not show it: {missing}"


def test_readme_gallery_covers_every_agent_that_has_art() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    missing = [
        page.stem
        for page in AGENTS_DIR.glob("*.md")
        if page.name not in {"README.md", "frameworks.md"}
        and _has_avatar(page)
        and f"docs/assets/agents/{page.stem}.webp" not in readme
    ]
    assert not missing, f"README gallery missing agents: {missing}"


def test_pages_without_art_are_still_reachable() -> None:
    """The matrix is the index of record, so nothing may be orphaned there."""
    matrix = (AGENTS_DIR / "README.md").read_text(encoding="utf-8")
    orphaned = [
        page.name
        for page in AGENTS_DIR.glob("*.md")
        if page.name != "README.md" and f"({page.name})" not in matrix
    ]
    assert not orphaned, f"pages missing from the matrix: {orphaned}"
