"""Content-addressed download cache: never re-download an unchanged video.

Layout: ``<data_dir>/cache/<key>/`` where ``key`` is a hash of the normalized
source URL. Each entry holds the media file(s), optional subtitles, and an
``entry.json`` with source metadata. Access time is tracked by touching
``entry.json`` so LRU eviction can order entries without OS atime support.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agentvision.config import get_settings

ENTRY_FILE = "entry.json"


@dataclass
class CacheEntry:
    """One cached download."""

    key: str
    dir: Path
    video_path: Path | None
    subtitle_path: Path | None
    info: dict[str, Any]


def cache_key(source: str) -> str:
    """Stable key for a source URL (case-preserved, whitespace-trimmed)."""
    return hashlib.sha256(source.strip().encode("utf-8")).hexdigest()[:24]


def entry_dir(source: str, create: bool = False) -> Path:
    """Directory where this source's download lives (created on demand)."""
    directory = get_settings().cache_dir / cache_key(source)
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def _load_entry(directory: Path) -> CacheEntry | None:
    meta_path = directory / ENTRY_FILE
    if not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    video = directory / meta["video"] if meta.get("video") else None
    subs = directory / meta["subtitle"] if meta.get("subtitle") else None
    if video is not None and not video.is_file():
        return None
    return CacheEntry(
        key=directory.name,
        dir=directory,
        video_path=video,
        subtitle_path=subs if subs and subs.is_file() else None,
        info=meta.get("info", {}),
    )


def lookup(source: str) -> CacheEntry | None:
    """Return the cached entry for ``source`` and mark it recently used."""
    directory = entry_dir(source)
    entry = _load_entry(directory)
    if entry is not None:
        try:
            os.utime(directory / ENTRY_FILE)
        except OSError:
            pass
    return entry


def commit(
    source: str,
    video_path: Path | None,
    subtitle_path: Path | None = None,
    info: dict[str, Any] | None = None,
) -> CacheEntry:
    """Record a completed download that already lives inside the entry dir.

    Acquirers download *into* :func:`entry_dir` so committing is just writing
    the manifest — no copy of a multi-GB file.
    """
    directory = entry_dir(source, create=True)
    meta = {
        "source": source,
        "video": video_path.name if video_path else None,
        "subtitle": subtitle_path.name if subtitle_path else None,
        "info": info or {},
        "committed_at": time.time(),
    }
    (directory / ENTRY_FILE).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    evict_lru()
    return CacheEntry(
        key=directory.name,
        dir=directory,
        video_path=video_path,
        subtitle_path=subtitle_path,
        info=info or {},
    )


def _dir_size(directory: Path) -> int:
    return sum(p.stat().st_size for p in directory.rglob("*") if p.is_file())


def evict_lru(max_bytes: int | None = None) -> int:
    """Delete least-recently-used entries until the cache fits the cap.

    Returns the number of evicted entries. Recency = mtime of ``entry.json``
    (touched on every :func:`lookup` hit).
    """
    cap = max_bytes if max_bytes is not None else get_settings().cache_max_bytes
    cache_dir = get_settings().cache_dir
    if not cache_dir.is_dir():
        return 0

    entries: list[tuple[float, Path, int]] = []
    total = 0
    for directory in cache_dir.iterdir():
        meta = directory / ENTRY_FILE
        if not directory.is_dir() or not meta.is_file():
            continue
        size = _dir_size(directory)
        total += size
        entries.append((meta.stat().st_mtime, directory, size))

    evicted = 0
    entries.sort()  # oldest first
    while total > cap and entries:
        _, directory, size = entries.pop(0)
        shutil.rmtree(directory, ignore_errors=True)
        total -= size
        evicted += 1
    return evicted


def clear() -> None:
    """Remove the entire cache (used by `agentvision cache clear`)."""
    shutil.rmtree(get_settings().cache_dir, ignore_errors=True)
