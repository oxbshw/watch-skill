"""Detect installed AI agents and write Watch Skill's MCP config into them.

The killer onboarding move: ``watch-skill setup`` finds every supported agent
on this machine and offers to register the MCP server in each one — with a
timestamped backup of any file it touches, and surgical merges that never
drop existing keys.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class AgentTarget:
    """One configurable agent installation found on this machine."""

    key: str            # claude-code | claude-desktop | cursor | codex | windsurf | cline | gemini
    label: str
    config_path: Path
    kind: str           # json-mcpservers | toml-codex
    detected: bool      # was the agent itself found (not just its config)?
    configured: bool = False  # already has an watch-skill entry


def _home() -> Path:
    return Path.home()


def _appdata() -> Path:
    return Path(os.environ.get("APPDATA", _home() / "AppData" / "Roaming"))


def server_command(project_dir: Path | None = None) -> tuple[str, list[str]]:
    """The command agents should launch. GLOBAL entry point only — an
    `watch-skill` that resolves inside a virtualenv is invisible to other
    apps, so a source checkout always gets the `uv --directory` form."""
    if project_dir is not None:
        return "uv", ["--directory", str(project_dir), "run", "watch-skill", "serve"]
    exe = shutil.which("watch-skill")
    if exe and ".venv" not in Path(exe).parts and "venv" not in Path(exe).parts:
        return "watch-skill", ["serve"]
    root = Path(__file__).resolve().parents[3]
    return "uv", ["--directory", str(root), "run", "watch-skill", "serve"]


def detect_agents() -> list[AgentTarget]:
    """Find supported agents on this machine (Windows/macOS/Linux paths)."""
    home, appdata = _home(), _appdata()
    mac_support = home / "Library" / "Application Support"
    candidates = [
        AgentTarget(
            "claude-code", "Claude Code", home / ".claude.json", "json-mcpservers",
            detected=bool(shutil.which("claude")) or (home / ".claude.json").is_file(),
        ),
        AgentTarget(
            "claude-desktop", "Claude Desktop",
            (appdata if sys.platform == "win32" else mac_support) / "Claude" / "claude_desktop_config.json",
            "json-mcpservers",
            detected=((appdata if sys.platform == "win32" else mac_support) / "Claude").is_dir(),
        ),
        AgentTarget(
            "cursor", "Cursor", home / ".cursor" / "mcp.json", "json-mcpservers",
            detected=(home / ".cursor").is_dir() or bool(shutil.which("cursor")),
        ),
        AgentTarget(
            "codex", "Codex CLI", home / ".codex" / "config.toml", "toml-codex",
            detected=(home / ".codex").is_dir() or bool(shutil.which("codex")),
        ),
        AgentTarget(
            "windsurf", "Windsurf", home / ".codeium" / "windsurf" / "mcp_config.json",
            "json-mcpservers",
            detected=(home / ".codeium" / "windsurf").is_dir(),
        ),
        AgentTarget(
            "gemini", "Gemini CLI", home / ".gemini" / "settings.json", "json-mcpservers",
            detected=(home / ".gemini").is_dir() or bool(shutil.which("gemini")),
        ),
    ]
    for target in candidates:
        target.configured = _is_configured(target)
    return candidates


def _is_configured(target: AgentTarget) -> bool:
    if not target.config_path.is_file():
        return False
    try:
        text = target.config_path.read_text(encoding="utf-8")
    except OSError:
        return False
    return "watch-skill" in text


def _backup(path: Path) -> Path | None:
    if not path.is_file():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.backup-{stamp}")
    shutil.copy2(path, backup)
    return backup


def _write_json_mcpservers(path: Path, command: str, args: list[str]) -> None:
    data: dict = {}
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    servers = data.setdefault("mcpServers", {})
    servers["watch-skill"] = {"command": command, "args": args}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _write_toml_codex(path: Path, command: str, args: list[str]) -> None:
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if "[mcp_servers.watch-skill]" in text:
        return
    args_toml = ", ".join(json.dumps(a) for a in args)
    block = (
        f'\n[mcp_servers.watch-skill]\ncommand = "{command}"\nargs = [{args_toml}]\n'
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + block, encoding="utf-8")


def configure_agent(
    target: AgentTarget, project_dir: Path | None = None
) -> tuple[bool, str]:
    """Write the watch-skill MCP entry into one agent's config.

    Returns (changed, human message). Existing files are backed up first;
    JSON merges never touch unrelated keys.
    """
    command, args = server_command(project_dir)
    if target.configured:
        return False, f"{target.label}: already configured ({target.config_path})"
    backup = _backup(target.config_path)
    try:
        if target.kind == "json-mcpservers":
            _write_json_mcpservers(target.config_path, command, args)
        else:
            _write_toml_codex(target.config_path, command, args)
    except (OSError, json.JSONDecodeError) as exc:
        return False, f"{target.label}: FAILED to write ({exc}) — config untouched"
    note = f" (backup: {backup.name})" if backup else ""
    return True, f"{target.label}: configured -> {target.config_path}{note}"
