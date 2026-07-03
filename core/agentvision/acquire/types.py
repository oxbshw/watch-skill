"""Shared acquisition data types."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentvision.acquire.sources import SourceKind


@dataclass
class AcquireResult:
    """A source resolved to local files.

    ``video_path`` is ``None`` only for captions-only probes (no media was
    needed). ``info`` carries whatever metadata the acquirer learned (title,
    uploader, duration, webpage URL).
    """

    source: str
    kind: SourceKind
    video_path: Path | None
    subtitle_path: Path | None = None
    info: dict[str, Any] = field(default_factory=dict)
    from_cache: bool = False
    acquirer: str = "unknown"  # which chain step produced this: yt-dlp | cobalt | ffmpeg | local
