"""Temporal fusion: correlate what was seen, read and heard into one account.

Two independent event logs are not understanding. A scene change at 7.0 s and
the words "the total is wrong" at 7.2 s are almost certainly the same
happening, and an agent that cannot join them has to guess.

The joining is **deterministic** — timestamp overlap, shared entities, source,
declared state transitions. No model runs here. That is a design constraint,
not an omission: correlation that an operator cannot reproduce by hand is
correlation they cannot check, and this layer decides what gets cited.

The rule that governs everything below:

    An observation is what was seen. An inference is what it might mean.
    They never share a sentence.

A fused event states its observation plainly and carries inferences as a
separate, individually-scored list. A reader — human or model — can always
tell which is which, so "the coupon calculation failed" never gets quoted as
though a camera had recorded it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from watch_skill.live.clock import DEFAULT_WINDOW, correlate
from watch_skill.live.types import (
    LIVE_SCHEMA_VERSION,
    EvidenceReference,
    LiveEvent,
    LiveEventType,
    StateChange,
)


class Inference(BaseModel):
    """A possible meaning, scored and attributable — never stated as fact."""

    schema_version: int = LIVE_SCHEMA_VERSION
    text: str
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    basis: str = ""
    """Which rule or model produced it, so a wrong conclusion is traceable to
    the thing that drew it."""


class EntityObservation(BaseModel):
    """One sighting of an entity at one moment."""

    schema_version: int = LIVE_SCHEMA_VERSION
    entity_id: str
    media_ts: float
    value: str | None = None
    source: str = "ocr"


class EntityTrack(BaseModel):
    """An entity's life across a session: when it appeared, changed, vanished."""

    schema_version: int = LIVE_SCHEMA_VERSION
    entity_id: str
    label: str
    kind: str = "text"
    first_media_ts: float = 0.0
    last_media_ts: float = 0.0
    observations: list[EntityObservation] = Field(default_factory=list)
    present: bool = True
    confidence: float = 1.0

    def decay(self, now_media_ts: float, half_life: float = 10.0) -> float:
        """Confidence falls with time since the last sighting.

        An entity last seen thirty seconds ago is not evidence about now, and
        letting its confidence stay at 1.0 would let stale state answer a
        question about the present.
        """
        age = max(0.0, now_media_ts - self.last_media_ts)
        return round(self.confidence * (0.5 ** (age / half_life)), 3)


class FusedEvent(BaseModel):
    """A correlated account of one happening, across every stream that saw it."""

    schema_version: int = LIVE_SCHEMA_VERSION
    session_id: str
    sequence: int
    type: str
    start_media_ts: float
    end_media_ts: float
    observation: str
    """Only what was actually observed. If no stream recorded it, it does not
    belong in this field."""

    inferences: list[Inference] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    state_changes: list[StateChange] = Field(default_factory=list)
    evidence: list[EvidenceReference] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    provisional: bool = False
    confidence: float = 1.0

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "sequence": self.sequence,
            "type": self.type,
            "start_media_ts": round(self.start_media_ts, 3),
            "end_media_ts": round(self.end_media_ts, 3),
            "observation": self.observation,
            "inferences": [
                {"text": i.text, "confidence": round(i.confidence, 2),
                 "basis": i.basis}
                for i in self.inferences
            ],
            "entities": self.entities,
            "state_changes": [
                {"key": c.key, "before": c.before, "after": c.after}
                for c in self.state_changes
            ],
            "evidence": [
                {"kind": e.kind, "artifact_id": e.artifact_id,
                 "media_ts": round(e.media_ts, 3)}
                for e in self.evidence
            ],
            "sources": self.sources,
            "provisional": self.provisional,
            "confidence": round(self.confidence, 3),
        }


# --- deterministic inference rules --------------------------------------------
#
# Each rule reads correlated observations and proposes a *possible* meaning.
# They are pattern matches over text, not judgements: cheap, explainable, and
# individually disableable. Nothing here is allowed to phrase itself as fact.

_NUMBER = re.compile(r"[-+]?\$?\d[\d,]*\.?\d*")
# `[object Object]` needs its own alternative: `\b` cannot anchor a bracket,
# so folding it into the word-boundary group silently never matched — and it
# is the single most common way a broken value reaches a screen.
_BROKEN_VALUE = re.compile(
    r"\b(nan|null|undefined|infinity|none)\b|\[object object\]", re.IGNORECASE
)
_ERROR_WORD = re.compile(r"\b(error|failed|failure|exception|denied|timeout|"
                         r"unavailable|refused)\b", re.IGNORECASE)
_HTTP_ERROR = re.compile(r"\b([45]\d{2})\b")


def _rule_broken_value(change: StateChange) -> Inference | None:
    after = str(change.after or "")
    before = str(change.before or "")
    if _BROKEN_VALUE.search(after) and not _BROKEN_VALUE.search(before):
        return Inference(
            text=f"{change.key} became a non-value, which usually means the "
            "calculation or fetch behind it failed",
            confidence=0.74,
            basis="rule:broken_value",
        )
    return None


def _rule_number_vanished(change: StateChange) -> Inference | None:
    before, after = str(change.before or ""), str(change.after or "")
    if _NUMBER.search(before) and not _NUMBER.search(after) and after.strip():
        return Inference(
            text=f"{change.key} previously held a number and no longer does",
            confidence=0.6,
            basis="rule:number_vanished",
        )
    return None


def _rule_error_appeared(text: str) -> Inference | None:
    if not _ERROR_WORD.search(text):
        return None
    status = _HTTP_ERROR.search(text)
    if status:
        code = status.group(1)
        family = "the server" if code.startswith("5") else "the request"
        return Inference(
            text=f"an HTTP {code} suggests {family} is at fault",
            confidence=0.7,
            basis="rule:http_status",
        )
    return Inference(
        text="an error is being shown to the user",
        confidence=0.65,
        basis="rule:error_word",
    )


def _rule_spoken_about_visible(speech: str, visible: str) -> Inference | None:
    """Someone describing what is on screen at the same moment.

    Deliberately weak: shared vocabulary is evidence of topic, not of cause,
    and the confidence says so.
    """
    speech_words = {w for w in re.findall(r"[^\W\d_]{4,}", speech.lower())}
    visible_words = {w for w in re.findall(r"[^\W\d_]{4,}", visible.lower())}
    shared = speech_words & visible_words
    if len(shared) < 2:
        return None
    return Inference(
        text="the speaker appears to be describing what is on screen "
        f"(shared terms: {', '.join(sorted(shared)[:4])})",
        confidence=0.55,
        basis="rule:speech_matches_screen",
    )


# --- the fuser ----------------------------------------------------------------


@dataclass
class TemporalFuser:
    """Correlates a session's raw events into fused, hedged accounts."""

    session_id: str
    window: float = DEFAULT_WINDOW
    tracks: dict[str, EntityTrack] = field(default_factory=dict)
    _sequence: int = 0

    def observe_entities(self, event: LiveEvent) -> None:
        """Update entity tracks from one raw event."""
        for entity in event.entities:
            track = self.tracks.get(entity.entity_id)
            if track is None:
                self.tracks[entity.entity_id] = EntityTrack(
                    entity_id=entity.entity_id, label=entity.label,
                    kind=entity.kind, first_media_ts=event.media_ts,
                    last_media_ts=event.media_ts,
                    observations=[EntityObservation(
                        entity_id=entity.entity_id, media_ts=event.media_ts,
                        source=event.detector,
                    )],
                )
                continue
            track.last_media_ts = event.media_ts
            track.present = True
            track.observations.append(EntityObservation(
                entity_id=entity.entity_id, media_ts=event.media_ts,
                source=event.detector,
            ))
            del track.observations[:-50]  # bounded: a live session runs for hours

        # Anything named as disappeared is marked absent rather than deleted,
        # so "did X vanish?" stays answerable after the fact.
        for change in event.state_changes:
            if change.key == "visible_text":
                self._mark_absent(str(change.before or ""), str(change.after or ""),
                                  event.media_ts)

    def _mark_absent(self, before: str, after: str, media_ts: float) -> None:
        gone = {w.lower() for w in re.findall(r"[^\W\d_]{2,}", before)} - {
            w.lower() for w in re.findall(r"[^\W\d_]{2,}", after)
        }
        for entity_id in gone:
            track = self.tracks.get(entity_id)
            if track is not None and track.present:
                track.present = False
                track.last_media_ts = media_ts

    def fuse(self, events: list[LiveEvent]) -> list[FusedEvent]:
        """Group raw events into fused accounts, nearest-in-time together."""
        for event in events:
            self.observe_entities(event)

        substantive = [
            event for event in events
            if event.type not in (LiveEventType.SESSION_STARTED,
                                  LiveEventType.SESSION_STOPPED)
        ]
        fused: list[FusedEvent] = []
        consumed: set[int] = set()
        for event in substantive:
            if event.seq in consumed:
                continue
            group = [
                other for other in correlate(event.media_ts, substantive,
                                             window=self.window)
                if other.seq not in consumed
            ]
            consumed.update(other.seq for other in group)
            fused.append(self._build(group or [event]))
        return fused

    def _build(self, group: list[LiveEvent]) -> FusedEvent:
        self._sequence += 1
        group = sorted(group, key=lambda e: e.media_ts)
        speech = [e for e in group if e.type is LiveEventType.SPEECH]
        visual = [e for e in group if e.type is not LiveEventType.SPEECH]

        observation = self._describe(group)
        inferences = self._infer(speech, visual)
        state_changes = [c for e in group for c in e.state_changes]
        evidence = [ref for e in group for ref in e.evidence]
        entities = sorted({e.entity_id for ev in group for e in ev.entities})

        return FusedEvent(
            session_id=self.session_id,
            sequence=self._sequence,
            type=self._classify(group),
            start_media_ts=group[0].media_ts,
            end_media_ts=max(
                (e.detail.get("end_media_ts") or e.media_ts) for e in group
            ),
            observation=observation,
            inferences=inferences,
            entities=entities,
            state_changes=state_changes,
            evidence=evidence,
            sources=sorted({e.detector for e in group if e.detector}),
            provisional=any(not e.final for e in group),
            confidence=min((e.confidence for e in group), default=1.0),
        )

    @staticmethod
    def _classify(group: list[LiveEvent]) -> str:
        types = {e.type for e in group}
        if LiveEventType.SPEECH in types and len(types) > 1:
            return "multimodal"
        if LiveEventType.VISIBLE_TEXT_CHANGE in types:
            return LiveEventType.UI_STATE_CHANGE.value
        return next(iter(types)).value

    @staticmethod
    def _describe(group: list[LiveEvent]) -> str:
        """State what happened, using only what a stream actually recorded."""
        parts = []
        for event in group:
            for change in event.state_changes:
                if change.key == "visible_text":
                    continue
                parts.append(
                    f"{change.key} changed from {change.before!r} to {change.after!r}"
                )
            if event.type is LiveEventType.SPEECH:
                parts.append(f'someone said "{event.summary}"')
            elif event.summary:
                parts.append(event.summary)
        # Preserve order, drop repeats — correlated events often restate each
        # other and a fused account that says the same thing twice reads as
        # two findings.
        seen, unique = set(), []
        for part in parts:
            if part not in seen:
                seen.add(part)
                unique.append(part)
        return "; ".join(unique) or "an unlabelled observation"

    def _infer(
        self, speech: list[LiveEvent], visual: list[LiveEvent]
    ) -> list[Inference]:
        inferences: list[Inference] = []
        for event in visual:
            for change in event.state_changes:
                for rule in (_rule_broken_value, _rule_number_vanished):
                    result = rule(change)
                    if result is not None:
                        inferences.append(result)
            text = " ".join(
                [event.summary, *(str(c.after or "") for c in event.state_changes)]
            )
            error = _rule_error_appeared(text)
            if error is not None:
                inferences.append(error)

        if speech and visual:
            visible_text = " ".join(
                str(c.after or "") for e in visual for c in e.state_changes
                if c.key == "visible_text"
            )
            for utterance in speech:
                match = _rule_spoken_about_visible(utterance.summary, visible_text)
                if match is not None:
                    inferences.append(match)

        # Deduplicate by text; the same rule firing on three correlated events
        # is one hypothesis, not three.
        seen, unique = set(), []
        for inference in inferences:
            if inference.text not in seen:
                seen.add(inference.text)
                unique.append(inference)
        return unique

    def active_entities(self, now_media_ts: float) -> list[dict[str, Any]]:
        """Entities believed present, with confidence decayed by staleness."""
        rows = []
        for track in self.tracks.values():
            if not track.present:
                continue
            confidence = track.decay(now_media_ts)
            if confidence < 0.1:
                continue
            rows.append({
                "entity_id": track.entity_id,
                "label": track.label,
                "kind": track.kind,
                "first_media_ts": round(track.first_media_ts, 3),
                "last_media_ts": round(track.last_media_ts, 3),
                "confidence": confidence,
                "sightings": len(track.observations),
            })
        return sorted(rows, key=lambda row: row["confidence"], reverse=True)

    def vanished_entities(self) -> list[dict[str, Any]]:
        return [
            {"entity_id": t.entity_id, "label": t.label,
             "last_media_ts": round(t.last_media_ts, 3)}
            for t in self.tracks.values() if not t.present
        ]


def fuse_session(session_id: str, window: float = DEFAULT_WINDOW,
                 limit: int = 500) -> dict[str, Any]:
    """Fuse a session's events into a correlated, hedged narrative."""
    from watch_skill.live import db
    from watch_skill.live.session import get_session

    get_session(session_id)  # structured error for an unknown session
    events = db.read_events(session_id, limit=limit)
    fuser = TemporalFuser(session_id=session_id, window=window)
    fused = fuser.fuse(events)
    now = max((e.media_ts for e in events), default=0.0)
    return {
        "schema_version": LIVE_SCHEMA_VERSION,
        "session_id": session_id,
        "window_seconds": window,
        "events": [event.to_public() for event in fused],
        "count": len(fused),
        "active_entities": fuser.active_entities(now),
        "vanished_entities": fuser.vanished_entities(),
        "raw_event_count": len(events),
    }
