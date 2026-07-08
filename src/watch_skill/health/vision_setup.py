"""Configure a vision backend by writing provider settings into the project .env.

Two first-class backends:

- **Gemini** — free tier (~1500 requests/day), strong quality, zero local
  compute. The recommended zero-cost default. Needs an API key
  (``WATCHSKILL_GEMINI_API_KEY``).
- **Ollama** — fully offline, local, no key. Larger download, slower on CPU.
  The privacy/air-gapped option.

Both write the ``WATCHSKILL_VISION_*`` settings (and, for Gemini, the key) so
the engine picks them up on the next run. The existing ``.env`` is backed up
before any change, and unrelated keys are preserved.
"""
from __future__ import annotations

import json
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path

from watch_skill.errors import ConfigError

# Recommended free-tier Gemini model (covers both tiers; see registry prices).
DEFAULT_GEMINI_CHEAP = "gemini-2.0-flash"
DEFAULT_GEMINI_STRONG = "gemini-2.0-flash"

# Default local vision model. llava:7b is multi-image + instruction-following
# capable and universally available in the Ollama registry; moondream is a
# faster, lighter (lower-quality) alternative for slow CPUs.
DEFAULT_OLLAMA_MODEL = "llava:7b"


# --- .env editing ----------------------------------------------------------

def env_path() -> Path:
    """The .env the engine loads (CWD-relative, matching pydantic-settings)."""
    return Path(".env").resolve()


def set_env_vars(updates: dict[str, str], path: Path | None = None) -> tuple[Path, Path | None]:
    """Idempotently set ``KEY=VALUE`` lines in .env.

    Backs up any existing file first, rewrites keys in place, appends new ones,
    and leaves every unrelated line untouched. Returns (env_path, backup_path).
    """
    path = path or env_path()
    backup: Path | None = None
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    if path.is_file():
        backup = path.with_name(f"{path.name}.backup-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, backup)

    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    out.extend(f"{k}={v}" for k, v in remaining.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")
    return path, backup


# --- Gemini ----------------------------------------------------------------

def configure_gemini(
    api_key: str,
    cheap_model: str = DEFAULT_GEMINI_CHEAP,
    strong_model: str = DEFAULT_GEMINI_STRONG,
    path: Path | None = None,
) -> tuple[Path, Path | None]:
    """Write the Gemini provider + key into .env (recommended zero-cost default)."""
    if not api_key or not api_key.strip():
        raise ConfigError(
            "a Gemini API key is required",
            code="config.vision_no_key",
            fix="get a free key at https://aistudio.google.com/apikey and pass --api-key",
        )
    return set_env_vars(
        {
            "WATCHSKILL_GEMINI_API_KEY": api_key.strip(),
            "WATCHSKILL_VISION_CHEAP_PROVIDER": "gemini",
            "WATCHSKILL_VISION_CHEAP_MODEL": cheap_model,
            "WATCHSKILL_VISION_STRONG_PROVIDER": "gemini",
            "WATCHSKILL_VISION_STRONG_MODEL": strong_model,
        },
        path,
    )


# --- Ollama ----------------------------------------------------------------

def _ollama_get(base_url: str, route: str, timeout: float = 3.0) -> dict | None:
    url = base_url.rstrip("/") + route
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def ollama_running(base_url: str = "http://127.0.0.1:11434") -> bool:
    """True if an Ollama server answers on ``base_url``."""
    return _ollama_get(base_url, "/api/version") is not None


def ollama_models(base_url: str = "http://127.0.0.1:11434") -> list[str]:
    """Model tags currently pulled into the local Ollama, or []."""
    data = _ollama_get(base_url, "/api/tags")
    if not data:
        return []
    return [m.get("name", "") for m in data.get("models", []) if m.get("name")]


def configure_ollama(
    model: str = DEFAULT_OLLAMA_MODEL,
    base_url: str = "http://127.0.0.1:11434",
    path: Path | None = None,
) -> tuple[Path, Path | None]:
    """Write the Ollama provider + model into .env (offline, no key).

    Small local models can't hold many images in one prompt, so the vision
    batch size is pinned to 1 — describe one frame per call.
    """
    return set_env_vars(
        {
            "WATCHSKILL_VISION_CHEAP_PROVIDER": "ollama",
            "WATCHSKILL_VISION_CHEAP_MODEL": model,
            "WATCHSKILL_VISION_STRONG_PROVIDER": "ollama",
            "WATCHSKILL_VISION_STRONG_MODEL": model,
            "WATCHSKILL_VISION_BATCH_SIZE": "1",
            "WATCHSKILL_OLLAMA_BASE_URL": base_url,
        },
        path,
    )
