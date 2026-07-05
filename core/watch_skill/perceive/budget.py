"""Token-aware frame budgets — tiers inherited verbatim from the reference.

Budget-by-duration keeps short videos dense and long videos capped; focused
mode (user named a moment) spends more per second. Universal 2 fps rate cap.
"""
from __future__ import annotations

from watch_skill.config import get_settings


def _clamp(target: float, duration_seconds: float, max_frames: int) -> tuple[float, int]:
    max_fps = get_settings().max_fps
    fps = min(target / duration_seconds if duration_seconds > 0 else 1.0, max_fps)
    frames = min(max_frames, max(1, int(round(fps * duration_seconds))))
    return fps, frames


def full_budget(duration_seconds: float, max_frames: int | None = None) -> tuple[float, int]:
    """(fps, target_frames) for a full-video scan."""
    cap = max_frames if max_frames is not None else get_settings().frame_cap
    if duration_seconds <= 0:
        return 1.0, 1
    if duration_seconds <= 30:
        target = min(cap, max(12, int(round(duration_seconds))))
    elif duration_seconds <= 60:
        target = min(cap, 40)
    elif duration_seconds <= 180:
        target = min(cap, 60)
    elif duration_seconds <= 600:
        target = min(cap, 80)
    else:
        target = cap
    return _clamp(target, duration_seconds, cap)


def focused_budget(duration_seconds: float, max_frames: int | None = None) -> tuple[float, int]:
    """(fps, target_frames) for a user-focused window — denser per second."""
    cap = max_frames if max_frames is not None else get_settings().frame_cap
    if duration_seconds <= 0:
        return min(get_settings().max_fps, 2.0), 2
    if duration_seconds <= 5:
        target = min(cap, max(10, int(round(duration_seconds * 6))))
    elif duration_seconds <= 15:
        target = min(cap, max(30, int(round(duration_seconds * 4))))
    elif duration_seconds <= 30:
        target = min(cap, 60)
    elif duration_seconds <= 60:
        target = min(cap, 80)
    else:
        target = cap
    return _clamp(target, duration_seconds, cap)


def parse_time(value: str | float | int | None) -> float | None:
    """Parse SS, MM:SS, or HH:MM:SS (optional .ms) into seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        pass
    raise ValueError(f"cannot parse time value: {value!r} (expected SS, MM:SS, or HH:MM:SS)")


def format_time(seconds: float) -> str:
    """Render seconds as MM:SS or H:MM:SS."""
    total = int(round(seconds))
    hours, rem = divmod(total, 3600)
    minutes, sec = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes:02d}:{sec:02d}"
