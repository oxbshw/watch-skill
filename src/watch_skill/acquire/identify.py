"""Turn an acquisition into a content revision — without re-hashing the world.

The expensive part of content identity is the digest, and the whole point of
the fingerprint is to skip it. Three ways a digest is obtained here, cheapest
first:

1. the alias's stored revision, when the live fingerprint still matches it;
2. the download cache's manifest, when the cached file is byte-identical to
   what was committed;
3. an actual read of the file.

Only the third touches the bytes, and it happens once per distinct content.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from watch_skill.acquire.sources import SourceKind
from watch_skill.acquire.types import AcquireResult
from watch_skill.identity import (
    Fingerprint,
    Revision,
    digest_file,
    local_fingerprint,
    make_revision,
    remote_fingerprint,
    synthetic_digest,
)


def _known_digest(source: str, observed: Fingerprint) -> str | None:
    """The digest the index already holds for this alias, if still valid."""
    from watch_skill.index.db import connect  # noqa: PLC0415
    from watch_skill.index.revisions import get_alias_state, get_revision  # noqa: PLC0415

    try:
        conn = connect()
    except Exception:  # noqa: BLE001 - identity must not depend on a writable index
        return None
    try:
        state = get_alias_state(conn, source)
        if state is None or not state.known or not observed.matches(state.fingerprint):
            return None
        if not observed.significant:
            return None
        revision = get_revision(conn, state.revision_id or "")
        if revision is None or revision.origin.get("digest_source") == "legacy":
            return None
        return revision.content_digest
    finally:
        conn.close()


def _origin(result: AcquireResult) -> dict[str, Any]:
    info = result.info or {}
    return {
        "kind": result.kind.value,
        "acquirer": result.acquirer,
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "remote_id": info.get("id"),
        "webpage_url": info.get("webpage_url") or info.get("url"),
        "duration": info.get("duration"),
        "title": info.get("title"),
    }


def identify(result: AcquireResult, *, digest_hint: str | None = None) -> AcquireResult:
    """Attach a :class:`Revision` to an acquisition result.

    ``digest_hint`` is passed by callers that already hashed the bytes while
    writing them (the download cache), so a fresh 4 GB fetch is read once.
    """
    if result.video_path is None:
        return result

    path = Path(result.video_path)
    observed = local_fingerprint(path)
    if result.kind is not SourceKind.LOCAL_FILE:
        # Remote metadata is evidence about the *source*; the local file's
        # stat is evidence about the copy. Both matter, so both are kept.
        remote = remote_fingerprint(result.info or {})
        observed = Fingerprint(
            kind="remote", data={**remote.data, "local_size": observed.data["size"]}
        )

    digest = digest_hint or _known_digest(result.source, observed) or digest_file(path)
    result.revision = make_revision(
        content_digest=digest,
        fingerprint=observed,
        origin=_origin(result),
    )
    return result


def capture_revision(video_path: Path, target: str) -> Revision:
    """Identity for a recording this machine just produced.

    A capture has no upstream to revalidate against, so the fingerprint is the
    file's own stat and the digest is real — two recordings of the same screen
    are genuinely two revisions.
    """
    path = Path(video_path)
    return make_revision(
        content_digest=digest_file(path),
        fingerprint=local_fingerprint(path),
        origin={"kind": "capture", "target": target, "acquirer": "capture"},
    )


def live_revision(target: str, marker: str) -> Revision:
    """Identity for content whose bytes cannot be hashed (an open stream).

    Marked ``digest_source: synthetic`` so no surface can present it as a
    content hash. Every acquisition is its own revision, which is the honest
    answer for a stream that never repeats.
    """
    revision = make_revision(
        content_digest=synthetic_digest(f"{target}/{marker}"),
        origin={"kind": "live", "target": target, "digest_source": "synthetic"},
    )
    return revision
