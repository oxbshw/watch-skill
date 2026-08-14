"""Content identity: what the user typed is not what the bytes are.

Before this module a video's id was ``sha256(source_string)``. Overwrite
``demo.mp4`` and yesterday's frames, OCR and cached answers came back for
today's file, with nothing in the reply admitting it. The fix is to stop
treating the string as the identity and name the four things separately:

``source_alias``
    The path or URL the user typed. Mutable — it points at whatever is there
    now.
``asset``
    The logical video an alias has pointed at over time.
``revision``
    One immutable version of the content. Keyed by ``content_digest``, so the
    same bytes reached through two aliases are one revision, and different
    bytes at one alias are two.
``fingerprint``
    The cheap metadata (size, mtime, inode / ETag, Last-Modified) that decides
    whether the expensive digest has to be recomputed at all.

Digests are never recomputed for a multi-gigabyte file that has not moved:
the fingerprint gates them, and acquisition hashes while it copies.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from watch_skill.errors import WatchSkillError

DIGEST_ALGORITHM = "sha256"
_CHUNK = 1 << 20  # 1 MiB — big enough that syscall overhead vanishes


class Freshness(str, Enum):  # noqa: UP042 — matches SourceKind; StrEnum reads the same
    """How much we know about whether a revision still matches its alias."""

    FRESH = "fresh"
    """Revalidated just now, or immutable by policy."""

    STALE = "stale"
    """The alias demonstrably points at different content than the revision."""

    REFRESH_REQUIRED = "refresh_required"
    """We know it changed and policy says the caller must ask for a refresh."""

    UNKNOWN = "freshness_unknown"
    """We could not check — the source is unreachable, or offline policy
    forbids the network call revalidation would need."""


class RevalidationPolicy(str, Enum):  # noqa: UP042 — matches SourceKind
    """What a *lookup* is allowed to do to establish freshness."""

    IMMUTABLE = "immutable"
    """The content at this alias never changes; trust the stored revision."""

    REVALIDATE = "revalidate"
    """Check the cheap fingerprint on every lookup (the default)."""

    TTL = "ttl"
    """Trust the stored revision until ``ttl_seconds`` since the last check."""

    REFRESH = "refresh"
    """Always re-acquire."""


DEFAULT_TTL_SECONDS = 3600.0


class IdentityError(WatchSkillError):
    """Content identity could not be established safely."""


# --- normalization ----------------------------------------------------------

# Tracking and player-state parameters that never change which bytes come
# back. Stripping them means one video reached from a share link and from a
# timestamped link is one asset, not two.
_VOLATILE_QUERY_KEYS = frozenset(
    {
        "t", "start", "time_continue", "feature", "app", "si", "pp",
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "fbclid", "gclid", "igshid", "ref", "ref_src", "ref_url",
    }
)


def _is_network_source(value: str) -> bool:
    """Whether a source string addresses the network.

    Deliberately not ``acquire.sources.classify_source``: identity sits below
    acquisition and importing upward would make the two packages circular.
    """
    parts = urlsplit(value)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def normalize_alias(source: str) -> str:
    """Canonical form of a source string, for keying only.

    Local paths resolve (symlinks included, so two names for one file collapse)
    and case-fold on Windows. URLs lose the fragment, their volatile query
    parameters, a default port and a trailing slash. Never shown to the user —
    the alias they typed is what gets displayed.
    """
    stripped = source.strip()
    if not _is_network_source(stripped):
        try:
            resolved = str(Path(stripped).expanduser().resolve())
        except (OSError, RuntimeError):
            resolved = stripped
        return resolved.lower() if os.name == "nt" else resolved

    parts = urlsplit(stripped)
    host = (parts.hostname or "").lower()
    if parts.port and not (
        (parts.scheme == "http" and parts.port == 80)
        or (parts.scheme == "https" and parts.port == 443)
    ):
        host = f"{host}:{parts.port}"
    query = urlencode(
        [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if k.lower() not in _VOLATILE_QUERY_KEYS]
    )
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), host, path, query, ""))


def _short(prefix: str, material: str) -> str:
    return prefix + hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def alias_id(source: str) -> str:
    """Stable id for the *string* the user typed (after normalization)."""
    return _short("al_", normalize_alias(source))


def revision_id_for(content_digest: str) -> str:
    """Stable id for one immutable version of the content."""
    return _short("rev_", f"{DIGEST_ALGORITHM}:{content_digest}")


def video_id_for_digest(content_digest: str) -> str:
    """The canonical ``video_id`` for a revision.

    Sixteen hex chars, matching the shape of every id already handed out, so
    nothing downstream has to widen a column or a display width.
    """
    return hashlib.sha256(f"watch-skill/v2/{content_digest}".encode()).hexdigest()[:16]


def legacy_video_id_for(source: str) -> str:
    """The v1 id for a source: ``sha256(source)[:16]``.

    Kept verbatim — every id ever printed, cached or written into an agent's
    notes was minted by this function, and they all still have to resolve.
    """
    return hashlib.sha256(source.strip().encode("utf-8")).hexdigest()[:16]


# --- fingerprints -----------------------------------------------------------


@dataclass(frozen=True)
class Fingerprint:
    """Cheap evidence about a source, used to decide whether to re-digest."""

    kind: str  # "local" | "remote"
    data: dict[str, Any] = field(default_factory=dict)

    def matches(self, other: Fingerprint | None) -> bool:
        """True when nothing that would change the bytes has changed.

        Unknown-on-both-sides fields are ignored rather than treated as equal
        evidence: a fingerprint that knows nothing must not certify freshness,
        which is why :func:`freshness_for` demands ``significant`` too.
        """
        if other is None or other.kind != self.kind:
            return False
        return all(
            other.data.get(key) == value
            for key, value in self.data.items()
            if value is not None
        )

    @property
    def significant(self) -> bool:
        """Whether this fingerprint carries enough to certify a match."""
        if self.kind == "local":
            return self.data.get("size") is not None
        return any(
            self.data.get(key) is not None
            for key in ("etag", "last_modified", "content_length", "duration")
        )

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, **self.data}


def local_fingerprint(path: Path) -> Fingerprint:
    """Size, mtime and file identity for a local file — three cheap stats."""
    info = path.stat()
    file_id: str | None = None
    if info.st_ino:  # 0 on some Windows filesystems; absent identity, not a match
        file_id = f"{info.st_dev}:{info.st_ino}"
    return Fingerprint(
        kind="local",
        data={
            "path": str(path),
            "size": info.st_size,
            "mtime_ns": info.st_mtime_ns,
            "file_id": file_id,
        },
    )


def remote_fingerprint(info: dict[str, Any]) -> Fingerprint:
    """What an extractor told us about a remote source.

    A URL string that has not changed is *not* evidence that the video behind
    it has not changed, so the URL is deliberately not part of this.
    """
    headers = {str(k).lower(): v for k, v in (info.get("http_headers") or {}).items()}
    return Fingerprint(
        kind="remote",
        data={
            "extractor": info.get("extractor_key") or info.get("extractor"),
            "remote_id": info.get("id"),
            "duration": info.get("duration"),
            "content_length": info.get("filesize") or info.get("filesize_approx"),
            "etag": info.get("etag") or headers.get("etag"),
            "last_modified": info.get("last_modified") or headers.get("last-modified"),
        },
    )


# --- digests ----------------------------------------------------------------


def digest_file(path: Path) -> str:
    """``sha256`` of a file's bytes, read in 1 MiB chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def digest_copy(source: Path, destination: Path) -> str:
    """Copy ``source`` to ``destination``, returning the digest of the bytes.

    One pass over the file instead of two. Acquisition already has to move
    the media; hashing during that move is what keeps a 4 GB screen recording
    from being read twice.
    """
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, destination.open("wb") as dst:
        while chunk := src.read(_CHUNK):
            digest.update(chunk)
            dst.write(chunk)
    return digest.hexdigest()


def synthetic_digest(material: str) -> str:
    """A digest for content whose bytes we cannot hash (a live capture).

    Distinct per acquisition, so two captures of the same stream are two
    revisions — which is the truth. Marked in the revision's origin as
    ``digest_source: synthetic`` so nothing reports it as a content hash.
    """
    return hashlib.sha256(f"synthetic/{material}".encode()).hexdigest()


# --- symlink / traversal safety --------------------------------------------


def safe_resolve(source: str, *, allowed_roots: list[Path] | None = None) -> Path:
    """Resolve a local path, refusing escapes and non-regular files.

    ``allowed_roots`` confines the result — the verifier and REST surfaces pass
    one so a crafted ``../..`` or a symlink pointing outside the sandbox is a
    structured error rather than a read.
    """
    path = Path(source).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise IdentityError(
            f"cannot resolve path: {source}",
            code="identity.unresolvable_path",
            fix="check the path exists and is readable; quote paths with spaces",
            details={"source": source, "error": str(exc)},
        ) from exc

    if allowed_roots:
        roots = [root.resolve() for root in allowed_roots]
        if not any(resolved == root or root in resolved.parents for root in roots):
            raise IdentityError(
                f"path escapes the allowed roots: {resolved}",
                code="identity.path_escape",
                fix="pass a path inside the permitted directory",
                details={"resolved": str(resolved),
                         "allowed_roots": [str(r) for r in roots]},
            )

    mode = resolved.stat().st_mode
    if not stat.S_ISREG(mode):
        raise IdentityError(
            f"not a regular file: {resolved}",
            code="identity.not_a_regular_file",
            fix="point at a video file, not a directory, device, or socket",
            details={"resolved": str(resolved)},
        )
    return resolved


# --- revision records -------------------------------------------------------


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class Revision:
    """One immutable version of a video's content."""

    revision_id: str
    asset_id: str
    content_digest: str
    digest_algorithm: str = DIGEST_ALGORITHM
    fingerprint: Fingerprint | None = None
    origin: dict[str, Any] = field(default_factory=dict)
    acquired_at: str = field(default_factory=_now)

    @property
    def video_id(self) -> str:
        return video_id_for_digest(self.content_digest)

    def to_dict(self) -> dict[str, Any]:
        return {
            "revision_id": self.revision_id,
            "asset_id": self.asset_id,
            "content_digest": self.content_digest,
            "digest_algorithm": self.digest_algorithm,
            "fingerprint": self.fingerprint.to_dict() if self.fingerprint else None,
            "origin": self.origin,
            "acquired_at": self.acquired_at,
            "video_id": self.video_id,
        }


def make_revision(
    *,
    content_digest: str,
    asset_id: str | None = None,
    fingerprint: Fingerprint | None = None,
    origin: dict[str, Any] | None = None,
) -> Revision:
    """Build a revision record from a digest.

    ``asset_id`` defaults to the revision's own identity, which is right for
    content seen for the first time; the store re-parents it onto the alias's
    existing asset when the alias has a history.
    """
    revision_id = revision_id_for(content_digest)
    return Revision(
        revision_id=revision_id,
        asset_id=asset_id or _short("as_", content_digest),
        content_digest=content_digest,
        fingerprint=fingerprint,
        origin=origin or {},
    )


def freshness_for(
    *,
    observed: Fingerprint | None,
    stored: Fingerprint | None,
    policy: RevalidationPolicy,
    checked_at: str | None,
    ttl_seconds: float = DEFAULT_TTL_SECONDS,
) -> Freshness:
    """Decide what we can honestly say about a stored revision.

    Fails toward :attr:`Freshness.UNKNOWN`: when the check could not run, the
    answer says so rather than presenting old evidence as current.
    """
    if policy is RevalidationPolicy.IMMUTABLE:
        return Freshness.FRESH
    if policy is RevalidationPolicy.REFRESH:
        return Freshness.REFRESH_REQUIRED
    if policy is RevalidationPolicy.TTL and checked_at:
        try:
            age = (datetime.now(UTC) - datetime.fromisoformat(checked_at)).total_seconds()
        except ValueError:
            age = float("inf")
        if age <= ttl_seconds:
            return Freshness.FRESH
    if observed is None:
        return Freshness.UNKNOWN
    if stored is None:
        return Freshness.UNKNOWN
    if observed.matches(stored):
        return Freshness.FRESH if observed.significant else Freshness.UNKNOWN
    return Freshness.STALE


_LEGACY_ID_RE = re.compile(r"^[0-9a-f]{16}$")


def looks_like_video_id(value: str) -> bool:
    """Whether a string is shaped like a video id rather than a source.

    Both v1 and v2 ids are 16 lowercase hex chars, so one test covers them.
    """
    return bool(_LEGACY_ID_RE.match(value.strip()))
