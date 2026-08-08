"""Packaging for both skill ecosystems, and versions that agree everywhere.

The skills used to live under `adapters/claude-skill/`, where only Claude
Code could find them. `npx skills add`, which installs into 27+ agents,
looks for a top-level `skills/` directory, so that is now the canonical
location and the plugin is rooted at the repository instead — one copy
serving both.

`/plugin marketplace add oxbshw/watch-skill` resolves the repo-root
`.claude-plugin/marketplace.json`; every path a manifest references must
resolve from the plugin root.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _rel(base: Path, ref: str) -> Path:
    return base / (ref[2:] if ref.startswith("./") else ref)


def _pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def test_marketplace_manifest_points_at_the_plugin() -> None:
    mk = _load_json(ROOT / ".claude-plugin" / "marketplace.json")
    assert mk["name"] == "watch-skill"
    assert mk["owner"]["name"] == "oxbshw"
    entry = next(p for p in mk["plugins"] if p["name"] == "watch-skill")
    src = _rel(ROOT, entry["source"])
    assert src.is_dir() and (src / ".claude-plugin" / "plugin.json").is_file()


def test_plugin_manifest_component_paths_resolve() -> None:
    pl = _load_json(PLUGIN_DIR / ".claude-plugin" / "plugin.json")
    assert pl["name"] == "watch-skill"
    for field in ("skills", "commands", "mcpServers"):
        assert _rel(PLUGIN_DIR, pl[field]).exists(), f"{field} path missing"


def test_bundled_mcp_server_is_path_based_not_repo_bound() -> None:
    """The install copies the plugin out of the repo, so the MCP command must
    be the on-PATH `watch-skill`, never a `uv --directory <repo>` form."""
    mcp = _load_json(PLUGIN_DIR / ".mcp.json")
    server = mcp["mcpServers"]["watch-skill"]
    assert server["command"] == "watch-skill"
    assert server["args"] == ["serve"]
    blob = json.dumps(mcp)
    assert "--directory" not in blob and str(ROOT) not in blob


def test_setup_command_is_shipped_and_documented() -> None:
    cmd = PLUGIN_DIR / "commands" / "setup-watch-skill.md"
    assert cmd.is_file()
    text = cmd.read_text(encoding="utf-8")
    assert text.startswith("---")  # has frontmatter
    assert "watch-skill setup" in text          # wires the agents
    assert "setup-vision" in text                # offers a vision backend
    assert "watch-skill doctor" in text          # bootstraps binaries


def test_versions_agree_across_manifests() -> None:
    version = _pyproject_version()
    mk = _load_json(ROOT / ".claude-plugin" / "marketplace.json")
    pl = _load_json(PLUGIN_DIR / ".claude-plugin" / "plugin.json")
    entry = next(p for p in mk["plugins"] if p["name"] == "watch-skill")
    skill = (PLUGIN_DIR / "skills" / "watch" / "SKILL.md").read_text(encoding="utf-8")
    skill_version = re.search(r'version:\s*"([^"]+)"', skill).group(1)

    assert pl["version"] == version, "plugin.json vs pyproject"
    assert entry["version"] == version, "marketplace entry vs pyproject"
    assert skill_version == version, "SKILL.md vs pyproject"
    assert mk["metadata"]["version"] == version, "marketplace metadata vs pyproject"


def test_package_reports_the_release_version() -> None:
    """v1.0.0 shipped announcing itself as 0.6.0.

    The release bumped every manifest above and missed
    `src/watch_skill/__init__.py`, so `watch-skill version` — the first thing
    a bug reporter is asked for — named the wrong release. __version__ now
    derives from installed metadata; this guards the contract either way.
    """
    from watch_skill import __version__

    assert __version__ == _pyproject_version(), "watch_skill.__version__ vs pyproject"


@pytest.mark.parametrize("manifest", [
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "skills.sh.json",
])
def test_manifests_are_valid_json(manifest: str) -> None:
    _load_json(ROOT / manifest)  # raises on malformed JSON


# --- cross-agent skill discovery --------------------------------------------
#
# `npx skills add oxbshw/watch-skill` installs into 27+ agents, and it finds
# skills by looking for a top-level `skills/` directory. While they lived
# under adapters/claude-skill/ only Claude Code could see them.

SKILLS_DIR = ROOT / "skills"


def test_skills_live_at_the_top_level_where_the_skills_cli_looks() -> None:
    assert SKILLS_DIR.is_dir(), "npx skills expects a top-level skills/ directory"
    found = sorted(p.parent.name for p in SKILLS_DIR.glob("*/SKILL.md"))
    assert len(found) >= 10, f"expected the full skill library, found {found}"
    assert "watch" in found, "the entry-point skill must be discoverable"


def test_the_skills_manifest_points_at_that_directory() -> None:
    manifest = _load_json(ROOT / "skills.sh.json")
    assert manifest["name"] == "watch-skill"
    assert _rel(ROOT, manifest["skills"]).is_dir()


@pytest.mark.parametrize("skill_md", sorted((ROOT / "skills").glob("*/SKILL.md")), ids=lambda p: p.parent.name)
def test_every_skill_has_the_frontmatter_agents_read(skill_md: Path) -> None:
    """name and description are what a harness matches against a user's words.

    A skill missing either is invisible: it installs and never triggers.
    """
    text = skill_md.read_text(encoding="utf-8")
    assert text.startswith("---"), "SKILL.md must open with YAML frontmatter"
    frontmatter = text.split("---")[1]

    name = re.search(r"^name:\s*(\S+)", frontmatter, re.M)
    assert name, "no name in frontmatter"
    assert name.group(1) == skill_md.parent.name, "name must match its directory"

    description = re.search(r"^description:\s*(.+)$", frontmatter, re.M)
    assert description, "no description in frontmatter"
    assert len(description.group(1)) > 40, "description too thin to trigger on"


def test_no_skill_is_left_behind_in_the_old_location() -> None:
    """A stale copy would drift from the canonical one and confuse installs."""
    assert not (ROOT / "adapters" / "claude-skill").exists()
