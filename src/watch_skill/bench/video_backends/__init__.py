"""Evaluating external video backends against Watch Skill's evidence model.

Benchmark code only. Nothing in the product imports from here, and nothing
here is a step toward shipping a vendor integration — the question this
package exists to answer is whether one would be justified.
"""
from watch_skill.bench.video_backends.types import (
    BackendCue,
    BackendFrame,
    Outcome,
    OutcomeStatus,
)

__all__ = ["BackendCue", "BackendFrame", "Outcome", "OutcomeStatus"]
