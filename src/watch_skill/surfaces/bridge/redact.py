"""Keeping this machine out of what crosses the Bridge.

Two things must never leave Core through a frame or a log line: a credential,
and a path that names the person running it. Both arrive here the same way —
not because anyone serialized them deliberately, but because an exception
message carried one and the error path carried the exception message.

The rule this module keeps is **structured, never blanket**. It rewrites
*named fields* in a payload Core is about to emit, and it does not scrub free
text: a transcript, an OCR read, or a user's own question may legitimately
contain something that looks like a path, and rewriting those would corrupt
the very record the product exists to preserve. There is no function here that
takes a document and scrubs it.

The mirror of this on the Host side is
``@deepwatch/dsh-contracts/paths``, which does the same job for what the
browser renders.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

#: Field names whose *value* is a secret, whatever it looks like.
#:
#: Matched case-insensitively against the whole key, after stripping
#: separators, so ``api_key``, ``apiKey`` and ``APIKEY`` are one entry.
_SECRET_KEYS = frozenset(
    {
        "apikey",
        "authorization",
        "credential",
        "credentials",
        "key",
        "password",
        "passwd",
        "privatekey",
        "secret",
        "sessiontoken",
        "token",
    }
)

#: Environment variables whose presence may be reported, never their value.
_SECRET_ENV_SUFFIXES = ("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIAL")

_REDACTED = "[redacted]"

# A Windows drive path, a UNC share, or a POSIX absolute path. Anchored so a
# URL scheme is not mistaken for a drive letter: `https://x` has a colon and a
# slash in the same places as `C:/x`, and only the single-character drive
# rules it out.
_ABSOLUTE = re.compile(
    r"""(?:
        (?<![A-Za-z0-9])[A-Za-z]:[\\/]        # C:\ or C:/ but not https:/
      | \\\\[^\\/\s]+[\\/][^\\/\s]+           # \\server\share
      | /(?:home|Users|root|tmp|var|opt)/     # rooted POSIX paths worth hiding
    )[^\s"']*""",
    re.VERBOSE,
)


def _normalise_key(key: str) -> str:
    return re.sub(r"[^a-z]", "", key.lower())


def is_secret_key(key: str) -> bool:
    """Whether a field name declares its value to be a credential."""
    normalised = _normalise_key(key)
    if normalised in _SECRET_KEYS:
        return True
    upper = key.upper()
    return any(upper.endswith(suffix) for suffix in _SECRET_ENV_SUFFIXES)


def _roots() -> list[tuple[str, str]]:
    """Real roots worth naming, longest first so the most specific wins.

    Longest-first is not cosmetic: a profile inside a home directory would
    otherwise render as ``<home>/...`` and lose the fact that it is the
    profile, which is the one thing a reader of a diagnostic wants to know.
    """
    candidates: list[tuple[str, str | None]] = [
        ("workspace", os.environ.get("WATCH_WORKSPACE")),
        ("profile", os.environ.get("DEEPWATCH_HOME")),
        ("dsh-home", os.environ.get("DSH_HOME")),
        ("watch-home", os.environ.get("WATCH_SKILL_HOME")),
        ("temp", os.environ.get("TMPDIR") or os.environ.get("TEMP")),
        ("home", str(Path.home())),
    ]
    roots = [
        (label, str(Path(value).resolve()))
        for label, value in candidates
        if value not in (None, "")
    ]
    return sorted(roots, key=lambda pair: len(pair[1]), reverse=True)


def _same_root(candidate: str, root: str) -> bool:
    """Prefix match with a boundary check and Windows case folding.

    Without the boundary check ``D:\\Wsuite`` looks like it is inside
    ``D:\\Ws``; without the case folding ``d:\\`` and ``D:\\`` look like two
    directories. Both have been real defects.
    """
    left = candidate.replace("\\", "/")
    right = root.replace("\\", "/").rstrip("/")
    if os.name == "nt":
        left, right = left.lower(), right.lower()
    return left == right or left.startswith(right + "/")


def logical_path(value: str) -> str:
    """Rewrite one absolute path as ``<root>/relative``, or hide it entirely.

    A path under a known root keeps its useful half — which file, relative to
    what — and loses the half that names the machine. A path under no known
    root is replaced wholesale, because there is nothing left to say about it
    that is safe.
    """

    def replace(match: re.Match[str]) -> str:
        raw = match.group(0)
        # A token this platform does not consider absolute cannot name a file
        # on this machine, so there is no root it could be under and nothing
        # worth keeping from it.
        #
        # Skipping this check leaked a username. On Linux, `C:\Users\someone`
        # is a *relative* path, so `resolve()` anchored it to the working
        # directory — and the result then matched the `<home>` root, whose
        # prefix was stripped while `someone/notes.txt` survived in the tail.
        # A Windows path in a message read on a POSIX host is exactly the
        # cross-platform case a Bridge sees, and it produced the one output
        # this function exists to prevent.
        if not os.path.isabs(raw):
            return "<path>"
        try:
            resolved = str(Path(raw).resolve())
        except (OSError, ValueError):
            resolved = raw
        for label, root in _roots():
            if _same_root(resolved, root):
                tail = resolved.replace("\\", "/")[len(root.replace("\\", "/")) :]
                return f"<{label}>{tail.rstrip('/') or ''}"
        return "<path>"

    return _ABSOLUTE.sub(replace, value)


def scrub(value: Any, *, _depth: int = 0) -> Any:
    """Redact secret-named fields and rewrite absolute paths in a payload.

    Recurses through dicts and lists only. Strings are rewritten for paths;
    a string under a secret-named key is replaced entirely, because the shape
    of a credential is not a reliable way to recognise one.

    Args:
        value: the structure Core is about to emit.

    Returns:
        A new structure safe to frame or log.
    """
    if _depth > 12:
        # Deeper than any contract goes. A cycle or a hostile payload gets a
        # marker rather than a recursion error taking the connection down.
        return "[truncated]"
    if isinstance(value, dict):
        scrubbed: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            scrubbed[name] = (
                _REDACTED if is_secret_key(name) else scrub(item, _depth=_depth + 1)
            )
        return scrubbed
    if isinstance(value, (list, tuple)):
        return [scrub(item, _depth=_depth + 1) for item in value]
    if isinstance(value, str):
        return logical_path(value)
    return value


def safe_message(text: str, *, limit: int = 600) -> str:
    """A message safe to frame: paths rewritten, length bounded.

    The bound is the quiet half. An exception message can carry a whole
    subprocess transcript, and an unbounded one turns a structured error into
    an unreadable wall that also happens to be the largest thing on the wire.
    """
    cleaned = logical_path(text).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1] + "\u2026"


__all__ = ["is_secret_key", "logical_path", "safe_message", "scrub"]
