"""Pluggable loop types: one shared skeleton, swappable recording producers.

Every loop shares the same spine — produce a recording, perceive it, critique
against pass criteria, diff against the previous iteration, iterate until
pass/stall, render the proof artifact. The ONLY thing that differs between a
UI loop, a video-generation loop, and a game loop is how the recording for an
iteration is produced. That difference is a registry entry, not a fork of the
runner.

Adding a loop type: implement ``produce(state, iter_dir) -> CaptureResult``
and register it. ``loop_start``/``loop_iterate`` keep working unchanged for
existing loops (``loop_type`` defaults to "ui").
"""
from __future__ import annotations

import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from watch_skill.errors import LoopError
from watch_skill.loop.capture import CaptureResult, capture, capture_file

if TYPE_CHECKING:  # runner imports framework; avoid the cycle at runtime
    from watch_skill.loop.runner import LoopState

Producer = Callable[["LoopState", Path], CaptureResult]


@dataclass(frozen=True)
class LoopType:
    """One pluggable loop flavor."""

    name: str
    produce: Producer
    description: str


_REGISTRY: dict[str, LoopType] = {}


def register_loop_type(loop_type: LoopType) -> None:
    _REGISTRY[loop_type.name] = loop_type


def get_loop_type(name: str) -> LoopType:
    if name not in _REGISTRY:
        raise LoopError(
            f"unknown loop type: {name!r}",
            code="loop.unknown_type",
            fix=f"one of: {', '.join(sorted(_REGISTRY))}",
        )
    return _REGISTRY[name]


def loop_type_names() -> list[str]:
    return sorted(_REGISTRY)


# --- ui (the original loop) --------------------------------------------------

def _produce_ui(state: LoopState, iter_dir: Path) -> CaptureResult:
    """Record the target (URL / screen: / window: / file) as before."""
    return capture(
        state.target, iter_dir, script=state.script,
        duration_seconds=state.duration_seconds,
    )


# --- video-gen: run a generator command, adopt what it renders ---------------

def _produce_video_gen(state: LoopState, iter_dir: Path) -> CaptureResult:
    """Run the generator command (Manim/Remotion/ffmpeg/anything), then adopt
    the video it writes. The agent edits the generator between iterations; the
    loop only runs and judges it."""
    cmd = state.extra.get("generator_cmd")
    output = state.extra.get("output")
    if not cmd or not output:
        raise LoopError(
            "video-gen loop needs generator_cmd and output",
            code="loop.bad_config",
            fix="loop_video_gen(spec=..., generator_cmd=..., output=<path the command writes>)",
        )
    output_path = Path(output).expanduser()
    output_path.unlink(missing_ok=True)  # a stale render must not pass for a new one
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            cwd=state.extra.get("workdir") or None,
            timeout=float(state.extra.get("timeout_seconds", 600)),
        )
    except subprocess.TimeoutExpired as exc:
        raise LoopError(
            f"generator timed out after {exc.timeout:.0f}s",
            code="loop.generator_timeout",
            details={"cmd": cmd},
        ) from exc
    if result.returncode != 0:
        raise LoopError(
            f"generator exited {result.returncode}",
            code="loop.generator_failed",
            fix="run the generator_cmd by hand and fix it; the loop only re-runs it",
            details={"cmd": cmd, "stderr": result.stderr[-800:]},
        )
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise LoopError(
            f"generator succeeded but wrote no video at {output_path}",
            code="loop.generator_no_output",
            fix="make generator_cmd write the file passed as output=",
            details={"cmd": cmd},
        )
    adopted = capture_file(output_path, iter_dir)
    return CaptureResult(
        video_path=adopted.video_path, kind="video-gen", target=cmd,
        meta={"spec": state.extra.get("spec", ""), "output": str(output_path)},
    )


# --- game/sim: optionally launch a process, record the screen/window ---------

def _produce_game(state: LoopState, iter_dir: Path) -> CaptureResult:
    """Launch the game/sim (optional), record its window/screen/canvas URL.

    ``target`` decides the recorder exactly like the UI loop (a canvas game
    served as a URL records via the browser; a native game via
    window:<title> / screen:). ``run_cmd`` starts the game first and is
    terminated after the recording.
    """
    run_cmd = state.extra.get("run_cmd")
    process: subprocess.Popen | None = None
    if run_cmd:
        process = subprocess.Popen(
            run_cmd, shell=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            cwd=state.extra.get("workdir") or None,
        )
        time.sleep(float(state.extra.get("warmup_seconds", 3.0)))
        if process.poll() is not None:
            raise LoopError(
                f"game process exited immediately (code {process.returncode})",
                code="loop.game_start_failed",
                fix="run run_cmd by hand; it must stay alive while recording",
                details={"cmd": run_cmd},
            )
    try:
        cap = capture(
            state.target, iter_dir, script=state.script,
            duration_seconds=state.duration_seconds,
            viewport=state.extra.get("viewport") or None,
        )
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - stubborn process
                process.kill()
    return CaptureResult(
        video_path=cap.video_path, kind="game", target=state.target,
        meta={**cap.meta, "run_cmd": run_cmd or ""},
    )


register_loop_type(LoopType("ui", _produce_ui, "Record a URL/screen/window and iterate on fixes."))
register_loop_type(
    LoopType(
        "video-gen", _produce_video_gen,
        "Run a video generator command, watch the render, iterate until it matches the spec.",
    )
)
register_loop_type(
    LoopType(
        "game", _produce_game,
        "Run a game/sim, record gameplay, critic detects visual glitches/state failures.",
    )
)
