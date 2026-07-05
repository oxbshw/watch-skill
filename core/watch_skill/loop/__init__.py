"""THE LOOP: Act -> Capture -> Watch -> Critique -> (agent fixes) -> Iterate.

Capture (Playwright URL sessions, gdigrab screen/window, adopted files),
structured-JSON critic on the strong vision tier, phash-aligned diff engine,
persistent iteration runner, and the before/after proof artifact.
"""

from watch_skill.loop.capture import (
    CaptureResult,
    capture,
    capture_file,
    capture_screen,
    capture_url,
)
from watch_skill.loop.critic import Critique, Issue, critique_recording, parse_critique
from watch_skill.loop.diff import IterationDiff, align_frames, compare_issues, diff_iterations
from watch_skill.loop.runner import LoopState, loop_iterate, loop_start, loop_status

__all__ = [
    "CaptureResult",
    "Critique",
    "Issue",
    "IterationDiff",
    "LoopState",
    "align_frames",
    "capture",
    "capture_file",
    "capture_screen",
    "capture_url",
    "compare_issues",
    "critique_recording",
    "diff_iterations",
    "loop_iterate",
    "loop_start",
    "loop_status",
    "parse_critique",
]
