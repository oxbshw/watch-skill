"""Configure any supported vision backend in the project ``.env``.

Cloud providers (Anthropic, OpenAI, Gemini, and OpenRouter) share one setup
path: provider key + cheap/strong model names. Ollama is the optional local,
keyless path. Agent integrations do not depend on this choice.

The existing ``.env`` is backed up before any change and unrelated values are
preserved.
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
DEFAULT_GEMINI_CHEAP = "gemini-3.5-flash"
DEFAULT_GEMINI_STRONG = "gemini-3.5-flash"

CLOUD_PROVIDER_DEFAULTS: dict[str, tuple[str, str, str]] = {
    # provider: (settings key, cheap model, strong model)
    "anthropic": (
        "WATCHSKILL_ANTHROPIC_API_KEY",
        "claude-haiku-4-5-20251001",
        "claude-sonnet-5",
    ),
    "openai": ("WATCHSKILL_OPENAI_API_KEY", "gpt-4o-mini", "gpt-4o"),
    "gemini": (
        "WATCHSKILL_GEMINI_API_KEY",
        DEFAULT_GEMINI_CHEAP,
        DEFAULT_GEMINI_STRONG,
    ),
    "openrouter": (
        "WATCHSKILL_OPENROUTER_API_KEY",
        "google/gemini-3.5-flash",
        "anthropic/claude-sonnet-5",
    ),
}

# Local vision models by machine size. qwen2.5vl:3b reads on-screen text well
# (crucial for the OCR-like describe + critic tasks), handles multiple images,
# and emits clean JSON — but its weights + vision projector need ~5 GB resident,
# which OOMs an 8 GB box. moondream (~1.7 GB) fits everywhere, at lower quality.
CAPABLE_OLLAMA_MODEL = "qwen2.5vl:3b"
LIGHT_OLLAMA_MODEL = "moondream"
DEFAULT_OLLAMA_MODEL = CAPABLE_OLLAMA_MODEL  # overridden by RAM on small machines


def total_ram_gb() -> float | None:
    """Total physical RAM in GiB, or None if it can't be determined."""
    import os

    try:
        if hasattr(os, "sysconf") and "SC_PHYS_PAGES" in os.sysconf_names:
            return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 1024**3
    except (ValueError, OSError):
        pass
    try:  # Windows
        import ctypes

        class _MemStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong)] + [
                (f, ctypes.c_ulonglong) for f in (
                    "ullTotalPhys", "ullAvailPhys", "ullTotalPageFile", "ullAvailPageFile",
                    "ullTotalVirtual", "ullAvailVirtual", "ullAvailExtendedVirtual",
                )
            ]

        stat = _MemStatus()
        stat.dwLength = ctypes.sizeof(stat)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
            return stat.ullTotalPhys / 1024**3
    except (AttributeError, OSError):
        pass
    return None


def recommend_ollama_model() -> str:
    """The capable model on a roomy machine, the light one on a small box.

    qwen2.5vl:3b needs ~5 GB resident; below ~12 GB total RAM we fall back to
    moondream so setup never hands the user a model that OOMs on first call."""
    ram = total_ram_gb()
    if ram is not None and ram < 12:
        return LIGHT_OLLAMA_MODEL
    return CAPABLE_OLLAMA_MODEL


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


# --- Cloud providers --------------------------------------------------------

def configure_cloud(
    provider: str,
    api_key: str,
    cheap_model: str | None = None,
    strong_model: str | None = None,
    path: Path | None = None,
) -> tuple[Path, Path | None]:
    """Write one supported cloud provider, its key, and model tiers."""
    provider = provider.lower().strip()
    defaults = CLOUD_PROVIDER_DEFAULTS.get(provider)
    if defaults is None:
        supported = ", ".join(CLOUD_PROVIDER_DEFAULTS)
        raise ConfigError(
            f"unsupported cloud vision provider: {provider or '(empty)'}",
            code="config.vision_unknown_provider",
            fix=f"choose one of: {supported}; use configure_ollama for local vision",
        )
    if not api_key or not api_key.strip():
        raise ConfigError(
            f"an API key is required for {provider}",
            code="config.vision_no_key",
            fix=f"set {defaults[0]} or pass --api-key",
        )
    key_name, default_cheap, default_strong = defaults
    return set_env_vars(
        {
            key_name: api_key.strip(),
            "WATCHSKILL_VISION_CHEAP_PROVIDER": provider,
            "WATCHSKILL_VISION_CHEAP_MODEL": cheap_model or default_cheap,
            "WATCHSKILL_VISION_STRONG_PROVIDER": provider,
            "WATCHSKILL_VISION_STRONG_MODEL": strong_model or default_strong,
        },
        path,
    )


# Compatibility helper retained for callers that already use it directly.

def configure_gemini(
    api_key: str,
    cheap_model: str = DEFAULT_GEMINI_CHEAP,
    strong_model: str = DEFAULT_GEMINI_STRONG,
    path: Path | None = None,
) -> tuple[Path, Path | None]:
    """Write Gemini settings (compatibility wrapper around configure_cloud)."""
    return configure_cloud(
        "gemini",
        api_key,
        cheap_model=cheap_model,
        strong_model=strong_model,
        path=path,
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


def recommend_num_ctx() -> int:
    """Ollama context window sized to fit the machine's RAM.

    The model's compute buffer scales with num_ctx; on a ~8 GB box the 2048
    default OOMs during load — measured on the dev box: 768 loads reliably
    even under heavy memory pressure, 1024+ only when the box is quiet. 768
    still covers one image plus the prompt. Roomy machines keep the larger
    window."""
    ram = total_ram_gb()
    if ram is not None and ram < 10:
        return 768
    return 2048


def configure_ollama(
    model: str = DEFAULT_OLLAMA_MODEL,
    base_url: str = "http://127.0.0.1:11434",
    num_ctx: int | None = None,
    path: Path | None = None,
) -> tuple[Path, Path | None]:
    """Write the Ollama provider + model into .env (offline, no key).

    Small local models can't hold many images in one prompt, so the vision
    batch size is pinned to 1 — describe one frame per call — and num_ctx is
    sized to the machine so the model loads instead of OOMing.
    """
    return set_env_vars(
        {
            "WATCHSKILL_VISION_CHEAP_PROVIDER": "ollama",
            "WATCHSKILL_VISION_CHEAP_MODEL": model,
            "WATCHSKILL_VISION_STRONG_PROVIDER": "ollama",
            "WATCHSKILL_VISION_STRONG_MODEL": model,
            "WATCHSKILL_VISION_BATCH_SIZE": "1",
            "WATCHSKILL_CRITIC_FRAME_CAP": "4",  # fewer frames per critique on CPU
            "WATCHSKILL_OLLAMA_BASE_URL": base_url,
            "WATCHSKILL_OLLAMA_NUM_CTX": str(num_ctx if num_ctx is not None else recommend_num_ctx()),
        },
        path,
    )
