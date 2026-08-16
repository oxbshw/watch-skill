"""Persistent temporal entities: what was true, and when we thought so.

A model never writes here. Its output arrives as an :class:`Observation` — a
proposal — and deterministic code decides what becomes a believed fact.
"""
from __future__ import annotations

from watch_skill.entities.db import (
    attribute_history,
    attributes_at,
    conflicts_for,
    current_attributes,
    find_by_alias,
    get_entity,
    list_entities,
)
from watch_skill.entities.store import (
    EntityError,
    compile_context,
    history,
    observe,
    record,
    resolve,
    state_at,
    state_now,
)
from watch_skill.entities.types import (
    ENTITY_SCHEMA_VERSION,
    Attribute,
    Confidence,
    Conflict,
    Entity,
    EntityKind,
    EvidenceLink,
    Observation,
    normalize_alias,
)

__all__ = [
    "ENTITY_SCHEMA_VERSION",
    "Attribute",
    "Confidence",
    "Conflict",
    "Entity",
    "EntityError",
    "EntityKind",
    "EvidenceLink",
    "Observation",
    "attribute_history",
    "attributes_at",
    "compile_context",
    "conflicts_for",
    "current_attributes",
    "find_by_alias",
    "get_entity",
    "history",
    "list_entities",
    "normalize_alias",
    "observe",
    "record",
    "resolve",
    "state_at",
    "state_now",
]
