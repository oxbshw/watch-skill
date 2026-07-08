"""The Claude Code plugin + marketplace packaging is correct and versions
agree across every manifest.

`/plugin marketplace add oxbshw/watch-skill` resolves the repo-root
`.claude-plugin/marketplace.json`; installing copies ONLY the plugin
directory, so every path a manifest references must live inside it.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "adapters" / "claude-skill"


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


@pytest.mark.parametrize("manifest", [
    ".claude-plugin/marketplace.json",
    "adapters/claude-skill/.claude-plugin/plugin.json",
    "adapters/claude-skill/.mcp.json",
])
def test_manifests_are_valid_json(manifest: str) -> None:
    _load_json(ROOT / manifest)  # raises on malformed JSON
