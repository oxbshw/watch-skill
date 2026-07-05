"""Perception output contract."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class OcrBlock:
    """One piece of on-screen text found in a frame."""

    text: str
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 in frame pixels
    confidence: float


@dataclass
class Frame:
    """One kept frame with everything perception learned about it."""

    index: int
    timestamp_seconds: float
    path: Path
    scene_id: int
    phash: str
    reason: str  # scene-start | scene-mid | uniform | cue
    ocr_blocks: list[OcrBlock] = field(default_factory=list)

    @property
    def ocr_text(self) -> str:
        """All OCR text in this frame, newline-joined (empty when none)."""
        return "\n".join(block.text for block in self.ocr_blocks)


@dataclass
class VideoMetadata:
    """ffprobe facts about the source media."""

    duration_seconds: float
    width: int | None
    height: int | None
    fps: float | None
    codec: str | None
    has_audio: bool
    size_bytes: int = 0


@dataclass
class PerceptionResult:
    """Ordered frames + source metadata — the contract every consumer gets."""

    source: str
    metadata: VideoMetadata
    frames: list[Frame] = field(default_factory=list)
    scene_count: int = 0
    candidate_count: int = 0
    deduped_count: int = 0
    engine: str = "scene"  # scene | uniform | mixed
    focused: bool = False
    start_seconds: float | None = None
    end_seconds: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe serialization (paths as strings)."""
        return {
            "source": self.source,
            "metadata": vars(self.metadata),
            "engine": self.engine,
            "scene_count": self.scene_count,
            "candidate_count": self.candidate_count,
            "deduped_count": self.deduped_count,
            "focused": self.focused,
            "start_seconds": self.start_seconds,
            "end_seconds": self.end_seconds,
            "frames": [
                {
                    "index": f.index,
                    "timestamp_seconds": f.timestamp_seconds,
                    "path": str(f.path),
                    "scene_id": f.scene_id,
                    "phash": f.phash,
                    "reason": f.reason,
                    "ocr_text": f.ocr_text,
                }
                for f in self.frames
            ],
        }
