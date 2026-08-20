"""Every relative link in the documentation resolves.

A broken link in a README is a small thing that reads as neglect, and the
ones that break are almost always the ones added alongside a new feature —
exactly when nobody is re-reading the index. Making this a test means a
renamed file fails here instead of in someone's browser.

Only relative links are checked. External URLs would need the network, which
the offline suite does not have and should not want.
"""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

import pytest

ROOT = Path(__file__).resolve().parents[1]
SEARCH_DIRS = ("docs", "examples", "skills", "adapters", "commands")
SKIP_PARTS = {".venv", "node_modules", ".git", "dist", "site-packages"}

# [text](target) — but not images, and not reference-style definitions.
LINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def _markdown_files() -> list[Path]:
    files = [ROOT / "README.md", ROOT / "AGENTS.md", ROOT / "CONTRIBUTING.md",
             ROOT / "SECURITY.md", ROOT / "CHANGELOG.md"]
    for directory in SEARCH_DIRS:
        base = ROOT / directory
        if not base.is_dir():
            continue
        files += [
            path for path in base.rglob("*.md")
            if not SKIP_PARTS & set(path.parts)
        ]
    return [path for path in files if path.is_file()]


def _anchor_slugs(text: str) -> set[str]:
    """GitHub's heading-to-anchor rules.

    Each whitespace character becomes its own hyphen — GitHub does not
    collapse runs. "LangChain / LangGraph" loses the slash and keeps both
    surrounding spaces, giving `langchain--langgraph`. Collapsing them here
    would fail perfectly good links.
    """
    slugs = set()
    for line in text.splitlines():
        if not line.startswith("#"):
            continue
        heading = line.lstrip("#").strip()
        slug = re.sub(r"[^\w\s-]", "", heading.lower())
        slugs.add(re.sub(r"\s", "-", slug))
    return slugs


MARKDOWN_FILES = _markdown_files()


def test_the_search_actually_found_the_documentation() -> None:
    """Guard against this suite passing because it checked nothing."""
    assert len(MARKDOWN_FILES) > 20, f"only found {len(MARKDOWN_FILES)} markdown files"


@pytest.mark.parametrize(
    "source", MARKDOWN_FILES, ids=lambda p: str(p.relative_to(ROOT)).replace("\\", "/")
)
def test_relative_links_resolve(source: Path) -> None:
    text = source.read_text(encoding="utf-8", errors="replace")
    broken: list[str] = []
    for target in LINK.findall(text):
        if target.startswith(("http://", "https://", "mailto:", "#", "tel:")):
            continue
        path_part, _, anchor = target.partition("#")
        if not path_part:
            continue
        resolved = (source.parent / unquote(path_part)).resolve()
        if not resolved.exists():
            broken.append(f"{target} -> {resolved}")
            continue
        if anchor and resolved.suffix == ".md":
            slugs = _anchor_slugs(
                resolved.read_text(encoding="utf-8", errors="replace")
            )
            if anchor.lower() not in slugs:
                broken.append(f"{target} (no heading #{anchor})")
    assert not broken, "broken links in {}:\n  {}".format(
        source.relative_to(ROOT), "\n  ".join(broken)
    )


def test_every_doc_is_reachable_from_an_index() -> None:
    """A guide nobody links to is a guide nobody reads."""
    linked: set[Path] = set()
    for source in MARKDOWN_FILES:
        text = source.read_text(encoding="utf-8", errors="replace")
        for target in LINK.findall(text):
            if target.startswith(("http", "mailto:", "#")):
                continue
            path_part, _, _ = target.partition("#")
            if path_part:
                linked.add((source.parent / unquote(path_part)).resolve())

    orphans = [
        path.relative_to(ROOT)
        for path in (ROOT / "docs").rglob("*.md")
        if path.resolve() not in linked
        and path.name != "README.md"
        and not SKIP_PARTS & set(path.parts)
    ]
    assert not orphans, f"documentation nothing links to: {orphans}"


def test_the_readme_lists_every_example() -> None:
    """The README's example table drifted three behind the directory.

    It also claimed "all 16 examples" while twenty existed. Neither the link
    checker nor the catalog noticed, because every link that was present
    resolved -- the failure was the ones that were absent.
    """
    import re

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    on_disk = {p.name for p in (ROOT / "examples").iterdir()
               if p.is_dir() and p.name[:2].isdigit()}
    linked = set(re.findall(r"examples/(\d\d-[a-z0-9-]+)", readme))

    assert not on_disk - linked, (
        f"examples missing from the README table: {sorted(on_disk - linked)}")
    assert not linked - on_disk, (
        f"README links an example that does not exist: {sorted(linked - on_disk)}")

    claimed = re.search(r"all (\d+) examples", readme)
    assert claimed, "the README no longer states how many examples there are"
    assert int(claimed.group(1)) == len(on_disk), (
        f"README says {claimed.group(1)} examples; {len(on_disk)} exist")


def test_the_architecture_module_map_covers_every_package() -> None:
    """The map described a tree eight packages out of date.

    live, operate, observer, actions, verify, triggers, entities and models
    all shipped without an entry, so the architecture page described a
    different program than the one in src/.
    """
    doc = (ROOT / "docs" / "architecture.md").read_text(encoding="utf-8")
    packages = {
        p.name for p in (ROOT / "src" / "watch_skill").iterdir()
        if p.is_dir() and not p.name.startswith("__")
    }
    missing = sorted(p for p in packages if f"`{p}/`" not in doc)
    assert not missing, f"packages absent from the architecture module map: {missing}"
