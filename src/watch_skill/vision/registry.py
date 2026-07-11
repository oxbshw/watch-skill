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
