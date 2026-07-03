"""Single typed configuration for the whole engine.

Precedence (highest wins): CLI flag (surfaces pass overrides explicitly) >
process environment > ``.env`` in the current working directory > defaults.
All environment variables use the ``AGENTVISION_`` prefix, e.g.
``AGENTVISION_FRAME_WIDTH=1024``.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed settings for AgentVision. See module docstring for precedence."""

    model_config = SettingsConfigDict(
        env_prefix="AGENTVISION_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- storage ---------------------------------------------------------
    data_dir: Path = Field(
        default_factory=lambda: Path.home() / ".agentvision",
        description="Root for cache, index, loops, health log, managed binaries.",
    )
    bin_dir: Path | None = Field(
        default=None,
        description="Managed portable-binaries dir. Default: <data_dir>/bin.",
    )
    cache_max_bytes: int = Field(
        default=20 * 1024**3,
        description="Download-cache size cap; LRU eviction beyond this.",
    )

    # --- perception (defaults inherited from the reference project) ------
    frame_width: int = Field(default=512, description="Extracted frame width in px.")
    frame_cap: int = Field(default=100, description="Hard cap on frames per analysis.")
    max_fps: float = Field(default=2.0, description="Universal sampling rate cap.")
    phash_distance: int = Field(
        default=6, description="Max Hamming distance for perceptual-hash dedup."
    )
    ocr_enabled: bool = Field(default=True, description="Run OCR on kept frames.")

    # --- transcription ----------------------------------------------------
    subtitle_langs: str = Field(
        default="en.*", description="yt-dlp --sub-langs pattern for captions."
    )
    local_whisper_enabled: bool = Field(
        default=True, description="Use local faster-whisper as the default fallback."
    )
    whisper_model: str = Field(
        default="auto", description="faster-whisper model size, or 'auto' by RAM/VRAM."
    )
    cloud_stt_enabled: bool = Field(
        default=False,
        description="OPT-IN: allow sending extracted audio to a cloud STT API. "
        "The video file itself NEVER leaves the machine regardless.",
    )

    # --- API keys (provider-scoped; never logged) -------------------------
    anthropic_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    groq_api_key: SecretStr | None = None
    ollama_base_url: str = "http://127.0.0.1:11434"

    # --- vision tiers ------------------------------------------------------
    vision_cheap_provider: str = Field(
        default="anthropic", description="Provider for bulk scene descriptions."
    )
    vision_cheap_model: str = Field(default="claude-haiku-4-5-20251001")
    vision_strong_provider: str = Field(
        default="anthropic", description="Provider for final answers and critiques."
    )
    vision_strong_model: str = Field(default="claude-sonnet-5")
    cost_ceiling_usd: float = Field(
        default=1.0, description="Warn/abort ceiling for a single cloud vision call."
    )

    # --- surfaces ----------------------------------------------------------
    response_frame_cap: int = Field(
        default=12, description="Max image blocks per MCP/REST response."
    )
    api_bearer_token: SecretStr | None = Field(
        default=None, description="Bearer token for the REST API. None = local only."
    )

    # --- derived paths ------------------------------------------------------
    @property
    def resolved_bin_dir(self) -> Path:
        """Managed binaries dir (created on demand by health.binaries)."""
        return self.bin_dir if self.bin_dir is not None else self.data_dir / "bin"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def index_path(self) -> Path:
        return self.data_dir / "index.db"

    @property
    def loops_dir(self) -> Path:
        return self.data_dir / "loops"

    @property
    def health_log_path(self) -> Path:
        return self.data_dir / "health.jsonl"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton. Tests call :func:`reset_settings`."""
    return Settings()


def reset_settings() -> None:
    """Clear the cached settings (tests / after env mutation)."""
    get_settings.cache_clear()
