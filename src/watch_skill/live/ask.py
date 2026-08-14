"""Answering questions about a live session, from evidence rather than guesswork.

Answers are built from the event log and the OCR/state changes behind it, and
every claim carries the media timestamp it came from. When nothing in the
window supports an answer, that is what comes back — a live view that invents
an answer is worse than one that says it did not see.

No model is called per frame. A question selects a small number of already
captured frames; interpreting those is where a vision model belongs, and it
stays optional and policy-gated.
"""
from __future__ import annotations

import re
import time
from typing import Any

from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live.types import LiveEventType

_STOPWORDS = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "what", "whats", "when",
    "where", "which", "who", "does", "do", "did", "on", "in", "at", "of",
    "to", "for", "and", "or", "it", "this", "that", "now", "screen", "video",
    "show", "showing", "shown", "happening", "happened", "currently",
})


def _keywords(question: str) -> set[str]:
    words = {w.lower() for w in re.findall(r"[^\W\d_]{2,}|\d[\d.,:%$€£-]*", question)}
    return words - _STOPWORDS


def _score(event: Any, keywords: set[str]) -> float:
    """How much an event has to do with the question.

    Deliberately transparent: token overlap over the event's own text. A
    ranking an operator cannot explain is a ranking they cannot debug, and
    this is the layer that decides which evidence gets cited.
    """
    haystack = " ".join([
        event.summary,
        *(str(c.after) for c in event.state_changes),
        *(e.label for e in event.entities),
    ]).lower()
    if not keywords:
        return 0.1
    hits = sum(1 for word in keywords if word in haystack)
    return hits / len(keywords)


def ask_live(
    session_id: str,
    question: str,
    scope: str = "recent",
    seconds: float = 30.0,
    start: float | None = None,
    end: float | None = None,
    max_evidence: int = 6,
) -> dict[str, Any]:
    """Answer a question about a live session with timestamped evidence.

    ``scope``: ``now`` (the latest state), ``recent`` (last ``seconds``),
    ``window`` (explicit ``start``/``end``), or ``session`` (everything).
    """
    from watch_skill.live.session import get_session

    session = get_session(session_id)
    events = db.read_events(session_id, limit=500)
    if not events:
        return {
            "schema_version": 1,
            "session_id": session_id,
            "question": question,
            "answer": "Nothing has been observed in this session yet.",
            "confidence": 0.0,
            "evidence": [],
            "scope": scope,
            "state": session.state.value,
        }

    latest_ts = max(event.media_ts for event in events)
    if scope == "now":
        lo, hi = max(0.0, latest_ts - 3.0), latest_ts
    elif scope == "window":
        lo, hi = (start if start is not None else 0.0), (
            end if end is not None else latest_ts
        )
    elif scope == "session":
        lo, hi = 0.0, latest_ts
    else:
        lo, hi = max(0.0, latest_ts - seconds), latest_ts

    in_scope = [e for e in events if lo <= e.media_ts <= hi and e.final]
    keywords = _keywords(question)
    ranked = sorted(
        in_scope, key=lambda e: (_score(e, keywords), e.media_ts), reverse=True
    )
    relevant = [e for e in ranked if _score(e, keywords) > 0][:max_evidence]
    # With no keyword match, the most recent substantive events are still the
    # honest answer to "what is happening" — but confidence says so.
    fallback = [
        e for e in sorted(in_scope, key=lambda e: e.media_ts, reverse=True)
        if e.type is not LiveEventType.SESSION_STARTED
    ][:max_evidence]
    chosen = relevant or fallback

    evidence: list[dict[str, Any]] = []
    for event in sorted(chosen, key=lambda e: e.media_ts):
        for ref in event.evidence[:1]:
            segment = buf.resolve(session_id, ref.artifact_id)
            evidence.append({
                "media_ts": round(event.media_ts, 3),
                "type": event.type.value,
                "summary": event.summary,
                "artifact_id": ref.artifact_id,
                "available": bool(segment and not segment.expired
                                  and segment.path.is_file()),
            })
        if not event.evidence:
            evidence.append({
                "media_ts": round(event.media_ts, 3),
                "type": event.type.value,
                "summary": event.summary,
                "artifact_id": None,
                "available": False,
            })

    visible = _latest_visible_text(in_scope)
    lines = [
        f"At {hi:.1f}s into the session ({len(in_scope)} events in scope):",
    ]
    if visible:
        lines.append(f"- on screen now: {visible[:400]}")
    for item in evidence[:max_evidence]:
        # A plain hyphen, not an em dash: this string is printed to consoles
        # whose encoding cannot represent one, and a mojibake byte in the
        # middle of an answer reads as corruption.
        lines.append(f"- {item['media_ts']:.1f}s - {item['summary']}")
    if not relevant and keywords:
        lines.append(
            "Nothing in this window matches the question directly; the above "
            "is what was observed."
        )

    confidence = 0.85 if relevant else (0.35 if in_scope else 0.0)
    return {
        "schema_version": 1,
        "session_id": session_id,
        "question": question,
        "answer": "\n".join(lines),
        "confidence": confidence,
        "matched": bool(relevant),
        "evidence": evidence,
        "scope": scope,
        "window": {"start": round(lo, 3), "end": round(hi, 3)},
        "state": session.state.value,
        "answered_at": time.time(),
    }


def _latest_visible_text(events: list[Any]) -> str:
    for event in sorted(events, key=lambda e: e.media_ts, reverse=True):
        for change in event.state_changes:
            if change.key == "visible_text" and change.after:
                return str(change.after).replace("\n", " / ")
    return ""
