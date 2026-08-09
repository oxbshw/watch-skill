"""Where the disk went, and which videos are worth forgetting.

The index is the product, so it is meant to grow — but it grows silently,
and `clean` only ever offered caches, loops, and orphans. Nothing said how
large the library had become or which video was responsible, so the only way
to reclaim space was to guess a `forget` and check.

Measured on the reference machine: vectors run ~2 KB each, so 100k of them
is a ~200 MB index before a single frame is counted. Frames are usually the
larger half. Both are reported per video, because a decision to forget is
made about one video, not about a total.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class VideoUsage:
    """Disk one video is responsible for."""

    video_id: str
    title: str
    frames_bytes: int
    frame_count: int
    segments: int
    ocr_blocks: int
    embeddings: int
    embedding_bytes: int

    @property
    def total_bytes(self) -> int:
        return self.frames_bytes + self.embedding_bytes

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id,
            "title": self.title,
            "frames_bytes": self.frames_bytes,
            "frame_count": self.frame_count,
            "segments": self.segments,
            "ocr_blocks": self.ocr_blocks,
            "embeddings": self.embeddings,
            "embedding_bytes": self.embedding_bytes,
            "total_bytes": self.total_bytes,
        }


@dataclass
class IndexUsage:
    """The whole library, and the videos inside it by size."""

    db_bytes: int
    frames_bytes: int
    videos: list[VideoUsage]

    @property
    def total_bytes(self) -> int:
        return self.db_bytes + self.frames_bytes

    def to_dict(self) -> dict[str, Any]:
        return {
            "db_bytes": self.db_bytes,
            "frames_bytes": self.frames_bytes,
            "total_bytes": self.total_bytes,
            "video_count": len(self.videos),
            "videos": [v.to_dict() for v in self.videos],
        }


def human_bytes(size: int | float) -> str:
    """Size as something a person reads, not a digit count."""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def _dir_bytes(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def index_usage(top: int | None = None) -> IndexUsage:
    """Disk used by the index and by each video in it, largest first."""
    from watch_skill.config import get_settings
    from watch_skill.index.db import connect

    settings = get_settings()
    db_path = settings.index_path
    db_bytes = db_path.stat().st_size if db_path.is_file() else 0

    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT v.id, v.title, v.source, v.frames_dir,
                   (SELECT COUNT(*) FROM segments   s WHERE s.video_id = v.id) AS segments,
                   (SELECT COUNT(*) FROM ocr_blocks o WHERE o.video_id = v.id) AS ocr_blocks,
                   (SELECT COUNT(*) FROM embeddings e WHERE e.video_id = v.id) AS embeddings,
                   (SELECT COALESCE(SUM(LENGTH(e.vector)), 0)
                      FROM embeddings e WHERE e.video_id = v.id)               AS embedding_bytes
            FROM videos v
            """
        ).fetchall()
    finally:
        conn.close()

    videos: list[VideoUsage] = []
    frames_total = 0
    for row in rows:
        frames_dir = Path(row["frames_dir"]) if row["frames_dir"] else None
        frame_files = (
            [f for f in frames_dir.glob("*") if f.is_file()] if frames_dir and frames_dir.is_dir()
            else []
        )
        frames_bytes = sum(f.stat().st_size for f in frame_files)
        frames_total += frames_bytes
        videos.append(
            VideoUsage(
                video_id=row["id"],
                title=row["title"] or row["source"],
                frames_bytes=frames_bytes,
                frame_count=len(frame_files),
                segments=row["segments"],
                ocr_blocks=row["ocr_blocks"],
                embeddings=row["embeddings"],
                embedding_bytes=row["embedding_bytes"],
            )
        )

    videos.sort(key=lambda v: v.total_bytes, reverse=True)
    if top is not None:
        videos = videos[:top]
    return IndexUsage(db_bytes=db_bytes, frames_bytes=frames_total, videos=videos)


def render_usage(usage: IndexUsage) -> str:
    """The report, with the command that acts on it."""
    lines = [
        f"index database : {human_bytes(usage.db_bytes)}",
        f"stored frames  : {human_bytes(usage.frames_bytes)}",
        f"total          : {human_bytes(usage.total_bytes)}  "
        f"across {len(usage.videos)} video(s)",
    ]
    if not usage.videos:
        return "\n".join(lines)

    lines += ["", "largest first:", ""]
    for video in usage.videos:
        title = video.title if len(video.title) <= 46 else video.title[:43] + "..."
        lines.append(
            f"  {human_bytes(video.total_bytes):>9}  {video.video_id}  {title}"
        )
        lines.append(
            f"             {video.frame_count} frames "
            f"({human_bytes(video.frames_bytes)}) · "
            f"{video.embeddings} vectors ({human_bytes(video.embedding_bytes)}) · "
            f"{video.segments} segments · {video.ocr_blocks} ocr"
        )
    lines += [
        "",
        "Reclaim a video's share with:  watch-skill forget <video_id>",
        "Caches, old loops, and orphaned frames:  watch-skill clean --all",
    ]
    return "\n".join(lines)
