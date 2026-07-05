"""Disk housekeeping: bounded caches, bounded loop archives, orphan removal.

``watch-skill clean`` keeps a long-lived install healthy on small disks:
the download cache already LRU-evicts on write, but loops and orphaned frame
dirs only grow — this is their garbage collector.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from watch_skill.config import get_settings

DEFAULT_LOOPS_KEEP = 10


@dataclass
class CleanReport:
    """What clean did (or would do, in dry-run)."""

    freed_bytes: int = 0
    removed: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "freed_bytes": self.freed_bytes,
            "freed_human": f"{self.freed_bytes / 1024**2:.1f} MiB",
            "removed": self.removed,
            "kept_count": len(self.kept),
        }


def _dir_size(directory: Path) -> int:
    return sum(f.stat().st_size for f in directory.rglob("*") if f.is_file())


def _remove(directory: Path, report: CleanReport, dry_run: bool) -> None:
    size = _dir_size(directory)
    if not dry_run:
        shutil.rmtree(directory, ignore_errors=True)
    report.freed_bytes += size
    report.removed.append(str(directory))


def clean_cache(all_entries: bool = False, dry_run: bool = False) -> CleanReport:
    """Evict the download cache: LRU-to-cap by default, everything with all_entries."""
    from watch_skill.acquire.cache import ENTRY_FILE

    report = CleanReport()
    cache_dir = get_settings().cache_dir
    if not cache_dir.is_dir():
        return report
    entries = sorted(
        (d for d in cache_dir.iterdir() if d.is_dir()),
        key=lambda d: (d / ENTRY_FILE).stat().st_mtime if (d / ENTRY_FILE).is_file() else 0,
    )
    if all_entries:
        for entry in entries:
            _remove(entry, report, dry_run)
        return report
    cap = get_settings().cache_max_bytes
    total = sum(_dir_size(d) for d in entries)
    for entry in entries:  # oldest first
        if total <= cap:
            report.kept.append(str(entry))
            continue
        size = _dir_size(entry)
        _remove(entry, report, dry_run)
        total -= size
    return report


def clean_loops(keep: int = DEFAULT_LOOPS_KEEP, dry_run: bool = False) -> CleanReport:
    """Keep only the ``keep`` most recent loop directories."""
    report = CleanReport()
    loops_dir = get_settings().loops_dir
    if not loops_dir.is_dir():
        return report
    loops = sorted(
        (d for d in loops_dir.iterdir() if d.is_dir()),
        key=lambda d: d.stat().st_mtime,
        reverse=True,
    )
    for i, loop in enumerate(loops):
        if i < keep:
            report.kept.append(str(loop))
        else:
            _remove(loop, report, dry_run)
    return report


def clean_orphan_frames(dry_run: bool = False) -> CleanReport:
    """Remove frame dirs whose video is no longer in the index."""
    from watch_skill.index.db import connect

    report = CleanReport()
    frames_root = get_settings().data_dir / "frames"
    if not frames_root.is_dir():
        return report
    conn = connect()
    try:
        known = {r["id"] for r in conn.execute("SELECT id FROM videos")}
    finally:
        conn.close()
    for directory in frames_root.iterdir():
        if not directory.is_dir():
            continue
        if directory.name in known:
            report.kept.append(str(directory))
        else:
            _remove(directory, report, dry_run)
    return report
