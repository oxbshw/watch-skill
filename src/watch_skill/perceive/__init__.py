"""Perception: scene detection, phash dedup, frame budgets, OCR.

Contract: :func:`perceive` returns a :class:`PerceptionResult` — ordered
frames with {timestamp, path, scene_id, phash, ocr} plus source metadata.
"""

from watch_skill.perceive.budget import focused_budget, format_time, full_budget, parse_time
from watch_skill.perceive.engine import perceive
from watch_skill.perceive.media import probe
from watch_skill.perceive.types import Frame, OcrBlock, PerceptionResult, VideoMetadata

__all__ = [
    "Frame",
    "OcrBlock",
    "PerceptionResult",
    "VideoMetadata",
    "focused_budget",
    "format_time",
    "full_budget",
    "parse_time",
    "perceive",
    "probe",
]
