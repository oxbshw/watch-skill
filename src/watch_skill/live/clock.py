"""One clock per session, so audio and video can be compared.

Video frames and audio chunks arrive from two independent ffmpeg processes.
Each stamps its own media timestamp from its own byte count, and those two
counts drift: a video frame at 7.00 s and an audio chunk at 7.00 s are close
but not identical, and nothing in either process knows about the other.

This module is the shared reference that makes "what was on screen when they
said that" answerable. It does three things and refuses to do a fourth:

* records the session's origin on both clocks, once;
* measures drift between the streams rather than assuming there is none;
* aligns a timestamp in one stream to a window in the other.

It does **not** resample or rewrite timestamps. A media timestamp is what the
source said; correcting it silently would make a citation point at something
the viewer will not find there.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

DEFAULT_WINDOW = 2.0
"""How far apart two observations may be and still be called simultaneous.
Two seconds because that is roughly how long a UI change stays on screen
while someone describes it — narrower loses real correlations, wider starts
claiming coincidences are connections."""

DISCONTINUITY_SECONDS = 1.0
"""A backwards or forward jump larger than this is a discontinuity, not
jitter. Stream reconnects produce exactly this and must not be averaged into
a drift figure as though they were."""


@dataclass
class StreamClock:
    """The observed timing of one stream within a session."""

    name: str
    first_media_ts: float | None = None
    last_media_ts: float = 0.0
    first_wall_ts: float | None = None
    last_wall_ts: float = 0.0
    samples: int = 0
    discontinuities: int = 0
    gap_seconds: float = 0.0

    def observe(self, media_ts: float, wall_ts: float | None = None) -> str | None:
        """Record one observation. Returns a discontinuity kind, or None."""
        wall_ts = wall_ts if wall_ts is not None else time.time()
        kind: str | None = None
        if self.first_media_ts is None:
            self.first_media_ts, self.first_wall_ts = media_ts, wall_ts
        else:
            delta = media_ts - self.last_media_ts
            if delta < -DISCONTINUITY_SECONDS:
                kind = "reset"          # the source restarted its timeline
                self.discontinuities += 1
            elif delta > DISCONTINUITY_SECONDS:
                kind = "gap"            # we were not receiving for a while
                self.discontinuities += 1
                self.gap_seconds += delta
        self.last_media_ts, self.last_wall_ts = media_ts, wall_ts
        self.samples += 1
        return kind

    @property
    def elapsed_media(self) -> float:
        if self.first_media_ts is None:
            return 0.0
        return max(0.0, self.last_media_ts - self.first_media_ts)

    @property
    def elapsed_wall(self) -> float:
        if self.first_wall_ts is None:
            return 0.0
        return max(0.0, self.last_wall_ts - self.first_wall_ts)

    @property
    def lag_seconds(self) -> float:
        """How far behind real time this stream's media clock has fallen.

        Positive means the stream is producing media slower than the wall
        clock advances — the usual sign of a source that cannot keep up.
        """
        return round(self.elapsed_wall - self.elapsed_media, 3)

    def to_dict(self) -> dict[str, Any]:
        return {
            "samples": self.samples,
            "first_media_ts": self.first_media_ts,
            "last_media_ts": round(self.last_media_ts, 3),
            "elapsed_media": round(self.elapsed_media, 3),
            "elapsed_wall": round(self.elapsed_wall, 3),
            "lag_seconds": self.lag_seconds,
            "discontinuities": self.discontinuities,
            "gap_seconds": round(self.gap_seconds, 3),
        }


@dataclass
class SessionClock:
    """The session's time origin and the streams measured against it."""

    session_id: str
    started_wall: float = field(default_factory=time.time)
    started_monotonic: float = field(default_factory=time.monotonic)
    streams: dict[str, StreamClock] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def stream(self, name: str) -> StreamClock:
        with self._lock:
            if name not in self.streams:
                self.streams[name] = StreamClock(name=name)
            return self.streams[name]

    def observe(
        self, name: str, media_ts: float, wall_ts: float | None = None
    ) -> str | None:
        with self._lock:
            clock = self.streams.setdefault(name, StreamClock(name=name))
            return clock.observe(media_ts, wall_ts)

    def wall_for(self, media_ts: float) -> float:
        """Convert a media timestamp to wall time for display.

        Uses the session origin rather than any stream's own arrival times,
        so two streams that disagree by a few hundred milliseconds still map
        into one human-readable timeline.
        """
        return self.started_wall + media_ts

    def drift_seconds(self, left: str = "video", right: str = "audio") -> float | None:
        """How far apart the two streams' media clocks have got.

        None when either stream has produced nothing — an absent stream is
        not a drift of zero, and reporting it as zero would claim a
        synchronisation that was never measured.
        """
        with self._lock:
            a, b = self.streams.get(left), self.streams.get(right)
        if a is None or b is None or not a.samples or not b.samples:
            return None
        return round(a.last_media_ts - b.last_media_ts, 3)

    def in_sync(self, tolerance: float = DEFAULT_WINDOW) -> bool | None:
        drift = self.drift_seconds()
        return None if drift is None else abs(drift) <= tolerance

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            streams = {name: clock.to_dict() for name, clock in self.streams.items()}
        drift = self.drift_seconds()
        return {
            "session_id": self.session_id,
            "started_wall": self.started_wall,
            "streams": streams,
            "av_drift_seconds": drift,
            "in_sync": self.in_sync(),
            "sync_tolerance_seconds": DEFAULT_WINDOW,
        }


def aligned_window(media_ts: float, window: float = DEFAULT_WINDOW) -> tuple[float, float]:
    """The interval another stream must fall inside to count as simultaneous."""
    return (max(0.0, media_ts - window), media_ts + window)


def correlate(
    anchor_ts: float,
    candidates: list[Any],
    window: float = DEFAULT_WINDOW,
    key: Any = None,
) -> list[Any]:
    """Everything within `window` of an anchor, nearest first.

    Deterministic and explainable on purpose: this is what answers "what was
    visible when they said X", and a ranking an operator cannot reproduce by
    hand is one they cannot check.
    """
    getter = key or (lambda item: getattr(item, "media_ts", 0.0))
    low, high = aligned_window(anchor_ts, window)
    hits = [item for item in candidates if low <= getter(item) <= high]
    return sorted(hits, key=lambda item: abs(getter(item) - anchor_ts))
