"""Model lifecycle management.

Loading is single-flight, readiness is reportable, and idle models are
released — so a slow model degrades itself rather than the session around it.
"""
from __future__ import annotations

from watch_skill.models.lifecycle import (
    DEFAULT_IDLE_SECONDS,
    DEFAULT_LOAD_TIMEOUT,
    ManagedModel,
    ModelRegistry,
    ModelState,
    ModelStatus,
    ModelUnavailable,
    get_registry,
    lifecycle_reset_for_tests,
    register_builtin_models,
)

__all__ = [
    "DEFAULT_IDLE_SECONDS",
    "DEFAULT_LOAD_TIMEOUT",
    "ManagedModel",
    "ModelRegistry",
    "ModelState",
    "ModelStatus",
    "ModelUnavailable",
    "get_registry",
    "lifecycle_reset_for_tests",
    "register_builtin_models",
]
