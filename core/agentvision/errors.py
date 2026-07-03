"""Structured errors: machine-actionable code + human message + suggested fix.

Every error an agent can see carries enough structure to act on it without
parsing prose. Surfaces serialize these via :meth:`AgentVisionError.to_dict`.
"""
from __future__ import annotations

from typing import Any


class AgentVisionError(Exception):
    """Base error for all AgentVision failures.

    Args:
        code: Stable machine-readable identifier, e.g. ``"acquire.download_failed"``.
        message: Human-readable description of what went wrong.
        fix: Suggested remediation an agent or user can act on.
        details: Extra structured context (source URL, exit codes, paths...).
    """

    default_code = "agentvision.error"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        fix: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code or self.default_code
        self.message = message
        self.fix = fix
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """Serialize for JSON surfaces (MCP tool errors, REST bodies)."""
        return {
            "error": self.code,
            "message": self.message,
            "fix": self.fix,
            "details": self.details,
        }

    def __str__(self) -> str:
        text = f"[{self.code}] {self.message}"
        if self.fix:
            text += f" | fix: {self.fix}"
        return text


class DependencyError(AgentVisionError):
    """A required external binary or package is missing or broken."""

    default_code = "health.dependency_missing"


class AcquisitionError(AgentVisionError):
    """Source acquisition failed after the full fallback chain."""

    default_code = "acquire.failed"


class PerceptionError(AgentVisionError):
    """Frame extraction / scene detection / OCR failed."""

    default_code = "perceive.failed"


class TranscriptionError(AgentVisionError):
    """Every rung of the transcription ladder failed."""

    default_code = "transcribe.failed"


class IndexError_(AgentVisionError):
    """Persistent index operation failed (name avoids builtin clash)."""

    default_code = "index.failed"


class VisionError(AgentVisionError):
    """Vision-model call failed or was blocked (e.g. cost guard)."""

    default_code = "vision.failed"


class LoopError(AgentVisionError):
    """Capture / critique / iterate loop failure."""

    default_code = "loop.failed"


class ConfigError(AgentVisionError):
    """Invalid or missing configuration."""

    default_code = "config.invalid"
