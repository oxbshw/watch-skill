"""Webhook delivery for monitor events — what opens the monitor to
n8n/Zapier builders.

Set ``WATCHSKILL_WEBHOOK_URL`` and every monitor event POSTs there as
JSON, signed with HMAC-SHA256 when ``WATCHSKILL_WEBHOOK_SECRET`` is set:

    POST <url>
    Content-Type: application/json
    X-WatchSkill-Event: monitor.detection
    X-WatchSkill-Signature: sha256=<hmac of the exact body bytes>

Body = the same event object events.jsonl carries::

    {"monitor_id": "...", "check": 0, "source": "...", "condition": "...",
     "detections": [{"timestamp": 0.46, "severity": "critical",
                     "description": "..."}],
     "at": "2026-07-11T12:00:00+00:00"}

Delivery is at-least-once with bounded retry (3 attempts, 1 s / 3 s
backoff) and never raises — a dead receiver must not kill the watch.
Verify on the receiving side by recomputing the HMAC over the raw body.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
from collections.abc import Callable
from typing import Any

import httpx

_ATTEMPTS = 3
_BACKOFFS = (1.0, 3.0)
_TIMEOUT = 10.0


def deliver_event(
    event: dict[str, Any],
    url: str,
    secret: str | None = None,
    _sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """POST one event; True when a 2xx came back within the retry budget."""
    body = json.dumps(event, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-WatchSkill-Event": "monitor.detection",
    }
    if secret:
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        headers["X-WatchSkill-Signature"] = f"sha256={digest}"
    for attempt in range(_ATTEMPTS):
        try:
            response = httpx.post(url, content=body, headers=headers, timeout=_TIMEOUT)
            if 200 <= response.status_code < 300:
                return True
            print(
                f"[watch-skill] webhook got HTTP {response.status_code} "
                f"(attempt {attempt + 1}/{_ATTEMPTS})",
                file=sys.stderr,
            )
        except httpx.HTTPError as exc:
            print(
                f"[watch-skill] webhook delivery failed: {exc} "
                f"(attempt {attempt + 1}/{_ATTEMPTS})",
                file=sys.stderr,
            )
        if attempt < len(_BACKOFFS):
            _sleep(_BACKOFFS[attempt])
    return False


def webhook_on_event(
    chained: Callable[[dict[str, Any]], None] | None = None,
) -> Callable[[dict[str, Any]], None] | None:
    """An on_event callback delivering to the configured webhook, or None
    when no URL is configured. Chains an existing callback (both run)."""
    from watch_skill.config import get_settings

    settings = get_settings()
    url = getattr(settings, "webhook_url", None)
    if not url:
        return chained
    secret_setting = getattr(settings, "webhook_secret", None)
    secret = secret_setting.get_secret_value() if secret_setting else None

    def send(event: dict[str, Any]) -> None:
        if chained is not None:
            chained(event)
        deliver_event(event, url, secret)

    return send
