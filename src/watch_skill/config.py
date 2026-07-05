"""Single typed configuration for the whole engine.

Precedence (highest wins): CLI flag (surfaces pass overrides explicitly) >
process environment > ``.env`` in the current working directory > defaults.
All environment variables use the ``WATCHSKILL_`` prefix, e.g.
``WATCHSKILL_FRAME_WIDTH=1024``.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed settings for Watch Skill. See module docstring for precedence."""

    model_config = SettingsConfigDict(
        env_prefix="WATCHSKILL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- storage ---------------------------------------------------------
    data_dir: Path = Field(
        default_factory=lambda: Path.home() / ".watch-skill",
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
    diarization_enabled: bool = Field(
        default=False,
        description="Label transcript segments by speaker (needs the diarize extra + HF token).",
    )
    huggingface_token: SecretStr | None = Field(
        default=None, description="Hugging Face token for gated pyannote diarization models."
    )

    # --- API keys (provider-scoped; never logged) -------------------------
    anthropic_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    groq_api_key: SecretStr | None = None
    openrouter_api_key: SecretStr | None = None
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
    vision_batch_size: int = Field(
        default=8,
        description="Frames per describe_frames call. Lower (2-4) for small local models.",
    )
    vision_timeout_seconds: float = Field(
        default=180.0, description="HTTP timeout for cloud vision calls."
    )
    vision_local_timeout_seconds: float = Field(
        default=900.0,
        description="Timeout for local (Ollama) vision calls — CPU model loads take minutes.",
    )
    critic_frame_cap: int = Field(
        default=10,
        description="Max frames sent to the loop critic in one call. Lower (4) for local models.",
    )

    # --- self-healing answers (v0.6) ----------------------------------------
    answer_confidence_floor: float = Field(
        default=0.35,
        description="Below this after the full escalation ladder, the answer "
        "states plainly that the video does not clearly show it (honest floor).",
    )
    answer_confidence_target: float = Field(
        default=0.6,
        description="Escalation stops as soon as confidence clears this bar.",
    )
    answer_verify_enabled: bool = Field(
        default=True,
        description="When a vision provider is configured, show the model the "
        "frames it is about to cite and require confirmation before answering.",
    )
    answer_token_budget: int = Field(
        default=8000,
        description="Per-question token ceiling; the escalation ladder stops "
        "(and says so) rather than exceed it.",
    )
    answer_resample_width: float = Field(
        default=8.0,
        description="Window (seconds) around a candidate timestamp for the "
        "dense re-sampling escalation step.",
    )
    answer_resample_resolution: int = Field(
        default=1024,
        description="Frame width (px) for escalation re-sampling — higher than "
        "the indexing default so zoom crops have pixels to work with.",
    )
    answer_cache_enabled: bool = Field(
        default=True, description="Semantic answer cache (per video)."
    )
    answer_cache_similarity: float = Field(
        default=0.92,
        description="Cosine similarity above which a cached question counts as "
        "a repeat and its answer is returned at zero model cost.",
    )
    lessons_enabled: bool = Field(
        default=True,
        description="Local lessons store: learn from reported mistakes and "
        "inject relevant guidance into future asks. Never uploaded anywhere.",
    )
    lessons_injection_token_cap: int = Field(
        default=300,
        description="Max prompt tokens the injected 'learned corrections' "
        "section may consume.",
    )
    lessons_max_count: int = Field(
        default=500,
        description="Global cap on stored lessons; least-recently-used pruned.",
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

    @property
    def lessons_path(self) -> Path:
        return self.data_dir / "lessons.db"

    @property
    def evals_dir(self) -> Path:
        return self.data_dir / "evals"


def _migrate_legacy_data_dir(settings: Settings) -> None:
    """One-time move of a pre-rename ``~/.agentvision/`` dir to ``~/.watch-skill/``.

    Only fires for the default data dir: an explicit WATCHSKILL_DATA_DIR (or
    an already-populated new dir) is never touched.
    """
    if settings.data_dir != Path.home() / ".watch-skill":
        return
    legacy = Path.home() / ".agentvision"
    if legacy.is_dir() and not settings.data_dir.exists():
        import shutil  # noqa: PLC0415

        shutil.move(str(legacy), str(settings.data_dir))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton. Tests call :func:`reset_settings`."""
    settings = Settings()
    _migrate_legacy_data_dir(settings)
    return settings


def reset_settings() -> None:
    """Clear the cached settings (tests / after env mutation)."""
    get_settings.cache_clear()
