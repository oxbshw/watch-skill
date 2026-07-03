"""Shared fixtures: every test runs against an isolated data dir WITH SPACES
in its path (both this repo and the reference live in space-containing
directories — treating that as a permanent test case)."""
from __future__ import annotations

from pathlib import Path

import pytest

from agentvision.config import reset_settings

_AMBIENT_KEYS = (
    "AGENTVISION_ANTHROPIC_API_KEY",
    "AGENTVISION_OPENAI_API_KEY",
    "AGENTVISION_GEMINI_API_KEY",
    "AGENTVISION_GROQ_API_KEY",
    "AGENTVISION_BIN_DIR",
    "AGENTVISION_DATA_DIR",
)


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point AgentVision at a throwaway data dir (with spaces) for every test."""
    for var in _AMBIENT_KEYS:
        monkeypatch.delenv(var, raising=False)
    data_dir = tmp_path / "agent vision data"
    monkeypatch.setenv("AGENTVISION_DATA_DIR", str(data_dir))
    reset_settings()
    yield data_dir
    reset_settings()
