"""Structured evidence from a watched browser, and what is stripped from it.

Two rules shape this module.

**Structured evidence never replaces pixels.** A DOM mutation says the page
*claims* to have changed; a frame shows what a human would have seen. They are
separate channels with separate provenance, and a browser session that emitted
only the former would be a scraper, not a witness.

**Everything here came from a hostile page.** Console text, DOM content, URLs,
and response headers are authored by whatever was loaded. So this module's
main job is the boring one: bound every string, drop every credential, and
stamp each event with where it came from and what was removed, so that
downstream code can tell page-authored text from Watch Skill's own.
"""
from __future__ import annotations

import re
from enum import Enum
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from pydantic import BaseModel, Field

from watch_skill.live.types import LIVE_SCHEMA_VERSION, Provenance

MAX_TEXT = 2000
"""Ceiling on any single page-authored string. A console.log of a 50 MB base64
blob is a plausible accident and a trivial memory-exhaustion attack."""

MAX_SNAPSHOT_NODES = 400
MAX_ATTRIBUTES = 24


class BrowserEventKind(str, Enum):  # noqa: UP042 — matches LiveEventType
    """What kinds of structured thing a browser session reports."""

    NAVIGATION = "navigation"
    NAVIGATION_FAILED = "navigation_failed"
    URL_CHANGED = "url_changed"
    DOM_MUTATION = "dom_mutation"
    ACCESSIBILITY_CHANGE = "accessibility_change"
    CONSOLE = "console"
    PAGE_ERROR = "page_error"
    REQUEST_FAILED = "request_failed"
    REQUEST = "request"
    RESPONSE = "response"
    PERFORMANCE = "performance"
    DOWNLOAD = "download"
    POPUP = "popup"
    DIALOG = "dialog"
    TARGET_CRASHED = "target_crashed"
    TARGET_CLOSED = "target_closed"


# Event kinds a page could plausibly want to forge — anything that would make
# an agent believe the browser itself reported something. Page JavaScript
# reaches this module only through the DOM-mutation and accessibility channels,
# and `INTERNAL_KINDS` is what those channels may never claim to be.
INTERNAL_KINDS = frozenset({
    BrowserEventKind.NAVIGATION,
    BrowserEventKind.NAVIGATION_FAILED,
    BrowserEventKind.TARGET_CRASHED,
    BrowserEventKind.TARGET_CLOSED,
    BrowserEventKind.DOWNLOAD,
    BrowserEventKind.POPUP,
})

_SECRET_HEADERS = frozenset({
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token",
    "authentication", "x-amz-security-token", "x-goog-api-key",
    "x-access-token", "x-session-token", "x-secret", "x-signature",
})

_SECRET_QUERY_KEYS = re.compile(
    r"(?:^|_|-)(?:token|secret|password|passwd|pwd|key|apikey|api_key|auth|"
    r"credential|session|sig|signature|access[_-]?token|refresh[_-]?token|"
    r"id[_-]?token|code)(?:$|_|-)",
    re.IGNORECASE,
)

# Values that look like credentials wherever they appear, including in console
# text a page printed. Conservative on purpose: a false positive costs a
# redacted log line, a false negative writes a live key to disk.
_SECRET_VALUE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._\-+/=]{12,}", re.IGNORECASE)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}")),
    ("aws_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}")),
    ("google_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{8,}")),
    ("private_key", re.compile(r"-----BEGIN[ A-Z]*PRIVATE KEY-----")),
)

REDACTION_PLACEHOLDER = "[redacted]"


class Redaction(BaseModel):
    """What was removed from an event, and why.

    Recorded rather than silent: an operator reading evidence needs to know
    the difference between "the page sent no Authorization header" and "it did
    and we dropped it", and a forensic reader needs to know the evidence is
    incomplete by design.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    applied: bool = False
    fields: list[str] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)
    truncated: list[str] = Field(default_factory=list)

    def note(self, field_name: str, kind: str = "secret") -> None:
        self.applied = True
        if field_name not in self.fields:
            self.fields.append(field_name)
        if kind not in self.kinds:
            self.kinds.append(kind)

    def note_truncated(self, field_name: str) -> None:
        self.applied = True
        if field_name not in self.truncated:
            self.truncated.append(field_name)


def redact_text(text: str, redaction: Redaction, field_name: str,
                limit: int = MAX_TEXT) -> str:
    """Bound a page-authored string and mask anything credential-shaped."""
    if not isinstance(text, str):
        text = str(text)
    for kind, pattern in _SECRET_VALUE_PATTERNS:
        text, count = pattern.subn(REDACTION_PLACEHOLDER, text)
        if count:
            redaction.note(field_name, kind)
    if len(text) > limit:
        redaction.note_truncated(field_name)
        text = text[:limit] + "…[truncated]"
    return text


def redact_headers(headers: dict[str, Any], redaction: Redaction,
                   field_name: str = "headers") -> dict[str, str]:
    """Keep header *names*, drop credential values.

    Names are useful evidence — "it sent an Authorization header" is often the
    fact that matters — and the value never is.
    """
    clean: dict[str, str] = {}
    for raw_name, raw_value in list(headers.items())[:MAX_ATTRIBUTES]:
        name = str(raw_name).lower()
        if name in _SECRET_HEADERS:
            clean[name] = REDACTION_PLACEHOLDER
            redaction.note(f"{field_name}.{name}", "header")
            continue
        clean[name] = redact_text(str(raw_value), redaction,
                                  f"{field_name}.{name}", limit=200)
    return clean


def redact_url(url: str, redaction: Redaction, field_name: str = "url") -> str:
    """A URL with credential-shaped query values masked.

    The path is kept whole: it identifies what was requested, and losing it
    would make request evidence useless. Userinfo (``https://user:pw@host``)
    is dropped entirely — there is no version of that worth keeping.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return redact_text(url, redaction, field_name, limit=400)

    netloc = parts.netloc
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[-1]
        redaction.note(f"{field_name}.userinfo", "credential")

    query = parts.query
    if query:
        pairs = parse_qsl(query, keep_blank_values=True)
        rebuilt: list[str] = []
        for key, value in pairs:
            if _SECRET_QUERY_KEYS.search(key):
                rebuilt.append(f"{key}={REDACTION_PLACEHOLDER}")
                redaction.note(f"{field_name}.query.{key}", "query")
            else:
                rebuilt.append(f"{key}={value}")
        query = "&".join(rebuilt)

    rebuilt_url = urlunsplit((parts.scheme, netloc, parts.path, query, ""))
    return redact_text(rebuilt_url, redaction, field_name, limit=400)


class BrowserTarget(BaseModel):
    """Which page, frame and target an event came from.

    An event with no identity is unusable in a session that opened a popup:
    "a console error occurred" is a different fact depending on whether it
    happened in the page being watched or in an ad iframe.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    page_id: str = ""
    frame_id: str = ""
    target_id: str = ""
    frame_url: str = ""
    is_main_frame: bool = True


class BrowserEvent(BaseModel):
    """One structured fact observed in a browser, ready to persist.

    ``navigation_epoch`` is the field that stops the subtlest bug in live
    browser watching: an event that was in flight when the page navigated
    arrives *after* the new page has loaded, and without an epoch it reads as
    a fact about the new page. Every event carries the epoch current when it
    was produced, so a stale one can be recognised rather than believed.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    session_id: str
    kind: BrowserEventKind
    seq: int = 0
    """Monotonic within a session. Assigned by the producer, not the clock, so
    two events in the same millisecond still have a defined order."""

    media_ts: float = 0.0
    wall_ts: float = 0.0
    navigation_epoch: int = 0
    target: BrowserTarget = Field(default_factory=BrowserTarget)
    provenance: Provenance = Provenance.OBSERVATION
    summary: str = ""
    detail: dict[str, Any] = Field(default_factory=dict)
    redaction: Redaction = Field(default_factory=Redaction)
    page_authored: bool = True
    """True when any part of this event's content was written by the page.
    Almost everything here is. Kept explicit so a renderer can mark it and a
    prompt builder can fence it."""

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "kind": self.kind.value,
            "seq": self.seq,
            "media_ts": round(self.media_ts, 3),
            "wall_ts": self.wall_ts,
            "navigation_epoch": self.navigation_epoch,
            "target": self.target.model_dump(),
            "provenance": self.provenance.value,
            "summary": self.summary,
            "detail": self.detail,
            "redacted": self.redaction.applied,
            "redaction": self.redaction.model_dump() if self.redaction.applied else None,
            "page_authored": self.page_authored,
        }


def reject_forged_kind(claimed: str) -> BrowserEventKind:
    """Map a page-supplied event name onto a kind it is allowed to claim.

    Page JavaScript reports DOM and accessibility changes through an exposed
    binding, which means the page chooses the string. If it could choose
    ``navigation`` or ``target_crashed`` it could fabricate browser-level facts
    that an agent would reasonably trust. Anything outside the two channels a
    page legitimately owns collapses to ``dom_mutation``, which is what it
    actually is: something the page said.
    """
    try:
        kind = BrowserEventKind(claimed)
    except ValueError:
        return BrowserEventKind.DOM_MUTATION
    if kind in INTERNAL_KINDS:
        return BrowserEventKind.DOM_MUTATION
    if kind not in (BrowserEventKind.DOM_MUTATION,
                    BrowserEventKind.ACCESSIBILITY_CHANGE):
        return BrowserEventKind.DOM_MUTATION
    return kind


__all__ = [
    "INTERNAL_KINDS",
    "MAX_ATTRIBUTES",
    "MAX_SNAPSHOT_NODES",
    "MAX_TEXT",
    "REDACTION_PLACEHOLDER",
    "BrowserEvent",
    "BrowserEventKind",
    "BrowserTarget",
    "Redaction",
    "redact_headers",
    "redact_text",
    "redact_url",
    "reject_forged_kind",
]
