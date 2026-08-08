"""OpenAI-compatible vendors are data, not code.

The registry grew from six providers to sixteen without a new request
builder per vendor: they all speak `/chat/completions`, so host, key, and
price are the only differences and those are table entries. These tests hold
that line — a vendor added to the table must be reachable, and adding one
must not require touching client.py.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.config import reset_settings
from watch_skill.vision.client import _BUILDERS
from watch_skill.vision.registry import PROVIDERS, base_url_for

COMPATIBLE = sorted(n for n, s in PROVIDERS.items() if s.openai_compatible)


def test_the_table_actually_grew() -> None:
    """Guards against a refactor quietly dropping vendors."""
    assert len(COMPATIBLE) >= 11, f"only {len(COMPATIBLE)} compatible vendors: {COMPATIBLE}"
    for expected in ("groq", "together", "fireworks", "deepseek", "xai", "mistral", "custom"):
        assert expected in COMPATIBLE


def test_every_registry_entry_has_a_builder() -> None:
    """An entry with no builder is a provider that 404s at call time."""
    assert not set(PROVIDERS) - set(_BUILDERS)


@pytest.mark.parametrize("provider", COMPATIBLE)
def test_endpoint_is_a_real_https_url(provider: str) -> None:
    reset_settings()
    url = PROVIDERS[provider].endpoint.format(base=base_url_for(provider))
    assert url.endswith("/chat/completions")
    assert url.startswith("https://") or provider == "custom"
    assert "{" not in url, "an unformatted placeholder survived"


@pytest.mark.parametrize("provider", COMPATIBLE)
def test_wire_format_matches_openai(provider: str, tmp_path: Path) -> None:
    """Same body and bearer auth as OpenAI — that is the whole premise."""
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"\xff\xd8\xffabc")
    reset_settings()

    build, _extract = _BUILDERS[provider]
    url, headers, body = build("some-model", "test-key", "describe this", [frame])

    assert headers["Authorization"] == "Bearer test-key"
    assert body["model"] == "some-model"
    content = body["messages"][0]["content"]
    assert any(part.get("type") == "image_url" for part in content), "no image in the payload"
    assert any(part.get("type") == "text" for part in content), "no prompt in the payload"
    assert url == PROVIDERS[provider].endpoint.format(base=base_url_for(provider))


@pytest.mark.parametrize(
    ("provider", "env", "override"),
    [
        ("qwen", "WATCHSKILL_QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ("custom", "WATCHSKILL_CUSTOM_BASE_URL", "http://127.0.0.1:1234/v1"),
        ("minimax", "WATCHSKILL_MINIMAX_BASE_URL", "https://api.minimaxi.com/v1"),
    ],
)
def test_base_url_can_be_repointed(
    provider: str, env: str, override: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regional hosts, proxies, and self-hosted servers use the same entry."""
    monkeypatch.setenv(env, override)
    reset_settings()
    assert base_url_for(provider) == override


def test_a_trailing_slash_does_not_double_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """Users paste URLs with trailing slashes; //chat/completions 404s."""
    monkeypatch.setenv("WATCHSKILL_CUSTOM_BASE_URL", "http://localhost:8000/v1/")
    reset_settings()
    url = PROVIDERS["custom"].endpoint.format(base=base_url_for("custom"))
    assert "//chat" not in url
    assert url == "http://localhost:8000/v1/chat/completions"


def test_an_empty_setting_falls_back_to_the_registry_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WATCHSKILL_GROQ_BASE_URL", "")
    reset_settings()
    assert base_url_for("groq") == PROVIDERS["groq"].default_base_url


def test_asking_a_non_compatible_provider_for_a_base_url_is_an_error() -> None:
    """anthropic and gemini have their own wire formats; silence would hide a bug."""
    for provider in ("anthropic", "gemini"):
        with pytest.raises(KeyError):
            base_url_for(provider)


@pytest.mark.parametrize("provider", COMPATIBLE)
def test_every_vendor_is_offered_by_setup_vision(provider: str) -> None:
    """A provider you cannot configure from the CLI is not really shipped."""
    from watch_skill.health.vision_setup import CLOUD_PROVIDER_BASE_URLS, CLOUD_PROVIDER_DEFAULTS

    assert provider in CLOUD_PROVIDER_DEFAULTS, f"{provider} missing from setup-vision"
    key_env, cheap, strong = CLOUD_PROVIDER_DEFAULTS[provider]
    assert key_env == f"WATCHSKILL_{provider.upper()}_API_KEY"
    assert cheap and strong, "both tiers need a default model"
    assert CLOUD_PROVIDER_BASE_URLS[provider] == PROVIDERS[provider].default_base_url
