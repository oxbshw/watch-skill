"""Classify any input string into a source kind the resolver can act on."""
from __future__ import annotations

from enum import Enum
from pathlib import Path
from urllib.parse import urlparse

MEDIA_EXTS = {
    ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".wmv",
    ".ts", ".m4a", ".mp3", ".opus", ".ogg", ".wav",
}
MANIFEST_EXTS = {".m3u8", ".mpd"}


class SourceKind(str, Enum):  # noqa: UP042 — StrEnum needs 3.11+, str+Enum reads the same
    """What kind of input the user handed us."""

    PAGE_URL = "page_url"        # any website; yt-dlp's 1800+ extractors
    DIRECT_URL = "direct_url"    # URL pointing straight at a media file
    MANIFEST_URL = "manifest_url"  # HLS (.m3u8) / DASH (.mpd) manifest
    LOCAL_FILE = "local_file"
    SCREEN = "screen"            # `screen:` — capture the screen (Milestone 3)
    WINDOW = "window"            # `window:<title>` — capture one window (Milestone 3)


def classify_source(source: str) -> SourceKind:
    """Map a raw source string to a :class:`SourceKind`.

    Rules: ``screen:`` / ``window:`` prefixes are capture requests; http(s)
    URLs are split by path suffix into manifest / direct-media / page URLs;
    everything else is treated as a local file path.
    """
    stripped = source.strip()
    lowered = stripped.lower()
    if lowered == "screen:" or lowered.startswith("screen:"):
        return SourceKind.SCREEN
    if lowered.startswith("window:"):
        return SourceKind.WINDOW

    parsed = urlparse(stripped)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        suffix = Path(parsed.path).suffix.lower()
        if suffix in MANIFEST_EXTS:
            return SourceKind.MANIFEST_URL
        if suffix in MEDIA_EXTS:
            return SourceKind.DIRECT_URL
        return SourceKind.PAGE_URL

    return SourceKind.LOCAL_FILE


def is_url_kind(kind: SourceKind) -> bool:
    """True for any source that must be fetched over the network."""
    return kind in (SourceKind.PAGE_URL, SourceKind.DIRECT_URL, SourceKind.MANIFEST_URL)
