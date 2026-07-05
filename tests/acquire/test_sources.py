"""Source classification covers every input family."""
from __future__ import annotations

import pytest

from watch_skill.acquire.sources import SourceKind, classify_source, is_url_kind


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("https://www.youtube.com/watch?v=abc123", SourceKind.PAGE_URL),
        ("https://www.tiktok.com/@user/video/123", SourceKind.PAGE_URL),
        ("http://example.com/some/page", SourceKind.PAGE_URL),
        ("https://cdn.example.com/clip.mp4", SourceKind.DIRECT_URL),
        ("https://cdn.example.com/clip.webm?sig=x", SourceKind.DIRECT_URL),
        ("https://stream.example.com/live/index.m3u8", SourceKind.MANIFEST_URL),
        ("https://stream.example.com/dash/manifest.mpd", SourceKind.MANIFEST_URL),
        ("C:\\Videos\\my clip.mp4", SourceKind.LOCAL_FILE),
        ("./relative/clip.mov", SourceKind.LOCAL_FILE),
        ("screen:", SourceKind.SCREEN),
        ("window:My App - Editor", SourceKind.WINDOW),
    ],
)
def test_classify(source: str, expected: SourceKind) -> None:
    assert classify_source(source) == expected


def test_is_url_kind() -> None:
    assert is_url_kind(SourceKind.PAGE_URL)
    assert is_url_kind(SourceKind.DIRECT_URL)
    assert is_url_kind(SourceKind.MANIFEST_URL)
    assert not is_url_kind(SourceKind.LOCAL_FILE)
    assert not is_url_kind(SourceKind.SCREEN)


def test_leading_dash_is_never_a_url() -> None:
    # argv-injection guard: a "-flag" source must not reach yt-dlp as a flag
    assert classify_source("--output=evil") == SourceKind.LOCAL_FILE
