"""Provider registry — DATA, not code. Adding a model is an entry, not a class.

Prices are per million input tokens (USD) and deliberately conservative
(over-estimates); they exist for the cost guard, not for billing accuracy.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ProviderSpec:
    """How to reach one vision provider."""

    name: str
    endpoint: str
    key_setting: str | None  # Settings field holding the API key (None = keyless/local)
    default_price_per_mtok: float
    # Most vendors speak OpenAI's /chat/completions wire format and differ
    # only in host and auth. Those get `openai_compatible=True` and a default
    # base URL, so adding one is an entry in the table below rather than a
    # new request builder. `base_url_setting` lets a user point the same
    # entry at a regional host, a proxy, or a self-hosted server.
    openai_compatible: bool = False
    default_base_url: str = ""
    base_url_setting: str | None = None


def _openai_compatible(
    name: str, base_url: str, key_setting: str, price: float
) -> ProviderSpec:
    return ProviderSpec(
        name=name,
        endpoint="{base}/chat/completions",
        key_setting=key_setting,
        default_price_per_mtok=price,
        openai_compatible=True,
        default_base_url=base_url,
        base_url_setting=f"{name}_base_url",
    )


PROVIDERS: dict[str, ProviderSpec] = {
    "anthropic": ProviderSpec(
        name="anthropic",
        endpoint="https://api.anthropic.com/v1/messages",
        key_setting="anthropic_api_key",
        default_price_per_mtok=3.0,
    ),
    "openai": ProviderSpec(
        name="openai",
        endpoint="https://api.openai.com/v1/chat/completions",
        key_setting="openai_api_key",
        default_price_per_mtok=2.5,
    ),
    "gemini": ProviderSpec(
        name="gemini",
        endpoint="https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        key_setting="gemini_api_key",
        default_price_per_mtok=1.25,
    ),
    "openrouter": ProviderSpec(
        name="openrouter",
        endpoint="https://openrouter.ai/api/v1/chat/completions",
        key_setting="openrouter_api_key",
        default_price_per_mtok=3.0,
    ),
    # --- OpenAI-compatible vendors -----------------------------------------
    # Each is one line because the wire format is identical; only host, key,
    # and price differ. Prices are conservative defaults — prices.json
    # overrides per model.
    "minimax": _openai_compatible("minimax", "https://api.minimax.io/v1", "minimax_api_key", 0.6),
    "groq": _openai_compatible("groq", "https://api.groq.com/openai/v1", "groq_api_key", 0.4),
    "together": _openai_compatible(
        "together", "https://api.together.xyz/v1", "together_api_key", 0.9
    ),
    "fireworks": _openai_compatible(
        "fireworks", "https://api.fireworks.ai/inference/v1", "fireworks_api_key", 0.9
    ),
    "deepseek": _openai_compatible(
        "deepseek", "https://api.deepseek.com/v1", "deepseek_api_key", 0.3
    ),
    "xai": _openai_compatible("xai", "https://api.x.ai/v1", "xai_api_key", 2.0),
    "mistral": _openai_compatible(
        "mistral", "https://api.mistral.ai/v1", "mistral_api_key", 0.2
    ),
    "moonshot": _openai_compatible(
        "moonshot", "https://api.moonshot.ai/v1", "moonshot_api_key", 0.6
    ),
    "zai": _openai_compatible("zai", "https://api.z.ai/api/paas/v4", "zai_api_key", 0.6),
    "qwen": _openai_compatible(
        "qwen",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "qwen_api_key",
        0.8,
    ),
    # Anything else that speaks the same format: vLLM, LM Studio, llama.cpp,
    # LiteLLM, Azure OpenAI, a company gateway. Point custom_base_url at it.
    # Requested twice by contributors before it existed.
    "custom": _openai_compatible("custom", "http://127.0.0.1:8000/v1", "custom_api_key", 0.0),
    "ollama": ProviderSpec(
        name="ollama",
        endpoint="{base}/api/chat",  # base from settings.ollama_base_url
        key_setting=None,
        default_price_per_mtok=0.0,
    ),
}


def base_url_for(provider: str) -> str:
    """The base URL for an OpenAI-compatible provider, user override first."""
    from watch_skill.config import get_settings

    spec = PROVIDERS[provider]
    if not spec.openai_compatible:
        raise KeyError(f"{provider} is not an OpenAI-compatible provider")
    configured = getattr(get_settings(), spec.base_url_setting or "", None)
    return str(configured or spec.default_base_url).rstrip("/")

# Model-specific price overrides live in prices.json next to this file —
# a dated, auditable data file (edit it, not code, when a provider
# reprices; move its as_of date with every edit).
_PRICES_PATH = Path(__file__).with_name("prices.json")


@lru_cache(maxsize=1)
def price_table() -> dict[str, Any]:
    """The dated price data file: {as_of, unit, usd_per_mtok: {model: price}}."""
    return json.loads(_PRICES_PATH.read_text(encoding="utf-8"))


def price_for(provider: str, model: str) -> float:
    spec = PROVIDERS[provider]
    prices: dict[str, float] = price_table()["usd_per_mtok"]
    return prices.get(model, spec.default_price_per_mtok)


# Compatibility alias (same object the loader returns, so edits to it are
# seen by price_for): the pre-v1.0 name for the overrides table.
MODEL_PRICES: dict[str, float] = price_table()["usd_per_mtok"]
