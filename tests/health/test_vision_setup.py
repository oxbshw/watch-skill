"""Vision-backend setup: .env editing, Gemini + Ollama configuration, probes.

Live vision calls are exercised separately (integration, needs a real
backend); here we prove the config plumbing is correct and non-destructive.
"""
from __future__ import annotations

from pathlib import Path

from watch_skill.health import vision_setup as vs


def test_set_env_vars_creates_file_with_values(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    path, backup = vs.set_env_vars({"WATCHSKILL_A": "1", "WATCHSKILL_B": "two"}, path=env)
    assert backup is None
    text = env.read_text(encoding="utf-8")
    assert "WATCHSKILL_A=1" in text and "WATCHSKILL_B=two" in text


def test_set_env_vars_preserves_others_and_backs_up(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("WATCHSKILL_KEEP=keepme\nWATCHSKILL_A=old\n", encoding="utf-8")
    path, backup = vs.set_env_vars({"WATCHSKILL_A": "new"}, path=env)
    text = env.read_text(encoding="utf-8")
    assert "WATCHSKILL_KEEP=keepme" in text          # untouched
    assert "WATCHSKILL_A=new" in text                # updated in place
    assert text.count("WATCHSKILL_A=") == 1          # not duplicated
    assert backup is not None and backup.is_file()
    assert "WATCHSKILL_A=old" in backup.read_text(encoding="utf-8")  # backup has the pre-change


def test_configure_gemini_writes_provider_and_key(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    vs.configure_gemini("SECRET123", path=env)
    text = env.read_text(encoding="utf-8")
    assert "WATCHSKILL_GEMINI_API_KEY=SECRET123" in text
    assert "WATCHSKILL_VISION_CHEAP_PROVIDER=gemini" in text
    assert "WATCHSKILL_VISION_STRONG_PROVIDER=gemini" in text
    assert f"WATCHSKILL_VISION_STRONG_MODEL={vs.DEFAULT_GEMINI_STRONG}" in text


def test_configure_gemini_rejects_empty_key(tmp_path: Path) -> None:
    import pytest

    from watch_skill.errors import ConfigError

    with pytest.raises(ConfigError):
        vs.configure_gemini("   ", path=tmp_path / ".env")


def test_configure_ollama_pins_batch_size_one(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    vs.configure_ollama(model="llava:7b", path=env)
    text = env.read_text(encoding="utf-8")
    assert "WATCHSKILL_VISION_CHEAP_PROVIDER=ollama" in text
    assert "WATCHSKILL_VISION_CHEAP_MODEL=llava:7b" in text
    assert "WATCHSKILL_VISION_BATCH_SIZE=1" in text  # small models: one image per call


def test_ollama_probes_are_falsey_when_down() -> None:
    """Against a definitely-dead port, the probes degrade to False/[] (no raise)."""
    dead = "http://127.0.0.1:1"
    assert vs.ollama_running(dead) is False
    assert vs.ollama_models(dead) == []


def test_configure_gemini_does_not_leak_key_into_backup_on_first_write(tmp_path: Path) -> None:
    """First write has no prior file, so no backup can contain the key."""
    env = tmp_path / ".env"
    _, backup = vs.configure_gemini("TOPSECRET", path=env)
    assert backup is None


def test_recommend_model_falls_back_to_light_on_small_ram(monkeypatch) -> None:
    monkeypatch.setattr(vs, "total_ram_gb", lambda: 8.0)
    assert vs.recommend_ollama_model() == vs.LIGHT_OLLAMA_MODEL


def test_recommend_model_uses_capable_on_roomy_ram(monkeypatch) -> None:
    monkeypatch.setattr(vs, "total_ram_gb", lambda: 32.0)
    assert vs.recommend_ollama_model() == vs.CAPABLE_OLLAMA_MODEL


def test_recommend_model_defaults_capable_when_ram_unknown(monkeypatch) -> None:
    monkeypatch.setattr(vs, "total_ram_gb", lambda: None)
    assert vs.recommend_ollama_model() == vs.CAPABLE_OLLAMA_MODEL


def test_total_ram_gb_is_plausible_on_this_machine() -> None:
    ram = vs.total_ram_gb()
    assert ram is None or 0.5 < ram < 4096  # sane bound if detected at all


def test_recommend_num_ctx_shrinks_on_small_ram(monkeypatch) -> None:
    monkeypatch.setattr(vs, "total_ram_gb", lambda: 8.0)
    assert vs.recommend_num_ctx() == 768  # small window so the model loads
    monkeypatch.setattr(vs, "total_ram_gb", lambda: 32.0)
    assert vs.recommend_num_ctx() == 2048


def test_configure_ollama_writes_num_ctx(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(vs, "total_ram_gb", lambda: 8.0)
    env = tmp_path / ".env"
    vs.configure_ollama(model="moondream", path=env)
    text = env.read_text(encoding="utf-8")
    assert "WATCHSKILL_OLLAMA_NUM_CTX=768" in text
    assert "WATCHSKILL_CRITIC_FRAME_CAP=4" in text  # CPU-friendly critique size
