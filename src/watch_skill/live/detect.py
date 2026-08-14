"""Local detectors: what turns frames into events, without a model per frame.

Everything here runs on this machine and costs no tokens. That is deliberate
and structural, not a default someone can drift away from: a live session that
called an LLM once per frame would be unaffordable within a minute and would
still be slower than the video.

Semantic interpretation happens later, on *selected* frames, driven by a
question — never on the stream itself.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from watch_skill.live.types import (
    EvidenceReference,
    LiveEvent,
    LiveEventType,
    Provenance,
    StateChange,
    TemporalEntity,
)


def _phash(path: Path) -> str | None:
    try:
        import imagehash  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return None
    try:
        with Image.open(path) as image:
            return str(imagehash.phash(image))
    except Exception:  # noqa: BLE001 - a truncated frame is not fatal
        return None


def _hamming(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


_WORD = re.compile(r"[^\W\d_]{2,}|\d[\d.,:%$€£-]*", re.UNICODE)


def _tokens(text: str) -> set[str]:
    return {match.group(0).lower() for match in _WORD.finditer(text)}


@dataclass
class DetectorState:
    """What the detectors remember between frames.

    Small on purpose: this is per-session working memory in a live loop, and
    anything that grows per frame here grows without bound over an hour.
    """

    last_phash: str | None = None
    last_text: str = ""
    last_tokens: set[str] = field(default_factory=set)
    scene_index: int = 0
    entities: dict[str, TemporalEntity] = field(default_factory=dict)


@dataclass
class Detection:
    """An event a detector wants emitted, before sequencing."""

    type: LiveEventType
    summary: str
    confidence: float = 1.0
    detector: str = ""
    provenance: Provenance = Provenance.OBSERVATION
    state_changes: list[StateChange] = field(default_factory=list)
    entities: list[TemporalEntity] = field(default_factory=list)
    detail: dict = field(default_factory=dict)


SCENE_DISTANCE = 12
"""Perceptual-hash distance that counts as a new scene. Higher than the
indexing dedup threshold (6) on purpose: live watching wants *changes worth
reporting*, not every near-duplicate, and an event per flicker is noise."""


def detect_scene_change(
    state: DetectorState, frame_path: Path, media_ts: float
) -> Detection | None:
    digest = _phash(frame_path)
    if digest is None:
        return None
    previous, state.last_phash = state.last_phash, digest
    if previous is None:
        state.scene_index = 1
        return Detection(
            type=LiveEventType.SCENE_CHANGE,
            summary="first scene",
            detector="phash",
            detail={"scene": 1},
        )
    distance = _hamming(previous, digest)
    if distance < SCENE_DISTANCE:
        return None
    state.scene_index += 1
    return Detection(
        type=LiveEventType.SCENE_CHANGE,
        summary=f"scene changed (phash distance {distance})",
        confidence=min(1.0, distance / 32),
        detector="phash",
        state_changes=[StateChange(key="scene", before=state.scene_index - 1,
                                   after=state.scene_index, media_ts=media_ts)],
        detail={"distance": distance, "scene": state.scene_index},
    )


def detect_text_change(
    state: DetectorState, text: str, media_ts: float
) -> Detection | None:
    """On-screen text that appeared or vanished.

    Compared as token sets rather than strings because OCR jitters: one
    character re-read differently would otherwise fire an event on every
    single frame of a completely static screen.
    """
    tokens = _tokens(text)
    if not tokens and not state.last_tokens:
        return None
    appeared = tokens - state.last_tokens
    disappeared = state.last_tokens - tokens
    previous_text, state.last_text = state.last_text, text
    state.last_tokens = tokens
    if not appeared and not disappeared:
        return None
    if not previous_text and not appeared:
        return None

    entities = []
    for token in sorted(appeared)[:12]:
        entity = state.entities.get(token) or TemporalEntity(
            entity_id=token, label=token, kind="text", confidence=0.9,
            first_media_ts=media_ts,
        )
        entity.last_media_ts = media_ts
        state.entities[token] = entity
        entities.append(entity)

    parts = []
    if appeared:
        parts.append("appeared: " + ", ".join(sorted(appeared)[:8]))
    if disappeared:
        parts.append("gone: " + ", ".join(sorted(disappeared)[:8]))
    return Detection(
        type=LiveEventType.VISIBLE_TEXT_CHANGE,
        summary="on-screen text " + "; ".join(parts),
        confidence=0.9,
        detector="ocr",
        state_changes=[StateChange(key="visible_text", before=previous_text[:200],
                                   after=text[:200], media_ts=media_ts)],
        entities=entities,
        detail={"appeared": sorted(appeared)[:20],
                "disappeared": sorted(disappeared)[:20]},
    )


def build_event(
    session_id: str, detection: Detection, media_ts: float, wall_ts: float,
    evidence: list[EvidenceReference] | None = None,
) -> LiveEvent:
    return LiveEvent(
        session_id=session_id,
        seq=0,  # assigned atomically on append
        media_ts=media_ts,
        wall_ts=wall_ts,
        type=detection.type,
        confidence=detection.confidence,
        provenance=detection.provenance,
        summary=detection.summary,
        detector=detection.detector,
        evidence=evidence or [],
        entities=detection.entities,
        state_changes=detection.state_changes,
        detail=detection.detail,
    )
