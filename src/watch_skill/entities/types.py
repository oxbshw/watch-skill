"""Things that persist across time, and what was believed about them when.

The distinction this module exists to keep is between *what is true now* and
*what we thought at 14:32*. An entity store that only holds current state
cannot answer "what did the dashboard say when the alert fired", which is the
question a recording is usually kept for.

So every attribute is bi-temporal in the sense that matters here: it carries
the interval over which it was believed (``valid_from`` / ``valid_to``) and
the evidence that produced it. Superseding a fact closes the old interval
rather than overwriting it, so history is never destroyed by an update.

A model never writes here. Model output arrives as a *candidate observation*,
and deterministic code validates, normalizes, deduplicates, and decides
whether it becomes an attribute — because an entity store a model can edit
directly is a store whose contents are whatever the model last hallucinated.
"""
from __future__ import annotations

import re
import time
import unicodedata
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

ENTITY_SCHEMA_VERSION = 1

MAX_ALIASES = 32
MAX_ATTRIBUTE_LENGTH = 2000
MAX_ATTRIBUTES_PER_ENTITY = 128


class EntityKind(str, Enum):  # noqa: UP042 — matches SourceKind
    """What sort of thing an entity is.

    Deliberately coarse. A finer taxonomy would be a guess about domains
    Watch Skill does not know, and callers can say more precisely in
    attributes.
    """

    UNKNOWN = "unknown"
    PERSON = "person"
    OBJECT = "object"
    UI_ELEMENT = "ui_element"
    TEXT = "text"
    DOCUMENT = "document"
    LOCATION = "location"
    APPLICATION = "application"


class Confidence(str, Enum):  # noqa: UP042 — matches SourceKind
    """How an observation was established, not how sure someone feels.

    A named provenance rather than a bare float, because "0.9" from OCR and
    "0.9" from a language model mean entirely different things and averaging
    them produces a number that means nothing at all.
    """

    MEASURED = "measured"
    """Deterministic: a DOM read, a file hash, an exact string match."""

    RECOGNIZED = "recognized"
    """A recognition model with a calibrated score — OCR, ASR."""

    INFERRED = "inferred"
    """A language or vision model's reading. Always advisory."""

    ASSERTED = "asserted"
    """A human or caller said so."""


DETERMINISTIC_CONFIDENCE = frozenset({Confidence.MEASURED, Confidence.ASSERTED})


def normalize_alias(text: str) -> str:
    """Fold an alias to its comparison form.

    NFKC first so visually identical strings that differ in encoding compare
    equal, then case-fold and collapse whitespace. This is the function that
    decides whether two observations are about the same thing, so it is
    deliberately conservative: it never strips punctuation or stems words,
    because "order-4417" and "order 4417" being merged is a judgement Watch
    Skill has no basis to make.
    """
    folded = unicodedata.normalize("NFKC", str(text)).casefold().strip()
    return re.sub(r"\s+", " ", folded)


class EvidenceLink(BaseModel):
    """Where an observation came from, in a form that can be looked at again."""

    schema_version: int = ENTITY_SCHEMA_VERSION
    session_id: str = ""
    kind: str = "frame"          # frame | clip | audio | transcript | browser | file
    artifact_id: str = ""
    media_ts: float | None = None
    event_seq: int | None = None
    digest: str | None = None

    def key(self) -> str:
        return f"{self.session_id}:{self.kind}:{self.artifact_id}:{self.event_seq}"


class Attribute(BaseModel):
    """One thing believed about an entity, over one interval of time.

    ``valid_to`` of None means "still believed". Closing an interval is how a
    fact is superseded; nothing is ever updated in place, because the previous
    value is exactly what a state-at-time query needs.
    """

    schema_version: int = ENTITY_SCHEMA_VERSION
    attribute_id: str = ""
    entity_id: str = ""
    name: str
    value: Any = None
    confidence: Confidence = Confidence.MEASURED
    score: float = Field(default=1.0, ge=0.0, le=1.0)
    valid_from: float = Field(default_factory=time.time)
    valid_to: float | None = None
    observed_at: float = Field(default_factory=time.time)
    media_ts: float | None = None
    source: str = ""
    """Which detector or caller produced this — `browser:dom`, `ocr`,
    `semantic:llava`, `operator`. Kept so a disputed fact can be traced to the
    thing that asserted it."""

    evidence: list[EvidenceLink] = Field(default_factory=list)
    superseded_by: str | None = None

    @property
    def open(self) -> bool:
        return self.valid_to is None

    def held_at(self, when: float) -> bool:
        """Whether this attribute was believed at a given wall-clock time."""
        if when < self.valid_from:
            return False
        return self.valid_to is None or when < self.valid_to

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "attribute_id": self.attribute_id,
            "name": self.name,
            "value": self.value,
            "confidence": self.confidence.value,
            "score": round(self.score, 3),
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "observed_at": self.observed_at,
            "media_ts": self.media_ts,
            "source": self.source,
            "evidence": [link.model_dump() for link in self.evidence],
            "superseded_by": self.superseded_by,
            "open": self.open,
        }


class Entity(BaseModel):
    """Something observed across time, with a stable identity."""

    schema_version: int = ENTITY_SCHEMA_VERSION
    entity_id: str
    kind: EntityKind = EntityKind.UNKNOWN
    label: str = ""
    aliases: list[str] = Field(default_factory=list)
    first_seen: float = Field(default_factory=time.time)
    last_seen: float = Field(default_factory=time.time)
    first_media_ts: float | None = None
    last_media_ts: float | None = None
    sessions: list[str] = Field(default_factory=list)
    """Every session this entity has been observed in. What makes
    cross-session history possible rather than a per-recording view."""

    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "entity_id": self.entity_id,
            "kind": self.kind.value,
            "label": self.label,
            "aliases": self.aliases,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "first_media_ts": self.first_media_ts,
            "last_media_ts": self.last_media_ts,
            "sessions": self.sessions,
        }


class Observation(BaseModel):
    """A *candidate* fact, offered to the store. Not yet believed.

    This is the only shape a model's output may take. It goes through
    validation, normalization and conflict resolution before any of it becomes
    an attribute, and the code that does that is deterministic.
    """

    schema_version: int = ENTITY_SCHEMA_VERSION
    label: str
    kind: EntityKind = EntityKind.UNKNOWN
    aliases: list[str] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)
    confidence: Confidence = Confidence.INFERRED
    score: float = Field(default=0.5, ge=0.0, le=1.0)
    session_id: str = ""
    media_ts: float | None = None
    observed_at: float = Field(default_factory=time.time)
    source: str = ""
    evidence: list[EvidenceLink] = Field(default_factory=list)


class Conflict(BaseModel):
    """Two incompatible beliefs about one attribute, both kept.

    Recorded rather than resolved by overwriting. Which of two contradictory
    readings is right is often not decidable from inside the system, and
    silently picking one destroys the evidence a human would need.
    """

    schema_version: int = ENTITY_SCHEMA_VERSION
    entity_id: str
    name: str
    incumbent_id: str
    incumbent_value: Any = None
    incumbent_confidence: str = ""
    candidate_value: Any = None
    candidate_confidence: str = ""
    candidate_source: str = ""
    detected_at: float = Field(default_factory=time.time)
    resolution: str = ""
    """What deterministic code did about it: `kept_incumbent`,
    `superseded`, or `recorded_only`."""

    def to_public(self) -> dict[str, Any]:
        return self.model_dump()


__all__ = [
    "DETERMINISTIC_CONFIDENCE",
    "ENTITY_SCHEMA_VERSION",
    "MAX_ALIASES",
    "MAX_ATTRIBUTES_PER_ENTITY",
    "MAX_ATTRIBUTE_LENGTH",
    "Attribute",
    "Confidence",
    "Conflict",
    "Entity",
    "EntityKind",
    "EvidenceLink",
    "Observation",
    "normalize_alias",
]
