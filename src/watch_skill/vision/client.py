"""One VisionClient, four wire formats. Provider choice is config, not code.

The engine's needs reduce to a single primitive — "prompt + images -> text" —
so each provider is just a request builder + response extractor pair around
httpx. The cost guard runs before every non-local call.
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from watch_skill.config import get_settings
from watch_skill.errors import VisionError
from watch_skill.vision.cost import guard_cost
from watch_skill.vision.registry import PROVIDERS

_MAX_TOKENS = 1500


def _timeout_for(provider: str) -> float:
    """Cloud calls get the standard timeout; local inference (Ollama on CPU)
    can legitimately take minutes to load a model, so it gets its own knob."""
    settings = get_settings()
    if provider == "ollama":
        return settings.vision_local_timeout_seconds
    return settings.vision_timeout_seconds


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _media_type(path: Path) -> str:
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def _anthropic_request(model: str, key: str, prompt: str, images: list[Path]) -> tuple[str, dict, dict]:
    content: list[dict[str, Any]] = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": _media_type(p), "data": _b64(p)},
        }
        for p in images
    ]
    content.append({"type": "text", "text": prompt})
    body = {
        "model": model,
        "max_tokens": _MAX_TOKENS,
        "messages": [{"role": "user", "content": content}],
    }
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    return PROVIDERS["anthropic"].endpoint, headers, body


def _anthropic_extract(data: dict) -> str:
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def _openai_request(model: str, key: str, prompt: str, images: list[Path]) -> tuple[str, dict, dict]:
    content: list[dict[str, Any]] = [
        {
            "type": "image_url",
            "image_url": {"url": f"data:{_media_type(p)};base64,{_b64(p)}"},
        }
        for p in images
    ]
    content.append({"type": "text", "text": prompt})
    body = {
        "model": model,
        "max_tokens": _MAX_TOKENS,
        "messages": [{"role": "user", "content": content}],
    }
    return PROVIDERS["openai"].endpoint, {"Authorization": f"Bearer {key}"}, body


def _openai_extract(data: dict) -> str:
    return data["choices"][0]["message"]["content"] or ""


def _openrouter_request(model: str, key: str, prompt: str, images: list[Path]) -> tuple[str, dict, dict]:
    # OpenAI-compatible wire format; only the endpoint, auth, and attribution
    # headers differ (OpenRouter asks for Referer/Title to identify the app).
    _, headers, body = _openai_request(model, key, prompt, images)
    headers["HTTP-Referer"] = "https://github.com/oxbshw/watch-skill"
    headers["X-Title"] = "Watch Skill"
    return PROVIDERS["openrouter"].endpoint, headers, body


def _gemini_request(model: str, key: str, prompt: str, images: list[Path]) -> tuple[str, dict, dict]:
    parts: list[dict[str, Any]] = [
        {"inline_data": {"mime_type": _media_type(p), "data": _b64(p)}} for p in images
    ]
    parts.append({"text": prompt})
    endpoint = PROVIDERS["gemini"].endpoint.format(model=model)
    body = {"contents": [{"parts": parts}]}
    return endpoint, {"x-goog-api-key": key}, body


def _gemini_extract(data: dict) -> str:
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts)


def _ollama_request(model: str, key: str, prompt: str, images: list[Path]) -> tuple[str, dict, dict]:
    endpoint = PROVIDERS["ollama"].endpoint.format(base=get_settings().ollama_base_url.rstrip("/"))
    body = {
        "model": model,
        "stream": False,
        "messages": [{"role": "user", "content": prompt, "images": [_b64(p) for p in images]}],
    }
    return endpoint, {}, body


def _ollama_extract(data: dict) -> str:
    return data.get("message", {}).get("content", "")


_BUILDERS: dict[str, tuple[Callable, Callable]] = {
    "anthropic": (_anthropic_request, _anthropic_extract),
    "openai": (_openai_request, _openai_extract),
    "openrouter": (_openrouter_request, _openai_extract),
    "gemini": (_gemini_request, _gemini_extract),
    "ollama": (_ollama_request, _ollama_extract),
}


@dataclass
class VisionClient:
    """prompt + images -> text, for one (provider, model) pair."""

    provider: str
    model: str

    def _api_key(self) -> str:
        spec = PROVIDERS[self.provider]
        if spec.key_setting is None:
            return ""
        key = getattr(get_settings(), spec.key_setting)
        if key is None or not key.get_secret_value().strip():
            raise VisionError(
                f"no API key configured for provider '{self.provider}'",
                code="vision.no_api_key",
                fix=f"set WATCHSKILL_{spec.key_setting.upper()}",
            )
        return key.get_secret_value().strip()

    def generate(self, prompt: str, images: list[Path] | None = None) -> str:
        """One vision call. Cost-guarded for cloud providers."""
        if self.provider not in _BUILDERS:
            raise VisionError(
                f"unknown vision provider: {self.provider}",
                code="vision.unknown_provider",
                fix=f"one of: {', '.join(sorted(_BUILDERS))}",
            )
        images = images or []
        guard_cost(self.provider, self.model, images)
        build, extract = _BUILDERS[self.provider]
        endpoint, headers, body = build(self.model, self._api_key(), prompt, images)
        try:
            response = httpx.post(
                endpoint, headers=headers, json=body, timeout=_timeout_for(self.provider)
            )
            response.raise_for_status()
            text = extract(response.json())
        except httpx.HTTPStatusError as exc:
            raise VisionError(
                f"{self.provider} returned HTTP {exc.response.status_code}",
                code="vision.http_error",
                details={"body": exc.response.text[:500], "model": self.model},
            ) from exc
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            raise VisionError(
                f"{self.provider} call failed: {exc}",
                code="vision.call_failed",
                details={"model": self.model},
            ) from exc
        if not text.strip():
            raise VisionError(f"{self.provider} returned empty output", code="vision.empty")
        return text.strip()
