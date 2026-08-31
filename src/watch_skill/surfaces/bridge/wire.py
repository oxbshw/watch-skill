"""The Bridge wire models — the semantic source of truth for the contract.

ADR-004 puts the Pydantic models in Watch Core at the centre of the wire and
makes the TypeScript types in ``@deepwatch/dsh-contracts`` a face over them.
This module is that centre. Each model below is one *contract family*: a group
of fields consumers break on together, so a change to any of them should
disable exactly the capabilities that read it and nothing else.

The models are serialization shapes, deliberately not the engine's internal
types. ``watch_skill.answer.Answer`` carries token-budget accounting and cache
bookkeeping that no Host screen has any business seeing; ``SourceAnswer`` here
carries what the contract promised. Keeping them separate is what lets Core
refactor its internals without moving a digest.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(word.capitalize() for word in rest)


class WireModel(BaseModel):
    """Base for every wire model: camelCase out, either case in.

    The Host is TypeScript and its contracts are camelCase; Core is Python and
    its fields are snake_case. Aliasing at the boundary keeps both sides
    idiomatic and means neither has to translate at every call site.
    """

    model_config = ConfigDict(
        alias_generator=_camel, populate_by_name=True, extra="forbid"
    )


# -- error -------------------------------------------------------------------


class WatchErrorModel(WireModel):
    """The structured error contract.

    Its own family because every other family's failure path serializes it: a
    change here breaks every consumer at once, which is precisely the property
    a family is meant to capture.
    """

    error: str
    message: str
    fix: str
    details: dict[str, Any] = Field(default_factory=dict)
    retryable: bool = False
    correlation_id: str | None = None


# -- handshake ---------------------------------------------------------------


class CapabilityTruth(WireModel):
    """One capability, and how much is actually known about it.

    ``status`` separates three facts the UI is never allowed to conflate: code
    exists (``implemented``), a probe passed (``probed``), and a real request
    ran here and succeeded (``machine_tested``). ``not_tested`` is not a
    synonym for ``unavailable`` — one is ignorance, the other is knowledge.
    """

    capability_id: str
    provider: str | None = None
    provider_version: str | None = None
    status: Literal[
        "implemented", "machine_tested", "probed", "unavailable", "not_tested"
    ]
    requirements: list[str] = Field(default_factory=list)
    detected: dict[str, str] = Field(default_factory=dict)
    missing: list[str] = Field(default_factory=list)
    fixes: list[str] = Field(default_factory=list)
    last_checked_at: str | None = None


class PolicySummary(WireModel):
    """The policy Core is enforcing, so no screen can misstate it."""

    offline_only: bool
    cloud_perception_opt_in: bool
    memory_mode: Literal["off", "session_only", "local_personal", "workspace_shared"]
    default_retention_class: str


class BridgeLimits(WireModel):
    """Transport limits the Host must respect."""

    max_request_bytes: int
    max_in_flight: int
    default_deadline_ms: int


class HandshakeResult(WireModel):
    """What Core answers when the Bridge connects.

    ``protocolVersion`` is the *negotiated* value, not Core's maximum: the
    Host sends what it speaks, Core answers with the highest version both
    support, and a Host that cannot live with the answer degrades only its
    Watch features.
    """

    core_version: str
    core_build: str | None = None
    protocol_version: int
    protocol_min: int
    capabilities: list[CapabilityTruth] = Field(default_factory=list)
    schema_digests: dict[str, str] = Field(default_factory=dict)
    policy: PolicySummary
    limits: BridgeLimits


# -- evidence ----------------------------------------------------------------


class TemporalRange(WireModel):
    """A half-open range on a source's own clock, in milliseconds."""

    start_ms: float
    end_ms: float


class SpatialRegion(WireModel):
    """A rectangle in a frame's coordinate space."""

    x: float
    y: float
    width: float
    height: float


class EvidenceRecord(WireModel):
    """One observation, as Core mints it.

    Core is the only party that may construct one of these (ADR-002); a Host
    plugin submits a candidate and never a fact. ``confidence`` is nullable on
    purpose — a producer with no calibrated confidence must not invent one,
    and a literal zero would read as "calibrated, and low".
    """

    evidence_id: str
    source_revision_id: str
    artifact_ids: list[str] = Field(default_factory=list)
    temporal_range: TemporalRange | None = None
    spatial_region: SpatialRegion | None = None
    modality: Literal["visual", "text", "audio", "dom", "network", "filesystem"]
    provenance: Literal["observation", "deterministic_derivation", "inference"]
    producer: str
    producer_version: str
    capture_quality: str | None = None
    gaps: list[TemporalRange] = Field(default_factory=list)
    freshness: Literal["current", "stale", "gap", "expired", "unavailable"]
    content_digest: str
    retention_class: str
    confidence: float | None = None


# -- verification ------------------------------------------------------------


class VerificationCheck(WireModel):
    """One check inside a contract. ``passed`` is null when it did not run."""

    check_id: str
    kind: str
    description: str
    passed: bool | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    detail: str | None = None


class VerificationOutcome(WireModel):
    """The result of running a verification contract.

    ``VERIFIED`` never follows from confidence, at any value: the taxonomy
    separates "an executable expectation passed" from "the agent finished",
    and only Core may say the first.
    """

    verification_id: str
    verdict: Literal[
        "VERIFIED", "FAILED", "UNVERIFIED", "INCONCLUSIVE", "STALE", "BLOCKED"
    ]
    reason: str
    checks: list[VerificationCheck] = Field(default_factory=list)
    contract_digest: str
    evaluated_at: str


# -- answer ------------------------------------------------------------------


class AnswerCitation(WireModel):
    """One cited moment. Timestamps here are the only legal citation source."""

    timestamp_ms: float | None = None
    kind: str
    text: str
    score: float


class SourceAnswer(WireModel):
    """An answer about one indexed source, with what it rests on.

    ``honestFloor`` is carried rather than dropped because it is the one
    signal that separates "the engine is confident" from "the engine reached
    its floor and is saying so".
    """

    source_id: str
    question: str
    answer: str
    confidence: float
    verified: bool
    honest_floor: bool
    citations: list[AnswerCitation] = Field(default_factory=list)
    evidence: list[EvidenceRecord] = Field(default_factory=list)


# -- library -----------------------------------------------------------------


class LibraryHit(WireModel):
    """One match inside a source."""

    timestamp_ms: float | None = None
    kind: str
    text: str
    score: float


class LibraryRecord(WireModel):
    """One indexed source as the Library lists it.

    ``sourceLabel`` is deliberately not a path. The Library is rendered in a
    browser and copied into model context, and an absolute host path in either
    is a privacy defect — so Core sends the display label and the logical id,
    and keeps the resolved root to itself.
    """

    source_id: str
    title: str | None = None
    source_label: str
    duration_ms: float | None = None
    indexed_at: str | None = None
    revision_id: str | None = None
    hits: list[LibraryHit] = Field(default_factory=list)


class LibraryPage(WireModel):
    """A page of Library records, and whether the engine truncated it.

    The rows are ``sources`` rather than ``records`` because that is the word
    the whole surface already uses -- the tool is `watch_list_sources`, the
    identifier is `sourceId` -- and a page whose rows are called something else
    makes a reader ask whether they are the same thing.
    """

    sources: list[LibraryRecord] = Field(default_factory=list)
    total: int
    truncated: bool = False


#: Every contract family, mapped to the model that defines it.
#:
#: The mapping is what the digest generator walks, so adding a family here and
#: regenerating is the whole process for extending the contract.
FAMILIES: dict[str, type[BaseModel]] = {
    "answer": SourceAnswer,
    "error": WatchErrorModel,
    "evidence": EvidenceRecord,
    "handshake": HandshakeResult,
    "library": LibraryPage,
    "verification": VerificationOutcome,
}

__all__ = [
    "FAMILIES",
    "AnswerCitation",
    "BridgeLimits",
    "CapabilityTruth",
    "EvidenceRecord",
    "HandshakeResult",
    "LibraryHit",
    "LibraryPage",
    "LibraryRecord",
    "PolicySummary",
    "SourceAnswer",
    "SpatialRegion",
    "TemporalRange",
    "VerificationCheck",
    "VerificationOutcome",
    "WatchErrorModel",
    "WireModel",
]
