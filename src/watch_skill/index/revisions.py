"""Persistence for content identity: aliases, assets, revisions.

The read path other modules care about is :func:`resolve_alias` — given what
the user typed, it says which revision that alias points at and how much it
can honestly claim about freshness. Nothing here acquires anything; deciding
whether a stale alias should be re-acquired belongs to the caller, because
that decision costs a download and may be forbidden by policy.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from watch_skill.identity import (
    Fingerprint,
    Freshness,
    RevalidationPolicy,
    Revision,
    alias_id,
    freshness_for,
    legacy_video_id_for,
    normalize_alias,
    video_id_for_digest,
)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _fingerprint_from_json(raw: str | None) -> Fingerprint | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data:
        return None
    kind = data.pop("kind", "local")
    return Fingerprint(kind=kind, data=data)


@dataclass
class AliasState:
    """What the index remembers about one source string."""

    alias: str
    alias_id: str
    asset_id: str | None
    revision_id: str | None
    fingerprint: Fingerprint | None
    policy: RevalidationPolicy
    checked_at: str | None

    @property
    def known(self) -> bool:
        return self.revision_id is not None


@dataclass
class Resolution:
    """The answer to "what does this alias point at, and can I trust it?"."""

    alias: str
    alias_id: str
    freshness: Freshness
    revision: Revision | None = None
    video_id: str | None = None
    reason: str = ""

    @property
    def usable(self) -> bool:
        """Whether stored artifacts may be presented as current evidence."""
        return self.freshness is Freshness.FRESH and self.video_id is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "alias": self.alias,
            "alias_id": self.alias_id,
            "freshness": self.freshness.value,
            "video_id": self.video_id,
            "revision": self.revision.to_dict() if self.revision else None,
            "reason": self.reason,
        }


# --- reads ------------------------------------------------------------------


def get_alias_state(conn: sqlite3.Connection, source: str) -> AliasState | None:
    row = conn.execute(
        "SELECT * FROM source_aliases WHERE normalized = ?",
        (normalize_alias(source),),
    ).fetchone()
    if row is None:
        return None
    try:
        policy = RevalidationPolicy(row["policy"])
    except ValueError:
        policy = RevalidationPolicy.REVALIDATE
    return AliasState(
        alias=row["alias"],
        alias_id=row["id"],
        asset_id=row["asset_id"],
        revision_id=row["revision_id"],
        fingerprint=_fingerprint_from_json(row["fingerprint_json"]),
        policy=policy,
        checked_at=row["checked_at"],
    )


def get_revision(conn: sqlite3.Connection, revision_id: str) -> Revision | None:
    row = conn.execute("SELECT * FROM revisions WHERE id = ?", (revision_id,)).fetchone()
    if row is None:
        return None
    return Revision(
        revision_id=row["id"],
        asset_id=row["asset_id"],
        content_digest=row["content_digest"],
        digest_algorithm=row["digest_algorithm"],
        fingerprint=_fingerprint_from_json(row["fingerprint_json"]),
        origin={**json.loads(row["origin_json"] or "{}"),
                "digest_source": row["digest_source"]},
        acquired_at=row["acquired_at"],
    )


def revision_by_digest(conn: sqlite3.Connection, content_digest: str) -> Revision | None:
    row = conn.execute(
        "SELECT id FROM revisions WHERE content_digest = ?", (content_digest,)
    ).fetchone()
    return get_revision(conn, row["id"]) if row else None


def video_id_for_revision(conn: sqlite3.Connection, revision_id: str) -> str | None:
    """The indexed video row holding this revision's artifacts, if any."""
    row = conn.execute(
        "SELECT id FROM videos WHERE revision_id = ? ORDER BY last_analyzed_at DESC "
        "LIMIT 1",
        (revision_id,),
    ).fetchone()
    return row["id"] if row else None


def resolve_video_id(conn: sqlite3.Connection, candidate: str) -> str | None:
    """Map any id the caller might hold to a live ``videos.id``.

    Covers v1 ids minted from the source string, v2 content-derived ids, and
    ids that were adopted by a later row — every id Watch Skill has ever
    printed still resolves to something.
    """
    row = conn.execute("SELECT id FROM videos WHERE id = ?", (candidate,)).fetchone()
    if row:
        return row["id"]
    row = conn.execute(
        "SELECT video_id FROM video_aliases WHERE alias_video_id = ?", (candidate,)
    ).fetchone()
    if row and conn.execute(
        "SELECT 1 FROM videos WHERE id = ?", (row["video_id"],)
    ).fetchone():
        return row["video_id"]
    return None


def resolve_alias(
    conn: sqlite3.Connection,
    source: str,
    *,
    observed: Fingerprint | None = None,
    force_refresh: bool = False,
) -> Resolution:
    """What this alias points at, and whether it may be answered from.

    ``observed`` is the fingerprint the caller just took of the live source.
    Omitting it (because the source is unreachable, or offline policy forbade
    the check) yields :attr:`Freshness.UNKNOWN` — never a confident hit.
    """
    ident = alias_id(source)
    state = get_alias_state(conn, source)
    if state is None or not state.known:
        return Resolution(
            alias=source, alias_id=ident, freshness=Freshness.UNKNOWN,
            reason="alias has never been indexed",
        )

    policy = RevalidationPolicy.REFRESH if force_refresh else state.policy
    freshness = freshness_for(
        observed=observed,
        stored=state.fingerprint,
        policy=policy,
        checked_at=state.checked_at,
    )
    revision = get_revision(conn, state.revision_id or "")
    video_id = video_id_for_revision(conn, state.revision_id or "") if revision else None
    reasons = {
        Freshness.FRESH: "fingerprint matches the indexed revision",
        Freshness.STALE: "the source has changed since it was indexed",
        Freshness.REFRESH_REQUIRED: "policy requires re-acquiring before answering",
        Freshness.UNKNOWN: "could not check whether the source still matches",
    }
    return Resolution(
        alias=source, alias_id=ident, freshness=freshness, revision=revision,
        video_id=video_id, reason=reasons[freshness],
    )


# --- writes -----------------------------------------------------------------


def record_revision(conn: sqlite3.Connection, revision: Revision) -> Revision:
    """Persist a revision (idempotent on content digest).

    Re-analysing unchanged content must not mint a second revision, so the
    digest is the key and an existing row wins. The insert has to be the
    atomic step rather than a check followed by an insert: two processes
    indexing the same file is the ordinary case (an agent and a CLI), and
    check-then-insert loses that race with a UNIQUE violation.
    """
    conn.execute("INSERT OR IGNORE INTO assets (id) VALUES (?)", (revision.asset_id,))
    origin = dict(revision.origin)
    digest_source = origin.pop("digest_source", "content")
    conn.execute(
        "INSERT INTO revisions (id, asset_id, content_digest, digest_algorithm, "
        "digest_source, fingerprint_json, origin_json, acquired_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(content_digest) DO NOTHING",
        (
            revision.revision_id, revision.asset_id, revision.content_digest,
            revision.digest_algorithm, digest_source,
            json.dumps(revision.fingerprint.to_dict() if revision.fingerprint else {}),
            json.dumps(origin, ensure_ascii=False), revision.acquired_at,
        ),
    )
    stored = revision_by_digest(conn, revision.content_digest)
    return stored if stored is not None else revision


def bind_alias(
    conn: sqlite3.Connection,
    source: str,
    revision: Revision,
    *,
    fingerprint: Fingerprint | None = None,
    policy: RevalidationPolicy | None = None,
) -> str:
    """Point an alias at a revision, keeping the alias's asset history.

    An alias that already has an asset keeps it: ``demo.mp4`` overwritten with
    a different video is a new *revision* of the thing that path names, and
    collapsing that into a brand-new asset would lose the connection between
    what was there yesterday and what is there now.
    """
    from watch_skill.acquire.sources import classify_source  # noqa: PLC0415

    ident = alias_id(source)
    state = get_alias_state(conn, source)
    asset = state.asset_id if state and state.asset_id else revision.asset_id
    if asset != revision.asset_id:
        conn.execute("INSERT OR IGNORE INTO assets (id) VALUES (?)", (asset,))
        conn.execute("UPDATE revisions SET asset_id = ? WHERE id = ?",
                     (asset, revision.revision_id))
        revision.asset_id = asset
    payload = fingerprint or revision.fingerprint
    conn.execute(
        "INSERT INTO source_aliases (id, alias, normalized, kind, asset_id, "
        "revision_id, fingerprint_json, policy, checked_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(normalized) DO UPDATE SET "
        "  alias=excluded.alias, asset_id=excluded.asset_id, "
        "  revision_id=excluded.revision_id, "
        "  fingerprint_json=excluded.fingerprint_json, "
        "  policy=COALESCE(excluded.policy, source_aliases.policy), "
        "  checked_at=excluded.checked_at",
        (
            ident, source, normalize_alias(source), classify_source(source).value,
            asset, revision.revision_id,
            json.dumps(payload.to_dict() if payload else {}),
            (policy or (state.policy if state else RevalidationPolicy.REVALIDATE)).value,
            _now(),
        ),
    )
    return ident


def touch_alias(conn: sqlite3.Connection, source: str, fingerprint: Fingerprint) -> None:
    """Record a successful revalidation without changing what it points at."""
    conn.execute(
        "UPDATE source_aliases SET fingerprint_json = ?, checked_at = ? "
        "WHERE normalized = ?",
        (json.dumps(fingerprint.to_dict()), _now(), normalize_alias(source)),
    )


def set_alias_policy(
    conn: sqlite3.Connection, source: str, policy: RevalidationPolicy
) -> None:
    conn.execute(
        "UPDATE source_aliases SET policy = ? WHERE normalized = ?",
        (policy.value, normalize_alias(source)),
    )


def register_video_alias(
    conn: sqlite3.Connection, alias_video_id: str, video_id: str, reason: str = "legacy"
) -> None:
    """Make an old id keep resolving after a row is adopted or superseded."""
    if alias_video_id == video_id:
        return
    conn.execute(
        "INSERT INTO video_aliases (alias_video_id, video_id, reason) VALUES (?, ?, ?) "
        "ON CONFLICT(alias_video_id) DO UPDATE SET video_id = excluded.video_id",
        (alias_video_id, video_id, reason),
    )


def claim_video_row(
    conn: sqlite3.Connection, source: str, revision: Revision
) -> tuple[str, bool]:
    """Decide which ``videos.id`` holds this revision's artifacts.

    Three cases, in order:

    1. a row already carries this revision — re-analysis is idempotent and
       reuses it;
    2. a v1 row exists for this alias and has no digest yet — it is *adopted*,
       keeping the id every agent already has while gaining real identity;
    3. otherwise a new content-derived row id, with the previous row for this
       alias marked superseded rather than overwritten.

    Returns ``(video_id, adopted)``.
    """
    existing = video_id_for_revision(conn, revision.revision_id)
    if existing is not None:
        return existing, False

    canonical = video_id_for_digest(revision.content_digest)
    legacy = legacy_video_id_for(source)
    row = conn.execute(
        "SELECT id, content_digest FROM videos WHERE id = ?", (legacy,)
    ).fetchone()
    if row is not None and not row["content_digest"]:
        register_video_alias(conn, canonical, legacy, reason="adopted")
        return legacy, True

    conn.execute(
        "UPDATE videos SET superseded_at = datetime('now') "
        "WHERE asset_id = ? AND id != ? AND superseded_at IS NULL",
        (revision.asset_id, canonical),
    )
    return canonical, False


def revisions_for_alias(conn: sqlite3.Connection, source: str) -> list[dict[str, Any]]:
    """Every revision this alias's asset has held, newest first."""
    state = get_alias_state(conn, source)
    if state is None or state.asset_id is None:
        return []
    rows = conn.execute(
        "SELECT r.id, r.content_digest, r.digest_source, r.acquired_at, "
        "       v.id AS video_id, v.superseded_at "
        "FROM revisions r LEFT JOIN videos v ON v.revision_id = r.id "
        "WHERE r.asset_id = ? ORDER BY r.acquired_at DESC",
        (state.asset_id,),
    ).fetchall()
    return [
        {
            "revision_id": row["id"],
            "content_digest": row["content_digest"],
            "digest_source": row["digest_source"],
            "acquired_at": row["acquired_at"],
            "video_id": row["video_id"],
            "current": row["id"] == state.revision_id,
            "superseded_at": row["superseded_at"],
        }
        for row in rows
    ]
