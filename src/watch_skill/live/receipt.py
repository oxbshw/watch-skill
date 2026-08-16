"""What a live session actually demonstrated, as a checkable artifact.

A capability matrix built from probing says what a machine *could* do. This
says what a specific session *did* — which channel produced evidence, how
much, and when the first of it arrived. The distinction matters because every
interesting failure in live capture looks like silence: a detector that never
warmed up, a page with no errors, and a broken listener are indistinguishable
from the outside unless something counts.

The receipt is derived entirely from the persisted event log, so it can be
produced from any process, after the session has ended, and re-derived later
to check it still says the same thing.
"""
from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, Field

RECEIPT_SCHEMA_VERSION = 1

# The channels a live browser session claims to produce. Naming them here,
# rather than reading whatever happened to appear, is what makes a *missing*
# channel visible: a receipt derived only from observed events could never
# report that something was absent.
BROWSER_CHANNELS: dict[str, str] = {
    "pixels": "real frames captured from the page",
    "scene_change": "visual change detected from those frames",
    "dom_mutation": "the page's DOM changed",
    "accessibility_change": "an ARIA or disabled-state attribute changed",
    "console": "the page logged to the console",
    "page_error": "the page threw an uncaught exception",
    "request_failed": "a network request failed at the transport level",
    "http_error": "a request completed with a 4xx or 5xx status",
    "navigation": "the page navigated",
    "clip": "a rolling clip was cut around a moment",
}


class ChannelReceipt(BaseModel):
    """One channel's evidence, or an honest statement that there was none."""

    schema_version: int = RECEIPT_SCHEMA_VERSION
    channel: str
    description: str = ""
    observed: bool = False
    count: int = 0
    first_media_ts: float | None = None
    first_seq: int | None = None
    sample: str = ""
    """A short, already-redacted summary of the first instance. Useful in a
    failure message, and never the raw page content — the event log's own
    redaction has already run by the time this reads it."""

    def to_public(self) -> dict[str, Any]:
        return self.model_dump()


class SessionReceipt(BaseModel):
    """Everything one session proved, and everything it did not."""

    schema_version: int = RECEIPT_SCHEMA_VERSION
    session_id: str
    source_kind: str = ""
    state: str = ""
    generated_at: float = Field(default_factory=time.time)
    channels: list[ChannelReceipt] = Field(default_factory=list)
    events_total: int = 0
    frames_captured: int = 0
    navigation_epochs: int = 0
    redactions_applied: int = 0
    page_authored_events: int = 0
    cross_process: bool = False
    """True when this receipt was derived in a process that did not run the
    session. Set by the caller, because only the caller knows."""

    @property
    def observed_channels(self) -> list[str]:
        return [c.channel for c in self.channels if c.observed]

    @property
    def missing_channels(self) -> list[str]:
        return [c.channel for c in self.channels if not c.observed]

    @property
    def complete(self) -> bool:
        return not self.missing_channels

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "source_kind": self.source_kind,
            "state": self.state,
            "generated_at": self.generated_at,
            "complete": self.complete,
            "observed": self.observed_channels,
            "missing": self.missing_channels,
            "channels": [c.to_public() for c in self.channels],
            "totals": {
                "events": self.events_total,
                "frames_captured": self.frames_captured,
                "navigation_epochs": self.navigation_epochs,
                "redactions_applied": self.redactions_applied,
                "page_authored_events": self.page_authored_events,
            },
            "cross_process": self.cross_process,
        }

    def render(self) -> str:
        """A short human-readable table. Used in reports and failure output."""
        lines = [f"live session {self.session_id} ({self.source_kind}, "
                 f"{self.state})",
                 f"  {'complete' if self.complete else 'INCOMPLETE'}: "
                 f"{len(self.observed_channels)}/{len(self.channels)} channels"]
        for channel in self.channels:
            mark = "ok " if channel.observed else "MISSING"
            when = (f"@{channel.first_media_ts:6.2f}s"
                    if channel.first_media_ts is not None else "        ")
            lines.append(f"  {mark:>7}  {channel.channel:<21} {when} "
                         f"x{channel.count:<4} {channel.sample[:52]}")
        return "\n".join(lines)


def browser_receipt(session_id: str, *, cross_process: bool = False,
                    limit: int = 2000) -> SessionReceipt:
    """Derive a browser session's receipt from its persisted event log.

    Reads only what was written down. Nothing in-memory contributes, which is
    what lets the same function run in a fresh interpreter and produce the
    same answer — and what makes disagreement between the two a real finding
    rather than a quirk of timing.
    """
    from watch_skill.live import buffer as buf
    from watch_skill.live import db

    session = db.get_session(session_id)
    events = db.read_events(session_id, limit=limit)

    found: dict[str, ChannelReceipt] = {
        name: ChannelReceipt(channel=name, description=description)
        for name, description in BROWSER_CHANNELS.items()
    }
    epochs: set[int] = set()
    redactions = 0
    page_authored = 0

    def note(channel: str, seq: int, media_ts: float, sample: str) -> None:
        receipt = found[channel]
        receipt.count += 1
        if not receipt.observed:
            receipt.observed = True
            receipt.first_seq = seq
            receipt.first_media_ts = round(media_ts, 3)
            receipt.sample = sample[:200]

    for event in events:
        browser = (event.detail or {}).get("browser") or {}
        kind = browser.get("kind", "")
        if browser:
            epochs.add(int(browser.get("navigation_epoch", 0)))
            if browser.get("redacted"):
                redactions += 1
            if browser.get("page_authored"):
                page_authored += 1

        if event.type.value == "scene_change":
            note("scene_change", event.seq, event.media_ts, event.summary)
        if kind == "dom_mutation":
            note("dom_mutation", event.seq, event.media_ts, event.summary)
        elif kind == "accessibility_change":
            note("accessibility_change", event.seq, event.media_ts, event.summary)
        elif kind == "console":
            note("console", event.seq, event.media_ts, event.summary)
        elif kind == "page_error":
            note("page_error", event.seq, event.media_ts, event.summary)
        elif kind == "request_failed":
            note("request_failed", event.seq, event.media_ts, event.summary)
        elif kind in ("navigation", "url_changed"):
            note("navigation", event.seq, event.media_ts, event.summary)
        elif kind == "response":
            try:
                status = int(browser.get("detail", {}).get("status", 0))
            except (TypeError, ValueError):
                status = 0
            if status >= 400:
                note("http_error", event.seq, event.media_ts, event.summary)

    frames = buf.frames_between(session_id, 0.0, 10**9, limit=10_000)
    for frame in frames:
        note("pixels", 0, frame.media_ts, frame.path.name)
    for clip in _clips(session_id):
        note("clip", 0, clip.media_ts, clip.path.name)

    return SessionReceipt(
        session_id=session_id,
        source_kind=session.spec.kind.value if session else "",
        state=session.state.value if session else "unknown",
        channels=list(found.values()),
        events_total=len(events),
        frames_captured=len(frames),
        navigation_epochs=len(epochs - {0}),
        redactions_applied=redactions,
        page_authored_events=page_authored,
        cross_process=cross_process,
    )


def _clips(session_id: str):  # noqa: ANN201 - list[Segment], avoids the import
    from pathlib import Path  # noqa: PLC0415

    from watch_skill.live.buffer import Segment  # noqa: PLC0415
    from watch_skill.live.db import connect

    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM live_segments WHERE session_id = ? AND kind = 'clip' "
            "AND expired = 0 ORDER BY media_ts", (session_id,)).fetchall()
        return [Segment(r["artifact_id"], r["kind"], Path(r["path"]),
                        r["media_ts"], r["end_media_ts"], r["bytes"],
                        bool(r["pinned"]), bool(r["expired"])) for r in rows]
    finally:
        conn.close()


__all__ = [
    "BROWSER_CHANNELS",
    "RECEIPT_SCHEMA_VERSION",
    "ChannelReceipt",
    "SessionReceipt",
    "browser_receipt",
]
