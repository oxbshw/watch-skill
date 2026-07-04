"""Loop runner: Act -> Capture -> Watch -> Critique -> (agent fixes) -> Iterate.

The runner deliberately does NOT fix anything itself: it hands the structured
critique back to the calling agent, which changes code/UI and calls
``iterate`` again. Every iteration is persisted under
``<data_dir>/loops/<loop_id>/iter_<n>/`` (video, frames, critique, diff).

Stop conditions: verdict == pass, max_iterations reached, or no progress
(score not improving for 2 consecutive iterations).
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentvision.config import get_settings
from agentvision.errors import LoopError
from agentvision.loop.artifact import render_before_after
from agentvision.loop.capture import capture
from agentvision.loop.critic import Critique, Issue, critique_recording
from agentvision.loop.diff import diff_iterations
from agentvision.perceive import perceive
from agentvision.perceive.types import PerceptionResult

DEFAULT_MAX_ITERATIONS = 5
_NO_PROGRESS_WINDOW = 2


@dataclass
class LoopState:
    """Persistent state of one loop (state.json in the loop dir)."""

    loop_id: str
    target: str
    pass_criteria: str
    script: list[dict[str, Any]] | None
    max_iterations: int
    duration_seconds: float
    status: str = "running"  # running | passed | max_iterations | no_progress
    iterations: list[dict[str, Any]] = field(default_factory=list)

    @property
    def dir(self) -> Path:
        return get_settings().loops_dir / self.loop_id

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = {k: v for k, v in vars(self).items()}
        (self.dir / "state.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @classmethod
    def load(cls, loop_id: str) -> LoopState:
        path = get_settings().loops_dir / loop_id / "state.json"
        if not path.is_file():
            raise LoopError(
                f"unknown loop_id: {loop_id}",
                code="loop.not_found",
                fix="start one with loop_start; state lives under ~/.agentvision/loops",
            )
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(**data)


def _perceive_capture(video_path: Path, iter_dir: Path) -> PerceptionResult:
    return perceive(
        video_path, iter_dir / "frames", source_label=str(video_path), max_frames=24
    )


def _load_perception(iter_record: dict[str, Any]) -> PerceptionResult:
    """Rehydrate the minimal PerceptionResult needed for diffing."""
    from agentvision.perceive.types import Frame, VideoMetadata

    frames = [
        Frame(
            index=i, timestamp_seconds=f["timestamp_seconds"], path=Path(f["path"]),
            scene_id=f["scene_id"], phash=f["phash"], reason=f["reason"],
        )
        for i, f in enumerate(iter_record["perception"]["frames"])
    ]
    meta = VideoMetadata(**iter_record["perception"]["metadata"])
    return PerceptionResult(
        source=iter_record["perception"]["source"], metadata=meta, frames=frames
    )


def _run_iteration(state: LoopState, critic_override: Any = None) -> dict[str, Any]:
    """Capture + perceive + critique one iteration; returns the iteration record."""
    n = len(state.iterations)
    iter_dir = state.dir / f"iter_{n}"
    iter_dir.mkdir(parents=True, exist_ok=True)

    cap = capture(
        state.target, iter_dir, script=state.script,
        duration_seconds=state.duration_seconds,
    )
    perception = _perceive_capture(cap.video_path, iter_dir)
    critic = critic_override or critique_recording
    critique: Critique = critic(perception, state.pass_criteria)
    (iter_dir / "critique.json").write_text(
        critique.model_dump_json(indent=2), encoding="utf-8"
    )
    return {
        "n": n,
        "video": str(cap.video_path),
        "capture_kind": cap.kind,
        "critique": critique.model_dump(),
        "perception": perception.to_dict(),
        "diff": None,
        "artifacts": None,
    }


def _update_status(state: LoopState) -> None:
    latest = state.iterations[-1]["critique"]
    if latest["verdict"] == "pass":
        state.status = "passed"
        return
    if len(state.iterations) >= state.max_iterations:
        state.status = "max_iterations"
        return
    scores = [it["critique"]["score"] for it in state.iterations]
    if len(scores) >= _NO_PROGRESS_WINDOW + 1:
        recent, baseline = scores[-_NO_PROGRESS_WINDOW:], scores[-_NO_PROGRESS_WINDOW - 1]
        if all(score <= baseline for score in recent):
            state.status = "no_progress"
            return
    state.status = "running"


def _render_pass_artifacts(state: LoopState) -> dict[str, str] | None:
    if state.status != "passed" or len(state.iterations) < 2:
        return None
    first, last = state.iterations[0], state.iterations[-1]
    artifacts = render_before_after(
        Path(first["video"]), Path(last["video"]), state.dir / "artifacts"
    )
    return {k: str(v) for k, v in artifacts.items()}


def loop_start(
    target: str,
    pass_criteria: str,
    script: list[dict[str, Any]] | None = None,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    duration_seconds: float = 8.0,
    critic_override: Any = None,
) -> LoopState:
    """Start a loop: first capture + critique. Returns state with iteration 0."""
    state = LoopState(
        loop_id=uuid.uuid4().hex[:12],
        target=target,
        pass_criteria=pass_criteria,
        script=script,
        max_iterations=max_iterations,
        duration_seconds=duration_seconds,
    )
    record = _run_iteration(state, critic_override)
    state.iterations.append(record)
    _update_status(state)
    artifacts = _render_pass_artifacts(state)
    if artifacts:
        state.iterations[-1]["artifacts"] = artifacts
    state.save()
    return state


def loop_iterate(loop_id: str, critic_override: Any = None) -> LoopState:
    """Re-capture the same target/script, critique, and diff vs the previous pass.

    The calling agent applies fixes BETWEEN calls; this only observes.
    """
    state = LoopState.load(loop_id)
    if state.status in ("passed",):
        raise LoopError(
            f"loop {loop_id} already passed",
            code="loop.already_done",
            fix="start a new loop for new criteria",
        )
    record = _run_iteration(state, critic_override)

    previous = state.iterations[-1]
    prev_issues = [Issue(**i) for i in previous["critique"]["issues"]]
    cur_issues = [Issue(**i) for i in record["critique"]["issues"]]
    diff = diff_iterations(
        _load_perception(previous), _load_perception(record), prev_issues, cur_issues
    )
    record["diff"] = diff.to_dict()

    state.iterations.append(record)
    _update_status(state)
    artifacts = _render_pass_artifacts(state)
    if artifacts:
        state.iterations[-1]["artifacts"] = artifacts
    state.save()
    return state


def loop_status(loop_id: str) -> LoopState:
    """Load a loop's persisted state."""
    return LoopState.load(loop_id)
