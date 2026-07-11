"""Batch mode: watch + index a whole playlist, folder, or list of sources.

The persistent index is what makes this worth doing — after a batch run the
entire set is ONE searchable memory (`search_videos` spans the library), and
`ask_video` works on any member without re-processing. One bad video never
kills the batch; failures are reported per source.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import AcquisitionError, WatchSkillError
from watch_skill.perceive.budget import format_time

_VIDEO_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".ts", ".m4v"}
_MAX_BATCH = 50  # a hard sanity cap; batches are bounded by design


@dataclass
class BatchItem:
    """Outcome for one source in the batch."""

    source: str
    status: str  # indexed | failed
    video_id: str | None = None
    title: str | None = None
    duration_seconds: float = 0.0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return vars(self)


@dataclass
class BatchResult:
    """The whole batch: per-source outcomes + a comparative summary."""

    items: list[BatchItem] = field(default_factory=list)

    @property
    def indexed(self) -> list[BatchItem]:
        return [i for i in self.items if i.status == "indexed"]

    @property
    def failed(self) -> list[BatchItem]:
        return [i for i in self.items if i.status == "failed"]

    def report(self) -> str:
        lines = [
            f"batch: {len(self.indexed)}/{len(self.items)} indexed"
            + (f", {len(self.failed)} failed" if self.failed else "")
        ]
        for item in self.indexed:
            lines.append(
                f"  {item.video_id}  [{format_time(item.duration_seconds)}]  "
                f"{item.title or item.source}"
            )
        for item in self.failed:
            lines.append(f"  FAILED {item.source}: {item.error}")
        if self.indexed:
            lines.append(
                "all indexed videos share one searchable memory — "
                'search_videos("...") spans them; ask_video works on each.'
            )
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {"items": [i.to_dict() for i in self.items], "report": self.report()}


def expand_playlist(url: str, limit: int = _MAX_BATCH) -> list[str]:
    """Entry URLs of a playlist/channel via yt-dlp's flat extraction."""
    from watch_skill.health.binaries import require_binary

    yt_dlp = require_binary("yt-dlp")
    result = subprocess.run(
        [str(yt_dlp), "--flat-playlist", "--playlist-end", str(limit), "-J", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=300,
    )
    if result.returncode != 0:
        raise AcquisitionError(
            f"could not expand playlist: {url}",
            code="acquire.playlist_failed",
            fix="check the playlist is public; `watch-skill doctor` updates a "
            "stale yt-dlp, which is the usual cause",
            details={"stderr": result.stderr[-500:]},
        )
    data = json.loads(result.stdout)
    entries = data.get("entries") or []
    urls = [e.get("url") or e.get("webpage_url") for e in entries if e]
    return [u for u in urls if u][:limit]


def expand_source(source: str, limit: int = _MAX_BATCH) -> list[str]:
    """One batch source -> concrete video sources.

    A folder yields its video files (oldest first); a playlist/channel URL is
    flat-expanded; anything else is already a single video source.
    """
    folder = Path(source).expanduser()
    if folder.is_dir():
        files = sorted(
            (p for p in folder.iterdir() if p.suffix.lower() in _VIDEO_SUFFIXES),
            key=lambda p: p.stat().st_mtime,
        )
        return [str(p) for p in files[:limit]]
    lowered = source.lower()
    if lowered.startswith(("http://", "https://")) and (
        "playlist" in lowered or "list=" in lowered or "/@" in lowered or "/channel/" in lowered
    ):
        return expand_playlist(source, limit)
    return [source]


def watch_batch(
    sources: list[str] | str,
    limit: int = _MAX_BATCH,
    **watch_kwargs: Any,
) -> BatchResult:
    """Watch + index every video in the batch; failures don't stop the rest."""
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    if isinstance(sources, str):
        sources = [sources]
    expanded: list[str] = []
    for source in sources:
        expanded.extend(expand_source(source, limit))
    expanded = expanded[:limit]
    if not expanded:
        raise AcquisitionError(
            "batch expanded to zero videos",
            code="acquire.batch_empty",
            fix="pass video URLs/paths, a folder containing videos, or a playlist URL",
        )

    result = BatchResult()
    for source in expanded:
        try:
            watched = watch(source, **watch_kwargs)
            video_id = index_watch_result(watched)
            result.items.append(
                BatchItem(
                    source=source, status="indexed", video_id=video_id,
                    title=watched.acquisition.info.get("title") or Path(source).name,
                    duration_seconds=watched.metadata.duration_seconds,
                )
            )
        except WatchSkillError as exc:
            result.items.append(BatchItem(source=source, status="failed", error=str(exc)))
        except Exception as exc:  # noqa: BLE001 — one broken video must not kill the batch
            result.items.append(BatchItem(source=source, status="failed", error=repr(exc)))
    return result
