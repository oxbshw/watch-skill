"""The skills library ships nine agent-facing skills, each a valid
trigger surface: parseable frontmatter, a description an agent can route
on without being told a tool name, and a version that agrees with
pyproject.

The engine is not involved here — skills wrap the CLI, so this is pure
packaging: if these pass, `/plugin install` gives Claude Code (and any
harness that reads SKILL.md) the full set.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
# Top level, where the skills CLI looks — see test_plugin_packaging.py.
SKILLS_DIR = ROOT / "skills"

# The library: every skill the plugin promises. `watch` is the original
# user-invocable command-style skill; the other nine are the v1.0
# auto-trigger library.
LIBRARY = [
    "watching-videos",
    "asking-with-evidence",
    "the-loop",
    "learning-from-mistakes",
    "extracting-structure",
    "video-memory",
    "sharing-results",
    "configuring-vision",
    "recovering-from-errors",
]
ALL_SKILLS = ["watch", *LIBRARY]


def _frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---"), f"{path} missing frontmatter"
    block = text.split("---", 2)[1]
    fields: dict[str, str] = {}
    for line in block.strip().splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip().strip('"')
    return fields


def _pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def test_the_full_library_is_present() -> None:
    for skill in ALL_SKILLS:
        assert (SKILLS_DIR / skill / "SKILL.md").is_file(), f"skills/{skill} missing"


@pytest.mark.parametrize("skill", ALL_SKILLS)
def test_frontmatter_is_complete(skill: str) -> None:
    fm = _frontmatter(SKILLS_DIR / skill / "SKILL.md")
    assert fm["name"] == skill, "name must match the directory"
    assert fm.get("license") == "MIT"
    assert "allowed-tools" in fm


@pytest.mark.parametrize("skill", ALL_SKILLS)
def test_versions_agree_with_pyproject(skill: str) -> None:
    fm = _frontmatter(SKILLS_DIR / skill / "SKILL.md")
    assert fm["version"] == _pyproject_version(), f"{skill} version drift"


@pytest.mark.parametrize("skill", LIBRARY)
def test_description_is_a_trigger_surface_not_a_label(skill: str) -> None:
    """Auto-triggering lives or dies on the description: it must carry
    concrete user phrasings ('quoted like this') and say when to use it,
    not just name the feature."""
    fm = _frontmatter(SKILLS_DIR / skill / "SKILL.md")
    desc = fm["description"]
    assert len(desc) > 150, "too short to route on"
    assert '"' in desc, "no example user phrasing"
    assert re.search(r"\bUse this\b", desc), "doesn't tell the agent when to reach for it"


@pytest.mark.parametrize("skill", LIBRARY)
def test_body_wraps_the_cli_only(skill: str) -> None:
    """Skills are thin: they must call the watch-skill CLI (portable to
    every harness) and never import the engine or hardcode this repo."""
    body = (SKILLS_DIR / skill / "SKILL.md").read_text(encoding="utf-8")
    assert "watch-skill " in body, "must show real CLI invocations"
    assert "src/watch_skill" not in body and "import " not in body
    assert str(ROOT) not in body


def test_original_watch_skill_untouched_contract() -> None:
    """/watch keeps working: user-invocable with the same argument hint."""
    fm = _frontmatter(SKILLS_DIR / "watch" / "SKILL.md")
    assert fm.get("user-invocable") == "true"
    assert "argument-hint" in fm


def test_documented_skill_counts_match_the_directory() -> None:
    """Prose that counts the skills has to count the ones that exist.

    The MCP tool count rotted in six places before a test pinned it. The skill
    count is written in words rather than digits, which is exactly the form a
    find-and-replace misses, so it is checked here against the directory
    instead of trusted to a reviewer.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    actual = len([p for p in (root / "skills").iterdir()
                  if p.is_dir() and (p / "SKILL.md").is_file()])
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
             "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
             "twelve": 12}
    pattern = re.compile(r"\b(\w+)\s+(?:portable\s+|agent\s+)?skills\b", re.I)

    stale: list[str] = []
    for rel in ("README.md", "docs/ROADMAP.md", "docs/architecture.md",
                "docs/README.md", "llms.txt"):
        path = root / rel
        if not path.is_file():
            continue
        for found in pattern.findall(path.read_text(encoding="utf-8")):
            token = found.lower()
            claimed = words.get(token, int(token) if token.isdigit() else None)
            if claimed is not None and claimed != actual:
                stale.append(f"{rel} says {found}")

    assert not stale, f"{actual} skills exist; {'; '.join(stale)}"
