"""Binary resolution: managed bin dir shadows PATH; space-safe paths."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from agentvision.config import reset_settings
from agentvision.errors import DependencyError
from agentvision.health import binaries

_EXE = ".exe" if sys.platform == "win32" else ""


def _fake_exe(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}{_EXE}"
    path.write_bytes(b"fake")
    # shutil.which on POSIX requires the executable bit (first CI run on
    # Linux caught this — Windows doesn't care)
    path.chmod(0o755)
    return path


def test_find_binary_prefers_managed_dir_over_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    managed = tmp_path / "managed bin with spaces"
    monkeypatch.setenv("AGENTVISION_BIN_DIR", str(managed))
    reset_settings()

    managed_copy = _fake_exe(managed, "toolx")
    path_dir = tmp_path / "on path"
    _fake_exe(path_dir, "toolx")
    monkeypatch.setenv("PATH", str(path_dir))

    assert binaries.find_binary("toolx") == managed_copy


def test_find_binary_falls_back_to_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENTVISION_BIN_DIR", str(tmp_path / "empty managed"))
    reset_settings()
    path_dir = tmp_path / "system dir with spaces"
    expected = _fake_exe(path_dir, "tooly")
    monkeypatch.setenv("PATH", str(path_dir))

    found = binaries.find_binary("tooly")
    assert found is not None
    assert found.resolve() == expected.resolve()


def test_find_binary_missing_returns_none(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGENTVISION_BIN_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("PATH", str(tmp_path))
    reset_settings()
    assert binaries.find_binary("definitely-not-a-real-binary") is None


def test_require_binary_raises_structured_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AGENTVISION_BIN_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("PATH", str(tmp_path))
    reset_settings()
    with pytest.raises(DependencyError) as excinfo:
        binaries.require_binary("ghost-tool")
    assert excinfo.value.code == "health.binary_missing"
    assert "doctor" in (excinfo.value.fix or "")


def test_managed_bin_dir_created_on_demand(isolated_settings: Path) -> None:
    bin_dir = binaries.managed_bin_dir(create=True)
    assert bin_dir.is_dir()
    assert bin_dir == isolated_settings / "bin"


def test_prepend_bin_dir_to_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    managed = tmp_path / "managed bin"
    monkeypatch.setenv("AGENTVISION_BIN_DIR", str(managed))
    monkeypatch.setenv("PATH", "C:\\other" if sys.platform == "win32" else "/usr/bin")
    reset_settings()
    binaries.prepend_bin_dir_to_path()
    import os

    assert os.environ["PATH"].startswith(str(managed))
    before = os.environ["PATH"]
    binaries.prepend_bin_dir_to_path()
    assert os.environ["PATH"] == before  # idempotent
