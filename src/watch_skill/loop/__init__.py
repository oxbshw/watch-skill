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
from watch_skill.loop.critic import (
    Critique,
    Issue,
    critique_recording,
    describe_critique,
    parse_critique,
)
from watch_skill.loop.diff import IterationDiff, align_frames, compare_issues, diff_iterations
from watch_skill.loop.framework import LoopType, get_loop_type, loop_type_names, register_loop_type
from watch_skill.loop.monitor import MonitorResult, loop_monitor
from watch_skill.loop.runner import (
    LoopState,
    loop_game,
    loop_iterate,
    loop_start,
    loop_status,
    loop_video_gen,
)

__all__ = [
    "CaptureResult",
    "Critique",
    "Issue",
    "IterationDiff",
    "LoopState",
    "LoopType",
    "MonitorResult",
    "align_frames",
    "capture",
    "capture_file",
    "capture_screen",
    "capture_url",
    "compare_issues",
    "critique_recording",
    "describe_critique",
    "diff_iterations",
    "get_loop_type",
    "loop_game",
    "loop_iterate",
    "loop_monitor",
    "loop_start",
    "loop_status",
    "loop_type_names",
    "loop_video_gen",
    "parse_critique",
    "register_loop_type",
]
