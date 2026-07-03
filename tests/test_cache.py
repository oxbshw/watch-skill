"""Download cache: roundtrip, LRU eviction, stable keys."""
from __future__ import annotations

import os
import time
from pathlib import Path

from agentvision.acquire import cache

URL_A = "https://example.com/watch?v=aaa"
URL_B = "https://example.com/watch?v=bbb"


def _fake_download(url: str, size: int = 1000) -> cache.CacheEntry:
    directory = cache.entry_dir(url, create=True)
    video = directory / "media.mp4"
    video.write_bytes(b"x" * size)
    return cache.commit(url, video, info={"title": "t"})


def test_key_is_stable_and_distinct() -> None:
    assert cache.cache_key(URL_A) == cache.cache_key(URL_A)
    assert cache.cache_key(URL_A) != cache.cache_key(URL_B)
    assert cache.cache_key(" " + URL_A + " ") == cache.cache_key(URL_A)


def test_commit_then_lookup_roundtrip() -> None:
    _fake_download(URL_A)
    entry = cache.lookup(URL_A)
    assert entry is not None
    assert entry.video_path is not None and entry.video_path.is_file()
    assert entry.info == {"title": "t"}


def test_lookup_misses_when_video_deleted() -> None:
    entry = _fake_download(URL_A)
    assert entry.video_path is not None
    entry.video_path.unlink()
    assert cache.lookup(URL_A) is None


def test_lru_eviction_removes_oldest_first() -> None:
    _fake_download(URL_A, size=600)
    time.sleep(0.05)
    _fake_download(URL_B, size=600)
    # touch A so B becomes the LRU entry
    time.sleep(0.05)
    assert cache.lookup(URL_A) is not None
    evicted = cache.evict_lru(max_bytes=800)
    assert evicted == 1
    assert cache.lookup(URL_B) is None
    assert cache.lookup(URL_A) is not None


def test_eviction_noop_under_cap() -> None:
    _fake_download(URL_A)
    assert cache.evict_lru(max_bytes=10_000_000) == 0
    assert cache.lookup(URL_A) is not None


def test_cache_dir_lives_under_data_dir(isolated_settings: Path) -> None:
    _fake_download(URL_A)
    entry = cache.lookup(URL_A)
    assert entry is not None
    assert str(entry.dir).startswith(str(isolated_settings))
    assert " " in str(entry.dir)  # spaces-in-path invariant


def test_lookup_touches_entry_for_lru(tmp_path: Path) -> None:
    _fake_download(URL_A)
    meta = cache.entry_dir(URL_A) / cache.ENTRY_FILE
    old = meta.stat().st_mtime - 100
    os.utime(meta, (old, old))
    cache.lookup(URL_A)
    assert meta.stat().st_mtime > old
