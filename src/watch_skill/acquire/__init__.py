"""Source acquisition: resolve ANY input to a local video file.

Self-healing chain: yt-dlp -> auto-update + retry -> self-hosted cobalt
(opt-in) -> direct ffmpeg pull. Content-addressed cache with LRU eviction.
Privacy invariants: no cookies/logins, video files never leave the machine.
"""

from watch_skill.acquire.resolver import acquire, fetch_captions_only
from watch_skill.acquire.sources import SourceKind, classify_source
from watch_skill.acquire.types import AcquireResult

__all__ = ["AcquireResult", "SourceKind", "acquire", "classify_source", "fetch_captions_only"]
