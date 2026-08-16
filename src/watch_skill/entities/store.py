"""Turning candidate observations into believed facts, deterministically.

This module is the boundary. A model — or OCR, or a webpage, or an SDK caller
— produces an :class:`Observation`, which is a *proposal*. Nothing in this
file trusts it. It is validated, normalized, bounded, deduplicated, and
compared against what is already believed, and only then does any of it become
an attribute.

The conflict rule is the interesting part, and it is stated once here so it
cannot drift:

* A **deterministic** observation (a DOM read, a human assertion) supersedes
  anything, including another deterministic one.
* An **inferred** observation never supersedes a deterministic one. A model
  disagreeing with a measurement is a fact about the model.
* Otherwise the higher score wins, and ties keep the incumbent — because
  churning an attribute between two equally-supported values produces a
  history that is noise.

Every one of those paths records a conflict row. "We kept the old value" is a
finding, and a store that only wrote the winner would throw it away.
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from watch_skill.entities import db
from watch_skill.entities.types import (
    DETERMINISTIC_CONFIDENCE,
    MAX_ATTRIBUTE_LENGTH,
    MAX_ATTRIBUTES_PER_ENTITY,
    Attribute,
    Confidence,
    Conflict,
    Entity,
    EntityKind,
    Observation,
)
from watch_skill.errors import WatchSkillError
from watch_skill.sqlite_util import immediate


class EntityError(WatchSkillError):
    """An observation could not be recorded."""

    default_code = "entities.invalid_observation"


def _bounded_value(value: Any) -> Any:
    """Cap anything a caller could make arbitrarily large.

    An attribute value comes from OCR text, a DOM node, or a model, all of
    which can be enormous by accident and by design. Truncation is marked so
    a reader is never misled into thinking they have the whole string.
    """
    if isinstance(value, str) and len(value) > MAX_ATTRIBUTE_LENGTH:
        return value[:MAX_ATTRIBUTE_LENGTH] + "…[truncated]"
    if isinstance(value, (list, tuple)):
        return [_bounded_value(item) for item in list(value)[:64]]
    if isinstance(value, dict):
        return {str(k)[:120]: _bounded_value(v)
                for k, v in list(value.items())[:64]}
    return value


def _supersedes(candidate: Observation, incumbent: Attribute) -> tuple[bool, str]:
    """Whether a candidate replaces what is currently believed, and why."""
    candidate_deterministic = candidate.confidence in DETERMINISTIC_CONFIDENCE
    incumbent_deterministic = incumbent.confidence in DETERMINISTIC_CONFIDENCE

    if candidate_deterministic:
        # A fresh measurement always wins, including over an older
        # measurement — that case is not a conflict at all, it is the
        # ordinary "the value changed" path, and requiring a higher score for
        # it would freeze the first reading forever.
        return True, ("deterministic_over_inferred" if not incumbent_deterministic
                      else "newer_measurement")
    if incumbent_deterministic:
        # The case worth being strict about: a model contradicting a
        # measurement does not get to win, however confident it sounds.
        return False, "inferred_cannot_override_deterministic"
    if candidate.score > incumbent.score:
        return True, "higher_score"
    return False, "kept_incumbent"


def record(observation: Observation) -> dict[str, Any]:
    """Record one candidate observation. Returns what deterministically happened.

    The whole thing is one transaction: an entity that gets created but whose
    attributes fail to land is worse than nothing, because later reads would
    show a real entity that knows nothing about itself.
    """
    if not str(observation.label).strip():
        raise EntityError(
            "an observation needs a non-empty label",
            code="entities.label_required",
            fix="give the thing being observed a name; it becomes the primary "
                "alias and is how the observation is matched to an entity",
        )

    now = observation.observed_at or time.time()
    conn = db.connect()
    outcome: dict[str, Any] = {
        "schema_version": 1, "created": False, "attributes_written": [],
        "attributes_unchanged": [], "conflicts": [], "rejected": [],
    }
    try:
        # Write-first: this transaction resolves an alias (a read) before
        # inserting, and a deferred transaction cannot upgrade that read lock
        # once another observer has committed.
        with immediate(conn):
            entity_id, created = db.upsert_entity(
                conn, label=observation.label, kind=observation.kind,
                aliases=list(observation.aliases), session_id=observation.session_id,
                observed_at=now, media_ts=observation.media_ts)
            outcome["entity_id"] = entity_id
            outcome["created"] = created

            for raw_name, raw_value in observation.attributes.items():
                name = str(raw_name).strip()[:120]
                if not name:
                    continue
                value = _bounded_value(raw_value)
                incumbent = db.open_attribute(conn, entity_id, name)

                if incumbent is None:
                    if db.count_attributes(conn, entity_id) >= MAX_ATTRIBUTES_PER_ENTITY:
                        outcome["rejected"].append(
                            {"name": name, "reason": "attribute_limit"})
                        continue
                    attribute_id = db.insert_attribute(conn, Attribute(
                        entity_id=entity_id, name=name, value=value,
                        confidence=observation.confidence, score=observation.score,
                        valid_from=now, observed_at=now,
                        media_ts=observation.media_ts, source=observation.source,
                        evidence=list(observation.evidence)))
                    outcome["attributes_written"].append(
                        {"name": name, "attribute_id": attribute_id,
                         "reason": "new"})
                    continue

                if incumbent.value == value:
                    # The same fact seen again is not a change. Writing a new
                    # interval here would fill the history with duplicates and
                    # make "when did this actually change" unanswerable.
                    outcome["attributes_unchanged"].append(name)
                    continue

                wins, reason = _supersedes(observation, incumbent)
                conflict = Conflict(
                    entity_id=entity_id, name=name,
                    incumbent_id=incumbent.attribute_id,
                    incumbent_value=incumbent.value,
                    incumbent_confidence=incumbent.confidence.value,
                    candidate_value=value,
                    candidate_confidence=observation.confidence.value,
                    candidate_source=observation.source,
                    detected_at=now,
                    resolution="superseded" if wins else reason,
                )
                db.record_conflict(conn, conflict)
                outcome["conflicts"].append(conflict.to_public())

                if not wins:
                    continue
                # Close before inserting. The partial unique index permits
                # exactly one open interval per (entity, name), so the other
                # order fails outright — which is the index doing its job:
                # two simultaneously-current values is the corruption every
                # later read would silently inherit. The id is minted first so
                # the closed row can point at what replaced it.
                new_id = f"attr_{uuid.uuid4().hex[:12]}"
                db.close_attribute(conn, incumbent.attribute_id, at=now,
                                   superseded_by=new_id)
                db.insert_attribute(conn, Attribute(
                    attribute_id=new_id,
                    entity_id=entity_id, name=name, value=value,
                    confidence=observation.confidence, score=observation.score,
                    # The new interval opens exactly where the old one closes,
                    # so a state-at-time query never finds a gap and never
                    # finds two answers.
                    valid_from=now, observed_at=now,
                    media_ts=observation.media_ts, source=observation.source,
                    evidence=list(observation.evidence)))
                outcome["attributes_written"].append(
                    {"name": name, "attribute_id": new_id, "reason": reason})
    finally:
        conn.close()
    return outcome


# --- retrieval ---------------------------------------------------------------


def state_now(entity_id: str) -> dict[str, Any]:
    """Current belief about an entity, with the evidence behind each fact."""
    entity = db.get_entity(entity_id)
    if entity is None:
        raise EntityError(
            f"no entity {entity_id!r} exists",
            code="entities.not_found",
            fix="list entities, or record an observation first",
            details={"entity_id": entity_id},
        )
    attributes = db.current_attributes(entity_id)
    return {
        "schema_version": 1,
        "entity": entity.to_public(),
        "as_of": "now",
        "attributes": [a.to_public() for a in attributes],
        "conflicts": [c.to_public() for c in db.conflicts_for(entity_id, limit=20)],
    }


def state_at(entity_id: str, when: float) -> dict[str, Any]:
    """What was believed at a wall-clock instant.

    An entity that did not exist yet returns an empty attribute list rather
    than raising — "nothing was known then" is a real and useful answer.
    """
    entity = db.get_entity(entity_id)
    if entity is None:
        raise EntityError(
            f"no entity {entity_id!r} exists",
            code="entities.not_found",
            fix="list entities, or record an observation first",
            details={"entity_id": entity_id},
        )
    attributes = db.attributes_at(entity_id, when)
    return {
        "schema_version": 1,
        "entity": entity.to_public(),
        "as_of": when,
        "existed": when >= entity.first_seen,
        "attributes": [a.to_public() for a in attributes],
    }


def history(entity_id: str, name: str | None = None,
            limit: int = 200) -> dict[str, Any]:
    """Every value an attribute has held, oldest first."""
    changes = db.attribute_history(entity_id, name, limit=limit)
    return {
        "schema_version": 1,
        "entity_id": entity_id,
        "attribute": name,
        "changes": [a.to_public() for a in changes],
        "count": len(changes),
    }


def compile_context(entity_id: str, *, max_attributes: int = 20,
                    max_chars: int = 2000) -> dict[str, Any]:
    """A bounded summary suitable for putting in a prompt.

    Bounded twice — by count and by characters — because an entity with a
    hundred attributes would otherwise silently consume a context window, and
    the truncation is reported rather than hidden so a caller can tell it
    received a partial view.
    """
    entity = db.get_entity(entity_id)
    if entity is None:
        raise EntityError(
            f"no entity {entity_id!r} exists",
            code="entities.not_found",
            fix="list entities, or record an observation first",
            details={"entity_id": entity_id},
        )
    attributes = db.current_attributes(entity_id)
    # Deterministic facts first: if something has to be dropped, drop the
    # model's opinions before the measurements.
    attributes.sort(key=lambda a: (a.confidence not in DETERMINISTIC_CONFIDENCE,
                                   -a.score, a.name))
    lines: list[str] = []
    used = 0
    included = 0
    for attribute in attributes:
        if included >= max_attributes:
            break
        line = (f"{attribute.name}={attribute.value!r} "
                f"({attribute.confidence.value})")
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line)
        included += 1
    return {
        "schema_version": 1,
        "entity_id": entity_id,
        "label": entity.label,
        "kind": entity.kind.value,
        "lines": lines,
        "included": included,
        "total_attributes": len(attributes),
        "truncated": included < len(attributes),
        "chars": used,
    }


def observe(
    *,
    label: str,
    attributes: dict[str, Any] | None = None,
    kind: str | EntityKind = EntityKind.UNKNOWN,
    aliases: list[str] | None = None,
    confidence: str | Confidence = Confidence.MEASURED,
    score: float = 1.0,
    session_id: str = "",
    media_ts: float | None = None,
    source: str = "",
    evidence: list[Any] | None = None,
) -> dict[str, Any]:
    """Convenience wrapper over :func:`record` for ordinary callers."""
    return record(Observation(
        label=label,
        kind=EntityKind(kind) if isinstance(kind, str) else kind,
        aliases=aliases or [],
        attributes=attributes or {},
        confidence=(Confidence(confidence) if isinstance(confidence, str)
                    else confidence),
        score=score, session_id=session_id, media_ts=media_ts, source=source,
        evidence=evidence or [],
    ))


def resolve(alias: str) -> Entity | None:
    return db.find_by_alias(alias)


__all__ = [
    "EntityError",
    "compile_context",
    "history",
    "observe",
    "record",
    "resolve",
    "state_at",
    "state_now",
]
