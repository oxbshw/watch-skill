"""Disk housekeeping: LRU cache eviction, loop pruning, orphan frames."""
from __future__ import annotations

import time
from pathlib import Path

from watch_skill.config import get_settings, reset_settings
from watch_skill.health.clean import clean_cache, clean_loops, clean_orphan_frames


def _fake_cache_entry(name: str, size: int, age_rank: int) -> Path:
    d = get_settings().cache_dir / name
    d.mkdir(parents=True)
    (d / "media.mp4").write_bytes(b"x" * size)
    entry = d / "entry.json"
    entry.write_text("{}", encoding="utf-8")
    # older rank = older mtime
    stamp = time.time() - age_rank * 1000
    import os

    os.utime(entry, (stamp, stamp))
    return d


def test_clean_cache_evicts_oldest_to_cap(monkeypatch) -> None:
    monkeypatch.setenv("WATCHSKILL_CACHE_MAX_BYTES", "2500")
    reset_settings()
    old = _fake_cache_entry("aa", 2000, age_rank=3)
    newer = _fake_cache_entry("bb", 2000, age_rank=1)
    report = clean_cache()
    assert not old.exists(), "oldest entry should be evicted"
    assert newer.exists()
    assert report.freed_bytes >= 2000


def test_clean_cache_dry_run_deletes_nothing(monkeypatch) -> None:
    monkeypatch.setenv("WATCHSKILL_CACHE_MAX_BYTES", "10")
    reset_settings()
    entry = _fake_cache_entry("cc", 5000, age_rank=1)
    report = clean_cache(dry_run=True)
    assert entry.exists()
    assert report.freed_bytes >= 5000


def test_clean_loops_keeps_most_recent() -> None:
    loops_dir = get_settings().loops_dir
    for i in range(4):
        d = loops_dir / f"loop{i}"
        d.mkdir(parents=True)
        (d / "state.json").write_text("{}", encoding="utf-8")
        stamp = time.time() - i * 1000  # loop0 newest
        import os

        os.utime(d, (stamp, stamp))
    report = clean_loops(keep=2)
    remaining = sorted(p.name for p in loops_dir.iterdir())
    assert remaining == ["loop0", "loop1"]
    assert len(report.removed) == 2


def test_clean_orphan_frames_spares_indexed() -> None:
    frames = get_settings().data_dir / "frames"
    (frames / "orphan1").mkdir(parents=True)
    ((frames / "orphan1") / "f.jpg").write_bytes(b"j")
    report = clean_orphan_frames()
    assert not (frames / "orphan1").exists()
    assert report.removed
