"""Doctor checks: statuses, self-heal paths (mocked — no network), health log."""
from __future__ import annotations

import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from agentvision.health import doctor
from agentvision.health.log import read_incidents, record_incident


def _completed(stdout: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")


def test_check_python_passes_here() -> None:
    result = doctor.check_python()
    assert result.status == "ok"


def test_check_ffmpeg_fail_without_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: None)
    result = doctor.check_ffmpeg(fix=False)
    assert result.status == "fail"


def test_check_ffmpeg_ok_when_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = tmp_path / "ffmpeg.exe"
    fake.write_bytes(b"")
    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: fake)
    result = doctor.check_ffmpeg(fix=False)
    assert result.status == "ok"


def test_check_yt_dlp_bootstraps_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    downloaded = tmp_path / "managed" / "yt-dlp.exe"

    def fake_bootstrap() -> Path:
        downloaded.parent.mkdir(parents=True, exist_ok=True)
        downloaded.write_bytes(b"fake")
        return downloaded

    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: None)
    monkeypatch.setattr(doctor.binaries, "bootstrap_yt_dlp", fake_bootstrap)
    result = doctor.check_yt_dlp(fix=True)
    assert result.status == "ok"
    assert result.fix_applied == "download"
    assert downloaded.exists()


def test_yt_dlp_version_date_parsing() -> None:
    assert doctor.yt_dlp_version_date("2025.06.30") == date(2025, 6, 30)
    assert doctor.yt_dlp_version_date("2025.06.30.123456") == date(2025, 6, 30)
    assert doctor.yt_dlp_version_date("garbage") is None
    assert doctor.yt_dlp_version_date("2025.99.99") is None


def test_freshness_ok_for_recent_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "yt-dlp.exe"
    fake.write_bytes(b"")
    recent = (datetime.now().date() - timedelta(days=3)).strftime("%Y.%m.%d")
    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: fake)
    monkeypatch.setattr(doctor, "_run", lambda cmd, timeout=60.0: _completed(recent))
    result = doctor.check_yt_dlp_freshness(fix=False)
    assert result.status == "ok"


def test_freshness_warns_when_stale_and_update_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "yt-dlp.exe"
    fake.write_bytes(b"")
    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: fake)
    monkeypatch.setattr(doctor, "_run", lambda cmd, timeout=60.0: _completed("2020.01.01"))
    monkeypatch.setattr(doctor, "update_yt_dlp", lambda path: False)
    result = doctor.check_yt_dlp_freshness(fix=True)
    assert result.status == "warn"
    assert "2020.01.01" in result.message


def test_freshness_self_updates_when_stale(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "yt-dlp.exe"
    fake.write_bytes(b"")
    monkeypatch.setattr(doctor.binaries, "find_binary", lambda name: fake)
    monkeypatch.setattr(doctor, "_run", lambda cmd, timeout=60.0: _completed("2020.01.01"))
    monkeypatch.setattr(doctor, "update_yt_dlp", lambda path: True)
    result = doctor.check_yt_dlp_freshness(fix=True)
    assert result.status == "ok"
    assert result.fix_applied == "self-update"


def test_disk_space_check_runs() -> None:
    result = doctor.check_disk_space()
    assert result.status in ("ok", "warn")


def test_api_keys_reports_local_only_without_keys() -> None:
    result = doctor.check_api_keys()
    assert result.status == "ok"
    assert "local-only" in result.message


def test_api_keys_reports_configured_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "gsk-very-secret-value"
    monkeypatch.setenv("AGENTVISION_GROQ_API_KEY", secret)
    from agentvision.config import reset_settings

    reset_settings()
    result = doctor.check_api_keys()
    assert "groq" in result.message
    assert secret not in result.message  # key values must never leak into output


def test_report_aggregation_and_serialization() -> None:
    report = doctor.DoctorReport(
        checks=[
            doctor.CheckResult("a", "ok", "fine"),
            doctor.CheckResult("b", "warn", "meh"),
        ]
    )
    assert report.ok is True
    report.checks.append(doctor.CheckResult("c", "fail", "broken"))
    assert report.ok is False
    payload = report.to_dict()
    assert payload["ok"] is False
    assert [c["name"] for c in payload["checks"]] == ["a", "b", "c"]


def test_health_log_roundtrip(isolated_settings: Path) -> None:
    record_incident("test", "something happened", extra_field=42)
    record_incident("test", "second")
    incidents = read_incidents()
    assert len(incidents) == 2
    assert incidents[0]["extra_field"] == 42
    assert incidents[1]["detail"] == "second"
    assert "ts" in incidents[0]


def test_server_command_never_points_into_a_venv(monkeypatch) -> None:
    """Regression: `agentvision setup` wrote `agentvision serve` into agent
    configs because the venv entry point was on PATH — invisible to every
    other app. A venv-resolved exe must fall back to `uv --directory`."""
    from agentvision.health import agents_setup as mod

    monkeypatch.setattr(
        mod.shutil, "which",
        lambda name: r"F:\proj\.venv\Scripts\agentvision.EXE" if name == "agentvision" else None,
    )
    command, args = mod.server_command()
    assert command == "uv"
    assert args[0] == "--directory" and args[-2:] == ["agentvision", "serve"]

    monkeypatch.setattr(
        mod.shutil, "which",
        lambda name: r"C:\Users\x\.local\bin\agentvision.exe" if name == "agentvision" else None,
    )
    assert mod.server_command() == ("agentvision", ["serve"])
