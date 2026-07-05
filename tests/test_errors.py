"""Structured errors expose code + message + fix + details for agents."""
from __future__ import annotations

import pytest
from watch_skill.errors import (
    AcquisitionError,
    DependencyError,
    WatchSkillError,
)


def test_error_carries_structure() -> None:
    err = AcquisitionError(
        "yt-dlp failed after auto-update",
        fix="try a direct media URL or check the health log",
        details={"source": "https://example.com/v", "exit_code": 1},
    )
    payload = err.to_dict()
    assert payload["error"] == "acquire.failed"
    assert payload["fix"].startswith("try a direct")
    assert payload["details"]["exit_code"] == 1


def test_error_code_override() -> None:
    err = WatchSkillError("boom", code="custom.code")
    assert err.code == "custom.code"


def test_str_includes_code_and_fix() -> None:
    err = DependencyError("ffmpeg missing", fix="run watch-skill doctor")
    text = str(err)
    assert "health.dependency_missing" in text
    assert "run watch-skill doctor" in text


def test_errors_are_catchable_as_base() -> None:
    with pytest.raises(WatchSkillError):
        raise DependencyError("x")


def test_details_default_to_empty_dict() -> None:
    assert WatchSkillError("x").details == {}
