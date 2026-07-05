"""Provider registry — DATA, not code. Adding a model is an entry, not a class.

Prices are per million input tokens (USD) and deliberately conservative
(over-estimates); they exist for the cost guard, not for billing accuracy.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderSpec:
    """How to reach one vision provider."""

    name: str
    endpoint: str
    key_setting: str | None  # Settings field holding the API key (None = keyless/local)
    default_price_per_mtok: float


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
    "ollama": ProviderSpec(
        name="ollama",
        endpoint="{base}/api/chat",  # base from settings.ollama_base_url
        key_setting=None,
        default_price_per_mtok=0.0,
    ),
}

# Model-specific price overrides (USD per million input tokens).
MODEL_PRICES: dict[str, float] = {
    "claude-haiku-4-5-20251001": 1.0,
    "claude-sonnet-5": 3.0,
    "claude-fable-5": 15.0,
    "gpt-4o-mini": 0.15,
    "gemini-2.0-flash": 0.10,
    # OpenRouter routes many models; ":free" variants cost nothing.
    "qwen/qwen2.5-vl-72b-instruct:free": 0.0,
    "google/gemini-2.0-flash-exp:free": 0.0,
    "anthropic/claude-sonnet-4.5": 3.0,
}


def price_for(provider: str, model: str) -> float:
    spec = PROVIDERS[provider]
    return MODEL_PRICES.get(model, spec.default_price_per_mtok)
