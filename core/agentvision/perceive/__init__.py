"""Perception: scene detection, phash dedup, frame budgets, OCR.

Contract: :func:`perceive` returns a :class:`PerceptionResult` — ordered
frames with {timestamp, path, scene_id, phash, ocr} plus source metadata.
"""

from agentvision.perceive.budget import focused_budget, format_time, full_budget, parse_time
from agentvision.perceive.engine import perceive
from agentvision.perceive.media import probe
from agentvision.perceive.types import Frame, OcrBlock, PerceptionResult, VideoMetadata

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
