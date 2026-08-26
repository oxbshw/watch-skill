"""Turn Adversal MCP 0.1.4's prose replies into typed outcomes.

Every tool on the 0.1.4 server is declared ``-> str`` and answers in English
sentences. There is no structured error object, no status enum, and no
machine-readable envelope: a caller learns what happened by reading the first
word of a paragraph.

That is a finding about the interface, and this module is where the cost of
it is paid. It is deliberately kept apart from the transport so it can be
tested against captured strings without a network, a subprocess or an
account — and so the day a structured API arrives, the replacement is one
file rather than a rewrite.

The classification is prefix-driven because the server's own messages are:
every terminal state begins with an upper-case word before an em dash. Where
a message carries no such marker the result is
:attr:`OutcomeStatus.UNKNOWN`, never a guess — an unclassifiable reply is
exactly the sort of thing this evaluation exists to surface.
"""
from __future__ import annotations

import re

from watch_skill.bench.video_backends.types import OutcomeStatus

# Ordered: the first pattern that matches wins, so the specific
# "NOT SUBMITTED" is tested before a bare "NOT READY" could shadow it.
_PREFIX_RULES: list[tuple[re.Pattern[str], OutcomeStatus]] = [
    (re.compile(r"^\s*AUTHENTICATION REQUIRED\b", re.I), OutcomeStatus.AUTH_REQUIRED),
    (re.compile(r"^\s*AUTHENTICATION SERVICE UNAVAILABLE\b", re.I),
     OutcomeStatus.TRANSPORT_ERROR),
    (re.compile(r"^\s*QUOTA EXHAUSTED\b", re.I), OutcomeStatus.QUOTA_EXHAUSTED),
    # Found by running the real sign-in: `AUTHENTICATED as <name>.` carried no
    # marker the first version of this table recognised, so a successful
    # authentication classified as UNKNOWN.
    (re.compile(r"^\s*AUTHENTICATION FAILED\b", re.I), OutcomeStatus.AUTH_REQUIRED),
    (re.compile(r"^\s*AUTHENTICATED\b", re.I), OutcomeStatus.OK),
    (re.compile(r"^\s*SUCCESS\b", re.I), OutcomeStatus.OK),
    (re.compile(r"^\s*COMPLETED\b", re.I), OutcomeStatus.OK),
    (re.compile(r"^\s*FOUND\b", re.I), OutcomeStatus.OK),
    (re.compile(r"^\s*NOT SUBMITTED\b", re.I), OutcomeStatus.NOT_SUBMITTED),
    (re.compile(r"^\s*NOT READY\b", re.I), OutcomeStatus.NOT_READY),
    (re.compile(r"^\s*RUNNING\b", re.I), OutcomeStatus.NOT_READY),
    (re.compile(r"^\s*UNAVAILABLE\b", re.I), OutcomeStatus.UNAVAILABLE),
    (re.compile(r"^\s*FAILED\b", re.I), OutcomeStatus.FAILED),
    (re.compile(r"^\s*UNKNOWN\b", re.I), OutcomeStatus.NOT_SUBMITTED),
    (re.compile(r"^\s*VIDEO TOO LARGE\b", re.I), OutcomeStatus.INVALID_INPUT),
]

# Messages with no upper-case marker at all. These are the argument-validation
# refusals, which the server returns as plain sentences.
_BODY_RULES: list[tuple[re.Pattern[str], OutcomeStatus]] = [
    (re.compile(r"^Provide exactly one source\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Provide exactly one of\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^output_path is required"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Video file not found\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Video file is not readable or is empty\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^video_url must\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Invalid (timestamps|focused time window|requested timestamp)\b"),
     OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^MCP preflight failed\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Could not hash video file\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^Video file (changed|contents changed)\b"), OutcomeStatus.INVALID_INPUT),
    (re.compile(r"^This video already has a non-failed processing job\b"),
     OutcomeStatus.OK),
    # A 409 carrying `evaluation_in_process` is the backend refusing a second
    # submission while one is still running — an account-level concurrency
    # limit, not a broken connection. It is retryable by waiting, so it maps to
    # NOT_READY. Worth noting how it arrives: an HTTP status and a JSON detail,
    # both real structure, wrapped inside an English sentence and recovered by
    # regex.
    (re.compile(r"^Backend error 409\b.*evaluation_in_process"), OutcomeStatus.NOT_READY),
    (re.compile(r"^Backend error \d+\b"), OutcomeStatus.TRANSPORT_ERROR),
    (re.compile(r"^HTTP connection error\b"), OutcomeStatus.TRANSPORT_ERROR),
    (re.compile(r"^Could not write the \w+ output\b"), OutcomeStatus.TRANSPORT_ERROR),
    (re.compile(r"^Unexpected error while checking status\b"), OutcomeStatus.UNKNOWN),
]

_REQUEST_ID = re.compile(r"request_id:\s*([A-Za-z0-9_.:-]+)")
_OUTPUT_PATH = re.compile(r"output_path:\s*(.+)")
_STATUS_FIELD = re.compile(r"status:\s*([A-Z_]+)")
_HASH_FIELD = re.compile(r"hash:\s*([0-9a-f]{16,})", re.I)
_MINUTES = re.compile(r"([\d.]+)\s*minutes?", re.I)


def classify(message: str) -> OutcomeStatus:
    """The typed status of one reply. Never a guess."""
    if not message or not message.strip():
        return OutcomeStatus.UNKNOWN
    text = message.strip()
    for pattern, status in _PREFIX_RULES:
        if pattern.search(text):
            return status
    for pattern, status in _BODY_RULES:
        if pattern.search(text):
            return status
    return OutcomeStatus.UNKNOWN


def request_id(message: str) -> str | None:
    """The job handle, when the reply carried one.

    Not redacted anywhere downstream: it is the correlation key the vendor
    needs to find the same run on their side, and it is not a secret.
    """
    match = _REQUEST_ID.search(message or "")
    return match.group(1) if match else None


def output_path(message: str) -> str | None:
    match = _OUTPUT_PATH.search(message or "")
    return match.group(1).strip() if match else None


def reported_status(message: str) -> str | None:
    """The ``status: RUNNING`` field, where a reply spells one out."""
    match = _STATUS_FIELD.search(message or "")
    return match.group(1) if match else None


def content_hash(message: str) -> str | None:
    """The MD5 the server keyed its local job registry on."""
    match = _HASH_FIELD.search(message or "")
    return match.group(1).lower() if match else None


def remaining_minutes(message: str) -> float | None:
    """Minutes left, when the quota reply states a number."""
    match = _MINUTES.search(message or "")
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def is_retryable(status: OutcomeStatus) -> bool:
    """Whether the caller should wait and ask again.

    0.1.4 does not say this itself — nothing in a reply distinguishes "try
    again in thirty seconds" from "this will never work". The mapping is ours,
    inferred from the message text, and the report says so rather than
    presenting it as a property of the provider.
    """
    return status.is_retryable
