"""Write path: persist a WatchResult so questions never re-burn analysis."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.index import embeddings as emb
from watch_skill.index.db import connect
from watch_skill.watch import WatchResult


def video_id_for(source: str) -> str:
    """The v1 id for a source string.

    Kept because every id already printed, cached, or written into an agent's
    notes came from here and must keep resolving. It is no longer how new
    videos are identified — that is the content digest (see
    :mod:`watch_skill.identity`) — so this is a *legacy resolver*, not an
    identity function.
    """
    return hashlib.sha256(source.strip().encode("utf-8")).hexdigest()[:16]


def _persist_frames(result: WatchResult, video_id: str) -> tuple[Path, Path | None]:
    """Copy kept frames out of the throwaway work dir into managed storage.

    Staged through a private directory and swapped in at the end. Wiping the
    destination first looked simpler but destroyed the very files it was about
    to copy in two ways:

    * re-indexing the same WatchResult — the retry path — reads frames whose
      paths this function already repointed *into* the destination, so the
      wipe deleted its own inputs;
    * two processes indexing the same video race, because the id is derived
      from content and both land on one directory.

    Either way the copy failed with a bare FileNotFoundError and the index
    kept a row pointing at frames that were no longer there.

    Returns the destination and, when one existed, the directory holding the
    frames it displaced. The caller owns that directory: it must call
    :func:`_commit_frames` once the database has committed, or
    :func:`_rollback_frames` if it has not. Deleting the displaced frames here
    is what let a rolled-back transaction leave committed `frame_path` rows
    pointing at files this function had already removed.
    """
    frames_root = get_settings().data_dir / "frames"
    dest = frames_root / video_id
    if result.perception is None:
        dest.mkdir(parents=True, exist_ok=True)
        return dest, None

    frames_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{video_id}.", dir=frames_root))
    try:
        # Sources may live in the work dir (first pass) or already inside
        # dest (a retry); staging elsewhere means both read fine.
        copied: list[tuple[Any, Path]] = []
        for frame in result.perception.frames:
            target = staging / frame.path.name
            shutil.copy2(frame.path, target)
            copied.append((frame, target))

        # Swap: the window where dest is absent is a rename wide, not a copy.
        previous = dest.with_name(f".{video_id}.old-{os.getpid()}")
        if dest.exists():
            os.replace(dest, previous)
        try:
            os.replace(staging, dest)
        except OSError:
            if previous.exists():  # put the old frames back rather than lose both
                os.replace(previous, dest)
            shutil.rmtree(previous, ignore_errors=True)
            raise

        for frame, target in copied:
            frame.path = dest / target.name
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return dest, (previous if previous.exists() else None)


def _commit_frames(previous: Path | None) -> None:
    """Drop the displaced frames. Safe only once the database has committed."""
    if previous is not None:
        shutil.rmtree(previous, ignore_errors=True)


def _rollback_frames(dest: Path, previous: Path | None) -> None:
    """Undo a frame swap whose database transaction did not commit.

    The published directory goes back to exactly what was there before the
    call, so rows committed by an earlier successful index keep resolving. A
    video indexed for the first time has nothing to restore, and its frames
    are removed rather than left behind as an orphan directory no row names.
    """
    try:
        if previous is not None:
            shutil.rmtree(dest, ignore_errors=True)
            os.replace(previous, dest)
        else:
            shutil.rmtree(dest, ignore_errors=True)
    except OSError:
        # A rollback that cannot complete must not mask the original failure;
        # the displaced frames are still on disk under their `.old-` name.
        pass


def _insert_video(conn: sqlite3.Connection, result: WatchResult, video_id: str, frames_dir: Path) -> None:
    info = result.acquisition.info
    revision = result.acquisition.revision
    conn.execute(
        """
        INSERT INTO videos (id, source, title, uploader, duration_seconds, width,
                            height, transcript_source, frames_dir,
                            asset_id, revision_id, content_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, uploader=excluded.uploader,
            duration_seconds=excluded.duration_seconds,
            transcript_source=excluded.transcript_source,
            frames_dir=excluded.frames_dir,
            asset_id=excluded.asset_id,
            revision_id=excluded.revision_id,
            content_digest=excluded.content_digest,
            superseded_at=NULL,
            last_analyzed_at=datetime('now')
        """,
        (
            video_id, result.acquisition.source, info.get("title"), info.get("uploader"),
            result.metadata.duration_seconds, result.metadata.width, result.metadata.height,
            result.transcript.source, str(frames_dir),
            revision.asset_id if revision else None,
            revision.revision_id if revision else None,
            revision.content_digest if revision else None,
        ),
    )
    # re-analysis replaces derived rows (cached answers invalidate too —
    # they were derived from the old analysis)
    for table in ("segments", "scenes", "ocr_blocks", "embeddings", "answers"):
        conn.execute(f"DELETE FROM {table} WHERE video_id = ?", (video_id,))
    conn.execute("DELETE FROM fts WHERE video_id = ?", (video_id,))


def _insert_derived(conn: sqlite3.Connection, result: WatchResult, video_id: str) -> list[tuple]:
    """Insert segments/scenes/ocr; return (kind, ref_id, timestamp, text) for embedding."""
    to_embed: list[tuple] = []
    for seg in result.transcript.segments:
        import json as _json  # noqa: PLC0415

        words = _json.dumps([w.to_dict() for w in seg.words]) if seg.words else None
        cur = conn.execute(
            "INSERT INTO segments (video_id, start, end, text, words_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (video_id, seg.start, seg.end, seg.text, words),
        )
        to_embed.append(("segment", cur.lastrowid, seg.start, seg.text))

    if result.perception is not None:
        for frame in result.perception.frames:
            cur = conn.execute(
                """INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, phash, reason)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    video_id, frame.scene_id, frame.timestamp_seconds,
                    str(frame.path), frame.phash, frame.reason,
                ),
            )
            scene_row = cur.lastrowid
            for block in frame.ocr_blocks:
                ocr_cur = conn.execute(
                    """INSERT INTO ocr_blocks
                       (video_id, scene_row_id, timestamp, text, x1, y1, x2, y2, confidence)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        video_id, scene_row, frame.timestamp_seconds, block.text,
                        *block.bbox, block.confidence,
                    ),
                )
                to_embed.append(("ocr", ocr_cur.lastrowid, frame.timestamp_seconds, block.text))
    return to_embed


def set_scene_description(conn: sqlite3.Connection, scene_row_id: int, description: str) -> None:
    """Attach a vision-generated one-line description to a scene frame row."""
    row = conn.execute(
        "SELECT video_id, timestamp FROM scenes WHERE id = ?", (scene_row_id,)
    ).fetchone()
    if row is None:
        return
    conn.execute("UPDATE scenes SET description = ? WHERE id = ?", (description, scene_row_id))
    _index_texts(conn, row["video_id"], [("scene", scene_row_id, row["timestamp"], description)])


def _index_texts(conn: sqlite3.Connection, video_id: str, items: list[tuple]) -> None:
    """Insert FTS rows and (when available) embedding rows for text items.

    Embeds with the model pinned in the index meta (set on first write) so
    every vector in one index comes from one model.
    """
    from watch_skill.index.db import get_meta, set_meta
    from watch_skill.index.textnorm import normalize_for_search

    for kind, ref_id, timestamp, text in items:
        conn.execute(
            "INSERT INTO fts (text, text_norm, video_id, kind, ref_id, timestamp) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (text, normalize_for_search(text), video_id, kind, ref_id, timestamp),
        )
    # precedence: the model this index is PINNED to > the opt-in override
    # (new indexes only) > the default. Vectors from two models never mix.
    model_name = (
        get_meta(conn, "embedding_model")
        or get_settings().embedding_model
        or emb.MODEL_NAME
    )
    vectors = emb.embed_texts([text for _, _, _, text in items], model_name=model_name)
    if vectors:
        set_meta(conn, "embedding_model", model_name)
        for (kind, ref_id, timestamp, text), vector in zip(items, vectors, strict=False):
            conn.execute(
                """INSERT INTO embeddings (video_id, kind, ref_id, timestamp, text, vector, dim)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (video_id, kind, ref_id, timestamp, text, emb.pack_vector(vector), len(vector)),
            )


def _maybe_describe_scenes(conn: sqlite3.Connection, video_id: str) -> None:
    """Attach one-line visual descriptions via the cheap vision tier.

    Opportunistic: silently skipped when no key is configured for the cheap
    provider or the call fails — the index works without descriptions, they
    just make retrieval smarter.

    This is the path that used to upload every indexed frame to whichever
    cloud provider had a key set, because a key was read as consent. It now
    asks the policy first: ``off`` and a denied frame-egress channel both mean
    no frame leaves, and ``auto`` resolves to local rather than upgrading
    itself to cloud.
    """
    from watch_skill.errors import PolicyError, VisionError
    from watch_skill.policy import (
        Channel,
        SceneDescriptionMode,
        get_policy,
        is_local_provider,
    )
    from watch_skill.vision import get_vision

    policy = get_policy()
    mode = policy.describes_scene_egress()
    if mode is SceneDescriptionMode.OFF:
        return
    provider = get_settings().vision_cheap_provider
    if mode is SceneDescriptionMode.LOCAL and not is_local_provider(provider):
        print(
            "[watch-skill] scene descriptions skipped (policy: local only, "
            f"cheap provider is {provider})",
            file=__import__("sys").stderr,
        )
        return
    if not policy.check(Channel.FRAMES, provider=provider).allowed:
        print(
            "[watch-skill] scene descriptions skipped (frame egress denied by policy)",
            file=__import__("sys").stderr,
        )
        return

    rows = conn.execute(
        "SELECT id, frame_path FROM scenes WHERE video_id = ? AND description IS NULL "
        "ORDER BY timestamp",
        (video_id,),
    ).fetchall()
    rows = [r for r in rows if Path(r["frame_path"]).is_file()][:24]
    if not rows:
        return
    try:
        model = get_vision("cheap", phase="index.describe_scenes")
        descriptions = model.describe_frames([Path(r["frame_path"]) for r in rows])
    except PolicyError as exc:
        print(f"[watch-skill] scene descriptions skipped ({exc.code})",
              file=__import__("sys").stderr)
        return
    except VisionError as exc:
        import sys

        print(f"[watch-skill] scene descriptions skipped ({exc.code})", file=sys.stderr)
        return
    except Exception as exc:  # descriptions are opportunistic — NEVER sink the watch
        import sys

        print(f"[watch-skill] scene descriptions skipped (unexpected: {exc})", file=sys.stderr)
        return
    for row, description in zip(rows, descriptions, strict=False):
        if description:
            set_scene_description(conn, row["id"], description)


def _video_id_for_result(conn: sqlite3.Connection, result: WatchResult) -> str:
    """Which row this watch pass writes into.

    Content-derived when the acquisition produced a revision, so re-analysing
    unchanged bytes lands on the same row and changed bytes never do. Without
    a revision (a captions-only probe has no media to hash) it falls back to
    the v1 id, which is the behaviour those paths always had.
    """
    from watch_skill.index.revisions import bind_alias, claim_video_row, record_revision

    revision = result.acquisition.revision
    if revision is None:
        return video_id_for(result.acquisition.source)
    result.acquisition.revision = record_revision(conn, revision)
    bind_alias(conn, result.acquisition.source, result.acquisition.revision)
    video_id, _ = claim_video_row(
        conn, result.acquisition.source, result.acquisition.revision
    )
    return video_id


def index_watch_result(result: WatchResult, describe_scenes: bool = True) -> str:
    """Persist everything a watch pass learned; returns the video_id."""
    conn = connect()
    try:
        with conn:
            video_id = _video_id_for_result(conn, result)
        frames_dir, displaced = _persist_frames(result, video_id)
        try:
            with conn:
                _insert_video(conn, result, video_id, frames_dir)
                items = _insert_derived(conn, result, video_id)
                _index_texts(conn, video_id, items)
        except BaseException:
            # The rows rolled back, so the frames must too. Without this the
            # database keeps the previous scene rows while their frame files
            # have already been replaced, and a committed frame_path resolves
            # to nothing.
            _rollback_frames(frames_dir, displaced)
            raise
        _commit_frames(displaced)
        if describe_scenes:
            with conn:
                _maybe_describe_scenes(conn, video_id)
    finally:
        conn.close()
    _distill_notes_safely(video_id)
    return video_id


def _distill_notes_safely(video_id: str) -> None:
    """Distill library notes for the just-indexed video (incremental: only
    this video's notes are re-derived). Notes are derived data — failure
    must never sink the watch."""
    try:
        from watch_skill.library.notes import distill_notes

        distill_notes(video_id)
    except Exception as exc:  # noqa: BLE001
        import sys

        print(f"[watch-skill] note distillation skipped ({exc})", file=sys.stderr)


def augment_video(video_id: str, perception: Any) -> int:
    """ADD escalation-pass frames/OCR to an existing video's index rows.

    Unlike :func:`index_watch_result`, nothing is deleted — the self-healing
    answer ladder re-samples a narrow window densely and this merges what it
    found (new scene frames, OCR blocks, their FTS + embedding rows) into the
    already-indexed video. Returns the number of new text items indexed.
    """
    conn = connect()
    try:
        with conn:
            to_embed: list[tuple] = []
            for frame in perception.frames:
                cur = conn.execute(
                    """INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, phash, reason)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        video_id, frame.scene_id, frame.timestamp_seconds,
                        str(frame.path), frame.phash, "escalation",
                    ),
                )
                scene_row = cur.lastrowid
                for block in frame.ocr_blocks:
                    ocr_cur = conn.execute(
                        """INSERT INTO ocr_blocks
                           (video_id, scene_row_id, timestamp, text, x1, y1, x2, y2, confidence)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            video_id, scene_row, frame.timestamp_seconds, block.text,
                            *block.bbox, block.confidence,
                        ),
                    )
                    to_embed.append(("ocr", ocr_cur.lastrowid, frame.timestamp_seconds, block.text))
            _index_texts(conn, video_id, to_embed)
            return len(to_embed)
    finally:
        conn.close()


def _lookup_row(conn: sqlite3.Connection, video_id_or_source: str) -> dict[str, Any] | None:
    """Resolve an id or a source string to one video row.

    Order matters. An explicit id — v1, v2, or one that was superseded — names
    an exact revision and wins outright, because an agent holding an id is
    asking about *that* analysis. A source string names an alias, which points
    at whatever is current, so it resolves through the alias table and falls
    back to the v1 id only for rows written before aliases existed.
    """
    from watch_skill.identity import looks_like_video_id
    from watch_skill.index.revisions import get_alias_state, resolve_video_id

    candidate = video_id_or_source.strip()
    if looks_like_video_id(candidate):
        resolved = resolve_video_id(conn, candidate)
        if resolved:
            row = conn.execute("SELECT * FROM videos WHERE id = ?", (resolved,)).fetchone()
            if row:
                return dict(row)

    state = get_alias_state(conn, candidate)
    if state is not None and state.revision_id:
        row = conn.execute(
            "SELECT * FROM videos WHERE revision_id = ? ORDER BY last_analyzed_at DESC "
            "LIMIT 1",
            (state.revision_id,),
        ).fetchone()
        if row:
            return dict(row)

    row = conn.execute(
        "SELECT * FROM videos WHERE id = ? OR source = ? OR id = ? "
        "ORDER BY superseded_at IS NOT NULL, last_analyzed_at DESC LIMIT 1",
        (candidate, candidate, video_id_for(candidate)),
    ).fetchone()
    return dict(row) if row else None


def get_video(video_id_or_source: str) -> dict[str, Any] | None:
    """Look up a video row by id or by original source string."""
    conn = connect()
    try:
        return _lookup_row(conn, video_id_or_source)
    finally:
        conn.close()


def check_freshness(video_id_or_source: str) -> dict[str, Any]:
    """Whether the indexed artifacts still describe what the source holds now.

    Callers that are about to present stored evidence as current — ask, moment,
    search, the viewer — go through here first. The four states are the whole
    point: ``freshness_unknown`` is a real answer, and answering anyway while
    pretending otherwise is the bug this replaced.
    """
    from watch_skill.acquire.sources import SourceKind, classify_source
    from watch_skill.identity import Freshness, local_fingerprint, looks_like_video_id
    from watch_skill.index.revisions import get_alias_state, resolve_alias

    candidate = video_id_or_source.strip()
    conn = connect()
    try:
        row = _lookup_row(conn, candidate)
        if row is None:
            return {"state": Freshness.UNKNOWN.value, "video_id": None,
                    "reason": "not indexed"}

        # An id names one immutable revision. It cannot go stale; it can only
        # have been superseded, which the caller is told about explicitly.
        if looks_like_video_id(candidate) and row["id"] in (
            candidate, *(
                r["alias_video_id"] for r in conn.execute(
                    "SELECT alias_video_id FROM video_aliases WHERE video_id = ?",
                    (row["id"],),
                ).fetchall()
            )
        ):
            return {
                "state": Freshness.FRESH.value,
                "video_id": row["id"],
                "revision_id": row["revision_id"],
                "superseded": bool(row["superseded_at"]),
                "reason": "an id names one immutable revision",
            }

        alias = candidate if get_alias_state(conn, candidate) else row["source"]
        observed = None
        if classify_source(alias) is SourceKind.LOCAL_FILE:
            try:
                observed = local_fingerprint(Path(alias).expanduser().resolve())
            except OSError:
                observed = None  # gone or unreadable -> freshness_unknown, not fresh
        resolution = resolve_alias(conn, alias, observed=observed)
        return {
            "state": resolution.freshness.value,
            "video_id": resolution.video_id or row["id"],
            "revision_id": row["revision_id"],
            "superseded": bool(row["superseded_at"]),
            "reason": resolution.reason,
            "alias": alias,
        }
    finally:
        conn.close()


def require_current(
    video_id_or_source: str, *, allow_stale: bool = False
) -> dict[str, Any]:
    """Gate every read that presents stored artifacts as current evidence.

    Demonstrably stale content raises rather than answering: the old failure
    mode was a confident, correctly-formatted answer about a video that no
    longer exists at that path. ``freshness_unknown`` — a remote source we did
    not go to the network to check, or a row migrated from v1 that never had a
    digest — is returned rather than raised, and travels with the answer so
    the caller can see what was and was not established.
    """
    from watch_skill.errors import StaleContentError
    from watch_skill.identity import Freshness

    state = check_freshness(video_id_or_source)
    if allow_stale or state["state"] not in (
        Freshness.STALE.value, Freshness.REFRESH_REQUIRED.value
    ):
        return state
    raise StaleContentError(
        f"the source has changed since it was indexed: {video_id_or_source}",
        code=f"index.{state['state']}",
        fix="re-watch it to index the current content, or ask by video_id "
        f"({state['video_id']}) to read the revision that was indexed",
        details=state,
    )


def source_revisions(video_id_or_source: str) -> list[dict[str, Any]]:
    """Every revision recorded for this source, newest first."""
    from watch_skill.index.revisions import revisions_for_alias

    conn = connect()
    try:
        row = _lookup_row(conn, video_id_or_source)
        alias = row["source"] if row else video_id_or_source
        return revisions_for_alias(conn, alias)
    finally:
        conn.close()


def forget_video(video_id_or_source: str) -> dict[str, Any]:
    """Delete one video from the index: rows (segments/scenes/ocr/embeddings/
    cached answers via FK cascade, FTS manually) plus its frames directory.

    Returns the forgotten video row; raises a structured error when unknown.
    """
    from watch_skill.errors import IndexError_  # noqa: PLC0415

    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="list_videos()/`watch-skill list` shows what can be forgotten",
        )
    conn = connect()
    try:
        with conn:
            conn.execute("DELETE FROM fts WHERE video_id = ?", (video["id"],))
            conn.execute("DELETE FROM videos WHERE id = ?", (video["id"],))
    finally:
        conn.close()
    frames_dir = get_settings().data_dir / "frames" / video["id"]
    if frames_dir.exists():
        shutil.rmtree(frames_dir, ignore_errors=True)
    return video


def list_videos() -> list[dict[str, Any]]:
    """All indexed videos, most recently analyzed first."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM videos ORDER BY last_analyzed_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
