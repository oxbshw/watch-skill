"""Monitor loop: watch a stream or a folder of videos until a condition appears.

Unlike the fix-iterate loops, a monitor does not expect an agent to change
anything between rounds — it repeatedly samples a source (a live stream /
screen target, or new files landing in a folder), runs the critic against the
watched-for condition, and emits a STRUCTURED EVENT the moment the condition
is seen. Bounded by ``max_checks`` so it can never run away.

Event delivery is deliberately minimal in v0.7: every event is appended to
``events.jsonl`` in the monitor's directory and handed to the optional
``on_event`` callback. The v0.8 webhook/event system plugs into that same
callback seam.
"""
from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.errors import LoopError
from watch_skill.loop.capture import capture, capture_file
from watch_skill.loop.critic import critique_recording
from watch_skill.perceive import perceive

_VIDEO_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".ts", ".m4v"}


@dataclass
class MonitorResult:
    """Outcome of one bounded monitoring run."""

    monitor_id: str
    source: str
    condition: str
    checks_run: int
    events: list[dict[str, Any]] = field(default_factory=list)
    events_path: str = ""

    @property
    def triggered(self) -> bool:
        return bool(self.events)

    def to_dict(self) -> dict[str, Any]:
        return {
            "monitor_id": self.monitor_id,
            "source": self.source,
            "condition": self.condition,
            "checks_run": self.checks_run,
            "triggered": self.triggered,
            "events": self.events,
            "events_path": self.events_path,
        }


def _folder_items(folder: Path, seen: set[str]) -> list[Path]:
    """Video files in ``folder`` not yet processed, oldest first."""
    items = [
        p for p in sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime)
        if p.suffix.lower() in _VIDEO_SUFFIXES and str(p) not in seen
    ]
    return items


def _check_recording(
    video_path: Path, work_dir: Path, condition: str, critic: Any
) -> list[dict[str, Any]]:
    """Critique one recording for the condition; issues mean it appeared.

    The critic's contract is pass criteria, so the condition is framed as
    'must never show <condition>' — a FAIL verdict with issues IS the event.
    """
    perception = perceive(
        video_path, work_dir / "frames", source_label=str(video_path), max_frames=12
    )
    criteria = f"The recording must never show: {condition}"
    critique = critic(perception, criteria)
    if critique.verdict == "pass":
        return []
    return [
        {
            "timestamp": issue.timestamp,
            "severity": issue.severity,
            "description": issue.description,
        }
        for issue in critique.issues
    ] or [{"timestamp": 0.0, "severity": "major", "description": critique.summary}]


def loop_monitor(
    source: str,
    condition: str,
    interval_seconds: float = 10.0,
    max_checks: int = 10,
    sample_seconds: float = 5.0,
    stop_on_event: bool = True,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    critic_override: Any = None,
    _sleep: Callable[[float], None] = time.sleep,
) -> MonitorResult:
    """Watch ``source`` until ``condition`` appears or ``max_checks`` runs out.

    ``source`` is a folder of videos (each check consumes the next unseen
    file) or any capture target (URL / screen: / window: / stream), sampled
    for ``sample_seconds`` per check. Every detection becomes a structured
    event: appended to events.jsonl, handed to ``on_event``.
    """
    if max_checks < 1:
        raise LoopError(
            "max_checks must be >= 1",
            code="loop.bad_config",
            fix="pass max_checks >= 1 — the bound exists so monitors always terminate",
        )
    # WATCHSKILL_WEBHOOK_URL turns every event into a signed POST as well —
    # events.jsonl and any explicit callback keep working unchanged
    from watch_skill.loop.webhook import webhook_on_event  # noqa: PLC0415

    on_event = webhook_on_event(on_event)
    critic = critic_override or critique_recording
    monitor_id = uuid.uuid4().hex[:12]
    monitor_dir = get_settings().loops_dir / f"monitor_{monitor_id}"
    monitor_dir.mkdir(parents=True, exist_ok=True)
    events_path = monitor_dir / "events.jsonl"

    folder = Path(source).expanduser()
    folder_mode = folder.is_dir()
    seen: set[str] = set()
    events: list[dict[str, Any]] = []
    checks = 0

    for check in range(max_checks):
        work_dir = monitor_dir / f"check_{check}"
        work_dir.mkdir(parents=True, exist_ok=True)
        if folder_mode:
            pending = _folder_items(folder, seen)
            if not pending:
                if check == 0 and not seen:
                    raise LoopError(
                        f"no video files in folder: {folder}",
                        code="loop.monitor_empty",
                        fix=f"supported suffixes: {', '.join(sorted(_VIDEO_SUFFIXES))}",
                    )
                break  # folder drained
            item = pending[0]
            seen.add(str(item))
            recording = capture_file(item, work_dir).video_path
            item_label = str(item)
        else:
            recording = capture(
                source, work_dir, duration_seconds=sample_seconds
            ).video_path
            item_label = source
        checks += 1

        detections = _check_recording(recording, work_dir, condition, critic)
        if detections:
            event = {
                "monitor_id": monitor_id,
                "check": check,
                "source": item_label,
                "condition": condition,
                "detections": detections,
                "at": datetime.now(UTC).isoformat(),
            }
            events.append(event)
            with events_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            if on_event is not None:
                try:
                    on_event(event)
                except Exception:  # a broken callback must not kill the watch
                    pass
            if stop_on_event:
                break
        if not folder_mode and check < max_checks - 1:
            _sleep(interval_seconds)

    return MonitorResult(
        monitor_id=monitor_id,
        source=source,
        condition=condition,
        checks_run=checks,
        events=events,
        events_path=str(events_path) if events else "",
    )
