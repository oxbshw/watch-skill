"""The Observer Loop: declare success first, let someone else decide it happened.

Public surface is deliberately small. Everything else in this package is
machinery that a caller should not have to reason about.
"""
from __future__ import annotations

from watch_skill.observer.db import get_run, list_runs
from watch_skill.observer.loop import (
    ObserverError,
    advance,
    approve_pending,
    cancel,
    start_run,
)
from watch_skill.observer.types import (
    OBSERVER_SCHEMA_VERSION,
    Budgets,
    CorrectionSpec,
    ObserverRun,
    ObserverState,
    VerificationAttempt,
)

__all__ = [
    "OBSERVER_SCHEMA_VERSION",
    "Budgets",
    "CorrectionSpec",
    "ObserverError",
    "ObserverRun",
    "ObserverState",
    "VerificationAttempt",
    "advance",
    "approve_pending",
    "cancel",
    "get_run",
    "list_runs",
    "start_run",
]
