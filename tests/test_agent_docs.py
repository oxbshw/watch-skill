"""The agent matrix keeps its promises: every fenced config block in
docs/agents/*.md parses, every page is in the matrix, every matrix link
resolves. This is the same check contributors run via
scripts/validate_agent_docs.py.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT / "docs" / "agents"


def _load_validator():
    spec = importlib.util.spec_from_file_location(
        "agent_validate", ROOT / "scripts" / "validate_agent_docs.py"
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
    skeleton = ROOT / "templates" / "agent-integration" / "agent-docs.template.md"
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


def test_gallery_covers_every_agent_that_has_art() -> None:
    """Art that exists is shown in the index, and the index is the agent page.

    This used to read the root README, which carried a grid of every avatar.
    The stable redesign compresses that front page to two entry paths and one
    product screenshot, so the grid moved to the page whose job it actually is
    -- `docs/agents/README.md`, the matrix somebody lands on when they want to
    know whether their agent is supported. The rule did not change: art nobody
    links to is art nobody sees.
    """
    gallery = (AGENTS_DIR / "README.md").read_text(encoding="utf-8")
    missing = [
        page.stem
        for page in AGENTS_DIR.glob("*.md")
        if page.name not in {"README.md", "frameworks.md"}
        and _has_avatar(page)
        and f"../assets/agents/{page.stem}.webp" not in gallery
    ]
    assert not missing, f"agent gallery missing: {missing}"


def test_the_front_page_points_at_the_gallery_rather_than_repeating_it() -> None:
    """One grid, in one place — but a signpost is not a second grid.

    This asserted zero avatars on the front page, which was the right rule
    written one notch too tightly. What it exists to prevent is a *duplicate
    gallery*: twenty-six avatars in two files, drifting apart, with nobody sure
    which one is the index. What it also prevented was the thing a front page
    is for — showing a visitor at a glance that their editor is on the list,
    and sending them to the matrix to find out how far.

    So the bound is a size rather than a ban. A handful of recognisable marks
    that link onward is a signpost. Anything approaching the full set is the
    gallery again, and the gallery has a page.
    """
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "docs/agents/README.md" in readme, "the README must link the agent index"

    shown = readme.count("docs/assets/agents/")
    everything = len([
        page
        for page in AGENTS_DIR.glob("*.md")
        if page.name not in {"README.md", "frameworks.md"} and _has_avatar(page)
    ])
    assert shown <= 12, (
        f"the README shows {shown} avatars of {everything}; past a dozen this is "
        "the gallery again, and the gallery lives in docs/agents/"
    )
    assert shown < everything, (
        "the README shows every avatar there is, which makes it the gallery "
        "rather than a pointer to it"
    )


def test_pages_without_art_are_still_reachable() -> None:
    """The matrix is the index of record, so nothing may be orphaned there."""
    matrix = (AGENTS_DIR / "README.md").read_text(encoding="utf-8")
    orphaned = [
        page.name
        for page in AGENTS_DIR.glob("*.md")
        if page.name != "README.md" and f"({page.name})" not in matrix
    ]
    assert not orphaned, f"pages missing from the matrix: {orphaned}"
