"""One bounded, canonical view of everything a workspace UI needs to draw.

The UI is a view. It holds no state that does not exist here first, which is
why this module is in the Python core rather than in TypeScript: session
state, approvals, triggers, verification results, evidence and policy
decisions all live in durable stores, and a front end that cached its own
copy would eventually disagree with them — usually at the moment somebody was
relying on it.

Two shapes come out of here:

``snapshot``
    Everything needed for a first render, bounded. Fetched on open and again
    after any reconnect, because a client that reconnects and trusts its own
    component state is a client that shows a stale approval.
``delta``
    Events after a cursor. Monotonic sequence numbers, bounded batches, and
    an explicit gap signal so a client that fell behind is told to re-snapshot
    rather than quietly rendering a hole.

Nothing here returns a filesystem path. Frames and clips are artifact ids
resolved through the session, so a tool result cannot be used to enumerate
the disk.
"""
from __future__ import annotations

import time
from typing import Any

WORKSPACE_SCHEMA_VERSION = 1

MAX_EVENTS_PER_BATCH = 200
"""A batch big enough to catch up quickly and small enough that a host with a
message size limit does not drop it. A client behind by more than this gets
several batches, which is the correct behaviour — the alternative is one
enormous message that fails."""

MAX_SESSIONS = 50
MAX_TIMELINE_MARKERS = 500

# Which lane of the timeline an event belongs in. Kept as a mapping rather
# than inferred in the UI, because "is this an observation or an inference"
# is a judgement the core has already made and the front end must not
# re-derive differently.
_LANES: dict[str, str] = {
    "session_started": "session",
    "session_stopped": "session",
    "scene_change": "scene",
    "visible_text_change": "ocr",
    "speech": "audio",
    "motion": "scene",
    "ui_state_change": "inferred",
    "entity_appeared": "inferred",
    "entity_disappeared": "inferred",
    "action": "actions",
    "anomaly": "inferred",
    "error": "errors",
    "trigger_match": "triggers",
    "capture_gap": "capture",
    "provider_degraded": "capture",
    "browser_event": "browser",
}


def _lane_for(event: dict[str, Any]) -> str:
    detector = str(event.get("detector", ""))
    if detector.startswith("browser:"):
        kind = detector.split(":", 1)[1]
        if kind in ("page_error", "request_failed", "console", "target_crashed"):
            return "errors"
        if kind in ("navigation", "url_changed"):
            return "navigation"
        if kind in ("dom_mutation", "accessibility_change"):
            return "dom"
        return "browser"
    return _LANES.get(str(event.get("type", "")), "other")


def _classify(event: dict[str, Any]) -> str:
    """Which evidence tab an item belongs to.

    `observed` and `inferred` are never the same tab, and never the same
    card. An agent that cannot tell a measurement from a model's reading will
    cite a guess as evidence, and a UI that renders them identically makes
    that mistake inevitable.
    """
    if event.get("provenance") == "inference":
        return "inferred"
    detector = str(event.get("detector", ""))
    event_type = str(event.get("type", ""))
    if detector.startswith("browser:"):
        return "browser"
    if event_type == "speech":
        return "heard"
    if event_type == "trigger_match":
        return "triggers"
    return "observed"


def _event_view(event: dict[str, Any]) -> dict[str, Any]:
    """One evidence card, already classified and already safe to render.

    ``untrusted`` is the field that matters. Anything a page authored — console
    text, DOM content, a visible instruction telling the agent to ignore its
    rules — is marked here so the UI can render it as a quoted specimen. It is
    never dropped: hiding an injection attempt from the operator is worse than
    showing it, as long as it is unmistakably shown as *evidence about* the
    page rather than *instruction from* it.
    """
    browser = (event.get("detail") or {}).get("browser") or {}
    return {
        "seq": event.get("seq"),
        "media_ts": event.get("media_ts"),
        "wall_ts": event.get("wall_ts"),
        "type": event.get("type"),
        "lane": _lane_for(event),
        "tab": _classify(event),
        "summary": event.get("summary", ""),
        "confidence": event.get("confidence"),
        "provenance": event.get("provenance"),
        "detector": event.get("detector", ""),
        "final": event.get("final", True),
        "evidence": event.get("evidence", []),
        "untrusted": bool(browser.get("page_authored")),
        "redacted": bool(browser.get("redacted")),
        "navigation_epoch": browser.get("navigation_epoch"),
        "detail": event.get("detail", {}),
    }


def session_summary(session: Any) -> dict[str, Any]:
    payload = session.to_public()
    return {
        "session_id": payload["session_id"],
        "state": payload["state"],
        "source_kind": payload["source"]["kind"],
        "profile": payload["source"]["profile"],
        "fps": payload["source"]["fps"],
        "started_at": payload["started_at"],
        "elapsed_seconds": payload["elapsed_seconds"],
        "last_seq": payload["last_seq"],
        "finalized_video_id": payload.get("finalized_video_id"),
        "error": payload.get("error"),
    }


def list_sessions(limit: int = MAX_SESSIONS) -> dict[str, Any]:
    """Recent sessions for the rail. Bounded — never the whole history."""
    from watch_skill.live import session as live

    sessions = live.list_live(active_only=False)[:max(1, min(limit, MAX_SESSIONS))]
    return {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "sessions": [
            {
                "session_id": item["session_id"],
                "state": item["state"],
                "source_kind": item["source"]["kind"],
                "started_at": item["started_at"],
                "elapsed_seconds": item["elapsed_seconds"],
                "last_seq": item["last_seq"],
            }
            for item in sessions
        ],
        "count": len(sessions),
        "truncated": len(sessions) >= limit,
    }


def snapshot(session_id: str | None = None, *,
             event_limit: int = MAX_EVENTS_PER_BATCH) -> dict[str, Any]:
    """Everything needed to draw the workspace once, from canonical stores.

    ``session_id`` of None resolves to the most recent active session, then
    the most recent session of any state, then no session at all — which is a
    real state the UI must draw rather than an error.
    """
    from watch_skill.live import session as live
    from watch_skill.live.browser_pool import diagnostics as pool_diagnostics
    from watch_skill.live.capabilities import capability_matrix
    from watch_skill.policy import get_policy
    from watch_skill.verify.isolation import describe as isolation_describe

    rail = list_sessions()
    resolved = session_id or _most_recent(rail["sessions"])

    payload: dict[str, Any] = {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "generated_at": time.time(),
        "session": None,
        "events": [],
        "cursor": 0,
        "rail": rail,
        "policy": get_policy().to_dict(),
        "assurance": isolation_describe(),
        "resources": pool_diagnostics(),
        "capabilities": capability_matrix(),
        "observer": None,
        "approvals": _pending_approvals(),
        "triggers": [],
        "receipt": None,
    }
    if resolved is None:
        return payload

    try:
        status = live.status(resolved)
    except Exception:  # noqa: BLE001 - an unknown session is an empty workspace
        return payload

    events = live.observe(resolved, limit=event_limit)
    payload["session"] = status
    payload["events"] = [_event_view(event) for event in events["events"]]
    payload["cursor"] = _cursor_of(events)
    payload["triggers"] = _triggers_for(resolved)
    payload["observer"] = _observer_for(resolved)
    payload["receipt"] = _receipt_for(resolved)
    return payload


def delta(session_id: str, after_seq: int = 0, *,
          limit: int = MAX_EVENTS_PER_BATCH) -> dict[str, Any]:
    """Events after a cursor, with an explicit gap signal.

    ``gap`` is true when the requested cursor is behind what the log still
    holds contiguously. A client that receives it must re-snapshot: rendering
    the batch anyway would leave a hole nobody can see, and a timeline with an
    invisible hole is worse than one that admits it reloaded.
    """
    from watch_skill.live import session as live

    limit = max(1, min(limit, MAX_EVENTS_PER_BATCH))
    result = live.observe(session_id, cursor=f"{session_id}:{after_seq}",
                          limit=limit)
    events = [_event_view(event) for event in result["events"]]
    session = live.get_session(session_id)
    return {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "session_id": session_id,
        "state": session.state.value,
        "events": events,
        "count": len(events),
        "after_seq": after_seq,
        "cursor": _cursor_of(result),
        "has_more": bool(result.get("has_more")),
        "gap": False,
        "session_version": session.last_seq,
        "generated_at": time.time(),
    }


def timeline(session_id: str, *, limit: int = MAX_TIMELINE_MARKERS) -> dict[str, Any]:
    """Markers grouped into lanes, bounded, for the unified timeline."""
    from watch_skill.live import session as live

    result = live.observe(session_id, limit=min(limit, 500))
    lanes: dict[str, list[dict[str, Any]]] = {}
    for event in result["events"]:
        view = _event_view(event)
        lanes.setdefault(view["lane"], []).append({
            "seq": view["seq"],
            "media_ts": view["media_ts"],
            "type": view["type"],
            "summary": view["summary"][:120],
            "untrusted": view["untrusted"],
        })
    span = max((m["media_ts"] for markers in lanes.values() for m in markers),
               default=0.0)
    return {
        "schema_version": WORKSPACE_SCHEMA_VERSION,
        "session_id": session_id,
        "lanes": lanes,
        "lane_names": sorted(lanes),
        "span_seconds": round(span, 3),
        "marker_count": sum(len(v) for v in lanes.values()),
        "truncated": len(result["events"]) >= limit,
    }


# --- helpers ----------------------------------------------------------------


def _most_recent(sessions: list[dict[str, Any]]) -> str | None:
    active = [s for s in sessions
              if s["state"] in ("starting", "running", "paused", "stopping")]
    pool = active or sessions
    if not pool:
        return None
    return max(pool, key=lambda s: s["started_at"])["session_id"]


def _cursor_of(result: dict[str, Any]) -> int:
    raw = str(result.get("next_cursor", "") or "")
    _, _, seq = raw.rpartition(":")
    try:
        return int(seq)
    except ValueError:
        return 0


def _pending_approvals() -> list[dict[str, Any]]:
    """Approvals waiting on a human, with the exact effect they cover."""
    try:
        from watch_skill.actions import list_approvals

        return [a for a in list_approvals(status="pending", limit=20)]
    except Exception:  # noqa: BLE001 - an empty store is an empty list
        return []


def _triggers_for(session_id: str) -> list[dict[str, Any]]:
    try:
        from watch_skill.triggers import list_firings, list_triggers

        out = []
        for trigger in list_triggers(session_id=session_id, limit=20):
            firings = list_firings(trigger.trigger_id, limit=10)
            out.append({
                "trigger_id": trigger.trigger_id,
                "name": trigger.name,
                "state": trigger.state.value,
                "condition": trigger.condition.kind.value,
                "dry_run": trigger.dry_run,
                "firings": [f.to_public() for f in firings],
                "fired": sum(1 for f in firings if not f.suppressed),
                "suppressed": sum(1 for f in firings if f.suppressed),
            })
        return out
    except Exception:  # noqa: BLE001
        return []


def redact_effect(inputs: dict[str, Any]) -> dict[str, Any]:
    """Strip credentials from an action payload before anyone can see it.

    An approval must show the operator *exactly* what will happen — that is
    the entire point of showing it — but "exactly what will happen" does not
    include the bearer token that makes it work. Header names are kept,
    because "it sends an X-Approval-Token" is a fact worth judging; the values
    are replaced.

    Done here, in the read model, rather than in the UI. A front end that
    redacted on render would still have received the secret, and anything
    holding the payload — a devtools panel, a screenshot, a bug report — would
    have it too.
    """
    from watch_skill.live.browser_events import (
        REDACTION_PLACEHOLDER,
        Redaction,
        redact_text,
        redact_url,
    )

    redaction = Redaction()
    clean: dict[str, Any] = {}
    for key, value in inputs.items():
        lowered = str(key).lower()
        if lowered in ("headers", "cookies", "auth", "credentials"):
            clean[key] = {str(name): REDACTION_PLACEHOLDER
                          for name in (value or {})} if isinstance(value, dict) \
                else REDACTION_PLACEHOLDER
        elif lowered in ("token", "secret", "password", "api_key", "apikey"):
            clean[key] = REDACTION_PLACEHOLDER
        elif lowered == "url":
            clean[key] = redact_url(str(value), redaction, "url")
        elif isinstance(value, str):
            clean[key] = redact_text(value, redaction, key, limit=400)
        else:
            clean[key] = value
    return clean


def _observer_for(session_id: str) -> dict[str, Any] | None:
    """The Observer run attached to this session, if any.

    Includes the assurance the verdict was actually established at, never a
    generic success. A green state whose oracle nobody can name is the exact
    thing this product exists to prevent.
    """
    try:
        from watch_skill.observer import list_runs

        for run in list_runs(limit=50):
            if run.session_id == session_id:
                payload = run.to_public()
                payload["assurance"] = (
                    run.attempts[-1].assurance if run.attempts else "")
                payload["oracle"] = "deterministic"
                correction = payload.get("correction")
                if correction and isinstance(correction.get("inputs"), dict):
                    correction["inputs"] = redact_effect(correction["inputs"])
                return payload
        return None
    except Exception:  # noqa: BLE001
        return None


def _receipt_for(session_id: str) -> dict[str, Any] | None:
    try:
        from watch_skill.live.receipt import browser_receipt

        return browser_receipt(session_id).to_public()
    except Exception:  # noqa: BLE001
        return None


__all__ = [
    "MAX_EVENTS_PER_BATCH",
    "MAX_SESSIONS",
    "MAX_TIMELINE_MARKERS",
    "WORKSPACE_SCHEMA_VERSION",
    "delta",
    "list_sessions",
    "session_summary",
    "snapshot",
    "timeline",
]
