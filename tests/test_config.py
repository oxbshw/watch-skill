"""Settings: defaults, env precedence, derived paths, privacy defaults."""
from __future__ import annotations

from pathlib import Path

import pytest
from watch_skill.config import Settings, get_settings, reset_settings


def test_defaults_inherit_reference_frame_economics() -> None:
    settings = get_settings()
    assert settings.frame_width == 512
    assert settings.frame_cap == 100
    assert settings.max_fps == 2.0


def test_cloud_stt_is_opt_in_by_default() -> None:
    assert get_settings().cloud_stt_enabled is False


def test_data_dir_with_spaces_and_derived_paths(isolated_settings: Path) -> None:
    settings = get_settings()
    assert settings.data_dir == isolated_settings
    assert " " in str(settings.data_dir)
    assert settings.cache_dir == isolated_settings / "cache"
    assert settings.index_path == isolated_settings / "index.db"
    assert settings.resolved_bin_dir == isolated_settings / "bin"


def test_env_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_FRAME_WIDTH", "1024")
    reset_settings()
    assert get_settings().frame_width == 1024


def test_explicit_bin_dir_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    custom = tmp_path / "custom bin dir"
    monkeypatch.setenv("WATCHSKILL_BIN_DIR", str(custom))
    reset_settings()
    assert get_settings().resolved_bin_dir == custom


def test_env_wins_over_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = tmp_path / "proj with spaces"
    project.mkdir()
    (project / ".env").write_text("WATCHSKILL_FRAME_CAP=42\n", encoding="utf-8")
    monkeypatch.chdir(project)
    reset_settings()
    assert get_settings().frame_cap == 42

    monkeypatch.setenv("WATCHSKILL_FRAME_CAP", "77")
    reset_settings()
    assert get_settings().frame_cap == 77


def test_secrets_are_not_leaked_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_GROQ_API_KEY", "sk-super-secret")
    reset_settings()
    settings = get_settings()
    assert "sk-super-secret" not in repr(settings)
    assert settings.groq_api_key is not None
    assert settings.groq_api_key.get_secret_value() == "sk-super-secret"


def test_settings_singleton_and_reset() -> None:
    assert get_settings() is get_settings()
    first = get_settings()
    reset_settings()
    assert get_settings() is not first


def test_settings_type_is_importable_directly() -> None:
    assert isinstance(Settings(), Settings)


def test_legacy_data_dir_migrates_to_new_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A pre-rename ~/.agentvision/ moves to ~/.watch-skill/ (default dir only)."""
    from watch_skill.config import _migrate_legacy_data_dir

    fake_home = tmp_path / "home dir"
    fake_home.mkdir()
    legacy = fake_home / ".agentvision"
    legacy.mkdir()
    (legacy / "index.db").write_text("payload", encoding="utf-8")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    _migrate_legacy_data_dir(Settings(data_dir=fake_home / ".watch-skill"))

    assert not legacy.exists()
    new_dir = fake_home / ".watch-skill"
    assert (new_dir / "index.db").read_text(encoding="utf-8") == "payload"


def test_legacy_migration_never_touches_explicit_data_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from watch_skill.config import _migrate_legacy_data_dir

    fake_home = tmp_path / "home dir"
    fake_home.mkdir()
    legacy = fake_home / ".agentvision"
    legacy.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))

    custom = tmp_path / "explicit data dir"
    _migrate_legacy_data_dir(Settings(data_dir=custom))

    assert legacy.exists()
    assert not custom.exists()
