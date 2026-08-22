"""Failure-path contract for configure_agent: a failed write must leave the
agent's config exactly as it was before the call (or absent), and the message
must say what actually happened — not claim "config untouched" over a
truncated file (issue #17).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from watch_skill.health.agents_setup import AgentTarget, configure_agent


def _target(config_path: Path) -> AgentTarget:
    return AgentTarget(
        key="claude-code",
        label="Claude Code",
        config_path=config_path,
        kind="json-mcpservers",
        detected=True,
    )


def _inject_partial_write(monkeypatch: pytest.MonkeyPatch, partial: str) -> None:
    """Replace Path.write_text with one that writes `partial` to the real path
    and then raises, simulating a mid-write failure. Uses open() directly so
    the injected writer does not recurse through the patch."""

    def faulty(self: Path, data: str, *args: object, **kwargs: object) -> int:
        self.parent.mkdir(parents=True, exist_ok=True)
        with open(self, "w", encoding="utf-8") as fh:
            fh.write(partial)
        raise OSError("injected write failure")

    monkeypatch.setattr(Path, "write_text", faulty)


def test_configure_agent_restores_existing_config_after_partial_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / ".claude.json"
    original = json.dumps(
        {"mcpServers": {"other-agent": {"command": "x"}}, "unrelated": True},
        indent=2,
    )
    config.write_text(original, encoding="utf-8")
    _inject_partial_write(monkeypatch, '{"truncated":')

    changed, message = configure_agent(_target(config))

    assert changed is False
    assert "restored" in message.lower()
    # Public postcondition: the live file equals its pre-call bytes.
    assert config.read_text(encoding="utf-8") == original


def test_configure_agent_restores_toml_config_after_partial_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "config.toml"
    original = '[mcp_servers.other]\ncommand = "x"\n'
    config.write_text(original, encoding="utf-8")
    target = AgentTarget(
        key="codex", label="Codex CLI", config_path=config, kind="toml-codex", detected=True
    )
    _inject_partial_write(monkeypatch, "[mcp_servers.watch")

    changed, message = configure_agent(target)

    assert changed is False
    assert "restored" in message.lower()
    assert config.read_text(encoding="utf-8") == original


def test_configure_agent_removes_partial_new_config_after_failed_first_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / ".gemini" / "settings.json"
    _inject_partial_write(monkeypatch, '{"partial":')

    changed, message = configure_agent(_target(config))

    assert changed is False
    assert "removed" in message.lower()
    # A config that did not exist before the call must not be left partial.
    assert not config.exists()


def test_configure_agent_reports_failed_restoration_instead_of_lying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / ".claude.json"
    original = '{"keep": true}'
    config.write_text(original, encoding="utf-8")
    _inject_partial_write(monkeypatch, '{"truncated":')
    real_copy2 = shutil.copy2

    def selective_raiser(src, dst, **kwargs):
        # Fail only the RESTORE direction (backup -> live); the initial
        # backup creation (live -> backup) must still succeed.
        if ".backup-" in str(src):
            raise OSError("injected restore failure")
        return real_copy2(src, dst, **kwargs)

    monkeypatch.setattr("watch_skill.health.agents_setup.shutil.copy2", selective_raiser)

    changed, message = configure_agent(_target(config))

    assert changed is False
    assert "restore failed" in message.lower()
    # The truncated live file is still there; nothing claimed it was fine.
    assert config.read_text(encoding="utf-8") == '{"truncated":'


def _raiser(*args: object, **kwargs: object) -> None:
    raise OSError("injected restore failure")


def test_configure_agent_invalid_json_still_reads_as_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / ".claude.json"
    original = "{not valid json"
    config.write_text(original, encoding="utf-8")

    changed, message = configure_agent(_target(config))

    assert changed is False
    assert "untouched" in message.lower()
    assert config.read_text(encoding="utf-8") == original
