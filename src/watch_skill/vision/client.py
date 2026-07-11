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
    settings = get_settings()
    endpoint = PROVIDERS["ollama"].endpoint.format(base=settings.ollama_base_url.rstrip("/"))
    # num_ctx sizes the compute buffer; a smaller window lets small vision
    # models load on a low-RAM machine instead of OOMing during startup.
    # temperature 0: describe/judge calls must be reproducible — a sampled
    # PASS/FAIL flipping between loop iterations is worse than useless.
    options: dict[str, Any] = {"num_ctx": settings.ollama_num_ctx, "temperature": 0}
    if settings.ollama_num_gpu is not None:
        options["num_gpu"] = settings.ollama_num_gpu
    body = {
        "model": model,
        "stream": False,
        "options": options,
        # A tight-RAM box may not manage to RELOAD the model mid-pipeline
        # (indexing makes dozens of calls minutes apart); keep it resident.
        "keep_alive": "30m",
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
        if self.provider == "ollama":
            from watch_skill.vision.local_health import ensure_ollama  # noqa: PLC0415

            ensure_ollama(get_settings().ollama_base_url)
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
                fix="401/403: check the API key setting; 404: check the model "
                "name against the provider's list; 429: wait or switch tier "
                "(WATCHSKILL_VISION_CHEAP_MODEL); 5xx: retry later",
                details={"body": exc.response.text[:500], "model": self.model},
            ) from exc
        except httpx.ConnectError as exc:
            if self.provider == "ollama":
                # it answered the health check, then died mid-call: one retry
                # after a restart, then a loud structured failure
                from watch_skill.vision.local_health import (  # noqa: PLC0415
                    ensure_ollama,
                    forget_liveness,
                )

                forget_liveness()
                ensure_ollama(get_settings().ollama_base_url)  # raises server_down if dead
                try:
                    response = httpx.post(
                        endpoint, headers=headers, json=body,
                        timeout=_timeout_for(self.provider),
                    )
                    response.raise_for_status()
                    text = extract(response.json())
                except httpx.HTTPError as retry_exc:
                    raise VisionError(
                        "the local vision server died mid-call and did not "
                        "recover after a restart",
                        code="vision.server_down",
                        fix="check RAM headroom (`watch-skill doctor`) — the "
                        "model may not fit right now; close something or use "
                        "a smaller num_ctx",
                        details={"model": self.model},
                    ) from retry_exc
            else:
                raise VisionError(
                    f"{self.provider} call failed: {exc}",
                    code="vision.call_failed",
                    fix=f"check network reachability of {self.provider}'s endpoint, "
                    "then retry; `watch-skill doctor` verifies keys and connectivity",
                    details={"model": self.model},
                ) from exc
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            raise VisionError(
                f"{self.provider} call failed: {exc}",
                code="vision.call_failed",
                fix="usually transient (timeout or malformed response) — retry once; "
                "persistent failures: `watch-skill doctor` and check the provider status page",
                details={"model": self.model},
            ) from exc
        if not text.strip():
            raise VisionError(
                f"{self.provider} returned empty output",
                code="vision.empty",
                fix="local models return empty under RAM pressure or over-constrained "
                "prompts: check headroom (`watch-skill doctor`), lower "
                "WATCHSKILL_VISION_BATCH_SIZE to 1-4, or simplify the prompt",
            )
        return text.strip()
