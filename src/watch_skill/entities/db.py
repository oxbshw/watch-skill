"""Durable, bi-temporal entity storage.

Three tables and one rule: nothing is ever updated in place. An attribute that
stops being true has its interval closed; a contradicted attribute produces a
conflict row. Both are what a "what did it say at 14:32" query reads, and an
UPDATE would have destroyed exactly that.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.entities.types import (
    MAX_ALIASES,
    Attribute,
    Confidence,
    Conflict,
    Entity,
    EntityKind,
    EvidenceLink,
    normalize_alias,
)
from watch_skill.sqlite_util import apply_migrations

MIGRATIONS: list[str] = [
    # v1 — entities, their aliases, their bi-temporal attributes, conflicts.
    """
    CREATE TABLE entities (
        entity_id       TEXT PRIMARY KEY,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        kind            TEXT NOT NULL DEFAULT 'unknown',
        label           TEXT NOT NULL DEFAULT '',
        first_seen      REAL NOT NULL,
        last_seen       REAL NOT NULL,
        first_media_ts  REAL,
        last_media_ts   REAL,
        sessions_json   TEXT NOT NULL DEFAULT '[]',
        created_at      REAL NOT NULL,
        updated_at      REAL NOT NULL
    );
    CREATE INDEX idx_entities_kind ON entities(kind, last_seen);
    CREATE INDEX idx_entities_label ON entities(label);

    -- Aliases are their own table with a unique index on the *normalized*
    -- form. That index is the identity rule: two observations whose aliases
    -- fold to the same string are the same entity, decided by the database
    -- rather than by whichever caller looked first.
    CREATE TABLE entity_aliases (
        normalized  TEXT PRIMARY KEY,
        entity_id   TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        alias       TEXT NOT NULL,
        added_at    REAL NOT NULL
    );
    CREATE INDEX idx_aliases_entity ON entity_aliases(entity_id);

    CREATE TABLE entity_attributes (
        attribute_id    TEXT PRIMARY KEY,
        entity_id       TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        value_json      TEXT NOT NULL DEFAULT 'null',
        confidence      TEXT NOT NULL DEFAULT 'measured',
        score           REAL NOT NULL DEFAULT 1.0,
        valid_from      REAL NOT NULL,
        valid_to        REAL,
        observed_at     REAL NOT NULL,
        media_ts        REAL,
        source          TEXT NOT NULL DEFAULT '',
        evidence_json   TEXT NOT NULL DEFAULT '[]',
        superseded_by   TEXT
    );
    -- The index a state-at-time query rides on.
    CREATE INDEX idx_attr_history
        ON entity_attributes(entity_id, name, valid_from);
    -- Only one open interval per (entity, name). Enforced by the database,
    -- because two simultaneously-current values for one attribute is the
    -- corruption every other query would then silently read.
    CREATE UNIQUE INDEX idx_attr_open
        ON entity_attributes(entity_id, name) WHERE valid_to IS NULL;

    CREATE TABLE entity_conflicts (
        conflict_id     TEXT PRIMARY KEY,
        entity_id       TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        incumbent_id    TEXT NOT NULL DEFAULT '',
        incumbent_value TEXT NOT NULL DEFAULT 'null',
        incumbent_confidence TEXT NOT NULL DEFAULT '',
        candidate_value TEXT NOT NULL DEFAULT 'null',
        candidate_confidence TEXT NOT NULL DEFAULT '',
        candidate_source TEXT NOT NULL DEFAULT '',
        detected_at     REAL NOT NULL,
        resolution      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_conflicts_entity ON entity_conflicts(entity_id, detected_at);
    """,
]


def entities_path() -> Path:
    return get_settings().data_dir / "entities.db"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path if db_path is not None else entities_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, isolation_level="IMMEDIATE")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row["v"]) if row and row["v"] is not None else 0


def migrate(conn: sqlite3.Connection) -> int:
    """Bring this database up to date, safely under concurrency.

    Delegated so the write lock is taken before the version is read; doing it
    inline meant two processes both saw version 0 and the loser died with
    "table already exists".
    """
    return apply_migrations(conn, MIGRATIONS)


# --- reading ----------------------------------------------------------------


def _row_to_entity(row: sqlite3.Row, aliases: list[str]) -> Entity:
    return Entity(
        entity_id=row["entity_id"],
        schema_version=row["schema_version"],
        kind=EntityKind(row["kind"]),
        label=row["label"],
        aliases=aliases,
        first_seen=row["first_seen"],
        last_seen=row["last_seen"],
        first_media_ts=row["first_media_ts"],
        last_media_ts=row["last_media_ts"],
        sessions=json.loads(row["sessions_json"] or "[]"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _aliases_for(conn: sqlite3.Connection, entity_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY added_at",
        (entity_id,)).fetchall()
    return [row["alias"] for row in rows]


def get_entity(entity_id: str) -> Entity | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM entities WHERE entity_id = ?",
                           (entity_id,)).fetchone()
        return _row_to_entity(row, _aliases_for(conn, entity_id)) if row else None
    finally:
        conn.close()


def find_by_alias(alias: str) -> Entity | None:
    """Resolve any alias to its entity, using the normalized form."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT entity_id FROM entity_aliases WHERE normalized = ?",
            (normalize_alias(alias),)).fetchone()
        if row is None:
            return None
        entity_row = conn.execute("SELECT * FROM entities WHERE entity_id = ?",
                                  (row["entity_id"],)).fetchone()
        return (_row_to_entity(entity_row, _aliases_for(conn, row["entity_id"]))
                if entity_row else None)
    finally:
        conn.close()


def _row_to_attribute(row: sqlite3.Row) -> Attribute:
    return Attribute(
        attribute_id=row["attribute_id"],
        entity_id=row["entity_id"],
        name=row["name"],
        value=json.loads(row["value_json"]),
        confidence=Confidence(row["confidence"]),
        score=row["score"],
        valid_from=row["valid_from"],
        valid_to=row["valid_to"],
        observed_at=row["observed_at"],
        media_ts=row["media_ts"],
        source=row["source"],
        evidence=[EvidenceLink(**link)
                  for link in json.loads(row["evidence_json"] or "[]")],
        superseded_by=row["superseded_by"],
    )


def current_attributes(entity_id: str) -> list[Attribute]:
    """Everything believed right now — the open intervals."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM entity_attributes WHERE entity_id = ? "
            "AND valid_to IS NULL ORDER BY name", (entity_id,)).fetchall()
        return [_row_to_attribute(row) for row in rows]
    finally:
        conn.close()


def attributes_at(entity_id: str, when: float) -> list[Attribute]:
    """What was believed at a wall-clock instant.

    The query the whole bi-temporal design exists for. An interval counts if
    it had started and had not yet been closed, which is why a superseded
    value is still readable at a time before it was superseded.
    """
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM entity_attributes WHERE entity_id = ? "
            "AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) "
            "ORDER BY name", (entity_id, when, when)).fetchall()
        return [_row_to_attribute(row) for row in rows]
    finally:
        conn.close()


def attribute_history(entity_id: str, name: str | None = None,
                      limit: int = 200) -> list[Attribute]:
    conn = connect()
    try:
        if name:
            rows = conn.execute(
                "SELECT * FROM entity_attributes WHERE entity_id = ? AND name = ? "
                "ORDER BY valid_from, rowid LIMIT ?",
                (entity_id, name, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM entity_attributes WHERE entity_id = ? "
                "ORDER BY valid_from, rowid LIMIT ?", (entity_id, limit)).fetchall()
        return [_row_to_attribute(row) for row in rows]
    finally:
        conn.close()


def conflicts_for(entity_id: str, limit: int = 100) -> list[Conflict]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM entity_conflicts WHERE entity_id = ? "
            "ORDER BY detected_at DESC LIMIT ?", (entity_id, limit)).fetchall()
        return [Conflict(
            entity_id=row["entity_id"], name=row["name"],
            incumbent_id=row["incumbent_id"],
            incumbent_value=json.loads(row["incumbent_value"]),
            incumbent_confidence=row["incumbent_confidence"],
            candidate_value=json.loads(row["candidate_value"]),
            candidate_confidence=row["candidate_confidence"],
            candidate_source=row["candidate_source"],
            detected_at=row["detected_at"], resolution=row["resolution"],
        ) for row in rows]
    finally:
        conn.close()


def list_entities(kind: str | None = None, session_id: str | None = None,
                  limit: int = 100) -> list[Entity]:
    conn = connect()
    try:
        clauses, params = [], []
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(max(1, min(limit, 1000)))
        rows = conn.execute(
            f"SELECT * FROM entities {where} ORDER BY last_seen DESC LIMIT ?",
            params).fetchall()
        entities = [_row_to_entity(row, _aliases_for(conn, row["entity_id"]))
                    for row in rows]
        if session_id:
            entities = [e for e in entities if session_id in e.sessions]
        return entities
    finally:
        conn.close()


# --- writing ----------------------------------------------------------------


def upsert_entity(conn: sqlite3.Connection, *, label: str, kind: EntityKind,
                  aliases: list[str], session_id: str, observed_at: float,
                  media_ts: float | None) -> tuple[str, bool]:
    """Find or create the entity these aliases refer to.

    Resolution goes through the normalized alias index, so identity is decided
    by the database's uniqueness rather than by a read-then-write in Python —
    two processes observing the same thing at the same instant must converge
    on one entity, not create two.

    Returns ``(entity_id, created)``.
    """
    candidates = [label, *aliases]
    normalized = [normalize_alias(a) for a in candidates if str(a).strip()]
    if not normalized:
        raise ValueError("an entity needs at least one non-empty alias")

    existing: str | None = None
    for norm in normalized:
        row = conn.execute(
            "SELECT entity_id FROM entity_aliases WHERE normalized = ?",
            (norm,)).fetchone()
        if row is not None:
            existing = row["entity_id"]
            break

    created = existing is None
    entity_id = existing or f"ent_{uuid.uuid4().hex[:12]}"
    if created:
        conn.execute(
            "INSERT INTO entities (entity_id, kind, label, first_seen, last_seen, "
            "first_media_ts, last_media_ts, sessions_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (entity_id, kind.value, label, observed_at, observed_at,
             media_ts, media_ts, json.dumps([session_id] if session_id else []),
             observed_at, observed_at))
    else:
        row = conn.execute("SELECT * FROM entities WHERE entity_id = ?",
                           (entity_id,)).fetchone()
        sessions = json.loads(row["sessions_json"] or "[]")
        if session_id and session_id not in sessions:
            sessions.append(session_id)
        first_media = row["first_media_ts"]
        if media_ts is not None:
            first_media = media_ts if first_media is None else min(first_media,
                                                                   media_ts)
        conn.execute(
            "UPDATE entities SET last_seen = ?, last_media_ts = ?, "
            "first_seen = MIN(first_seen, ?), first_media_ts = ?, "
            "sessions_json = ?, updated_at = ?, "
            "kind = CASE WHEN kind = 'unknown' THEN ? ELSE kind END "
            "WHERE entity_id = ?",
            (observed_at, media_ts, observed_at, first_media,
             json.dumps(sessions), observed_at, kind.value, entity_id))

    for original, norm in zip(candidates, normalized, strict=False):
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_id = ?",
            (entity_id,)).fetchone()["n"]
        if count >= MAX_ALIASES:
            break
        conn.execute(
            "INSERT OR IGNORE INTO entity_aliases (normalized, entity_id, alias, "
            "added_at) VALUES (?,?,?,?)",
            (norm, entity_id, str(original), observed_at))
    return entity_id, created


def close_attribute(conn: sqlite3.Connection, attribute_id: str, *,
                    at: float, superseded_by: str) -> None:
    conn.execute(
        "UPDATE entity_attributes SET valid_to = ?, superseded_by = ? "
        "WHERE attribute_id = ? AND valid_to IS NULL",
        (at, superseded_by, attribute_id))


def insert_attribute(conn: sqlite3.Connection, attribute: Attribute) -> str:
    attribute_id = attribute.attribute_id or f"attr_{uuid.uuid4().hex[:12]}"
    conn.execute(
        "INSERT INTO entity_attributes (attribute_id, entity_id, name, value_json, "
        "confidence, score, valid_from, valid_to, observed_at, media_ts, source, "
        "evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (attribute_id, attribute.entity_id, attribute.name,
         json.dumps(attribute.value, default=str), attribute.confidence.value,
         attribute.score, attribute.valid_from, attribute.valid_to,
         attribute.observed_at, attribute.media_ts, attribute.source,
         json.dumps([link.model_dump() for link in attribute.evidence],
                    default=str)))
    return attribute_id


def open_attribute(conn: sqlite3.Connection, entity_id: str,
                   name: str) -> Attribute | None:
    row = conn.execute(
        "SELECT * FROM entity_attributes WHERE entity_id = ? AND name = ? "
        "AND valid_to IS NULL", (entity_id, name)).fetchone()
    return _row_to_attribute(row) if row else None


def record_conflict(conn: sqlite3.Connection, conflict: Conflict) -> str:
    conflict_id = f"cft_{uuid.uuid4().hex[:12]}"
    conn.execute(
        "INSERT INTO entity_conflicts (conflict_id, entity_id, name, incumbent_id, "
        "incumbent_value, incumbent_confidence, candidate_value, "
        "candidate_confidence, candidate_source, detected_at, resolution) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (conflict_id, conflict.entity_id, conflict.name, conflict.incumbent_id,
         json.dumps(conflict.incumbent_value, default=str),
         conflict.incumbent_confidence,
         json.dumps(conflict.candidate_value, default=str),
         conflict.candidate_confidence, conflict.candidate_source,
         conflict.detected_at or time.time(), conflict.resolution))
    return conflict_id


def count_attributes(conn: sqlite3.Connection, entity_id: str) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) AS n FROM entity_attributes WHERE entity_id = ? "
        "AND valid_to IS NULL", (entity_id,)).fetchone()["n"])


__all__ = [
    "MIGRATIONS",
    "attribute_history",
    "attributes_at",
    "close_attribute",
    "conflicts_for",
    "connect",
    "count_attributes",
    "current_attributes",
    "entities_path",
    "find_by_alias",
    "get_entity",
    "insert_attribute",
    "list_entities",
    "migrate",
    "open_attribute",
    "record_conflict",
    "upsert_entity",
]
