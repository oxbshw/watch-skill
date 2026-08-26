"""Redaction for anything this benchmark writes down.

The raw results are meant to be sent to the vendor being measured, which
makes every file this benchmark writes an outbound document. Sanitization
therefore happens on the way *in* — at the moment a value is recorded — not
as a pass over the finished file, because a pass over the finished file only
removes what somebody remembered to look for.

What goes: bearer tokens and API keys, the home directory and anything under
it, the machine and account name, e-mail addresses, credentials embedded in
URLs, and the absolute paths of scratch directories. What stays: the shape of
everything, so a redacted record is still a record — a path becomes
``<home>/.adversal/jobs.json``, not ``[redacted]``.

Job and request identifiers are deliberately **not** redacted. They are the
correlation handle the vendor needs to look a run up on their side, they are
not secret, and stripping them would make the report unactionable.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

# Substituted before the pattern rules, longest first, so a nested path
# (scratch inside home) is replaced by the most specific placeholder.
_LITERAL_PLACEHOLDERS: list[tuple[str, str]] = []

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Bearer tokens and Authorization headers, whatever the scheme.
    (re.compile(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 <redacted>"),
    # key=value / "key": "value" for anything that names itself a secret.
    # `login_code` is here because a real run put one in front of us: the
    # sign-in flow prints a confirmation URL carrying a single-use code, and
    # the first version of this list did not cover it. One-time codes expire,
    # but a benchmark result is a document that gets forwarded.
    (re.compile(
        r"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|"
        r"authorization|auth|credential|session|login[_-]?code|otp)\b(\s*[:=]\s*)"
        r"[\"']?[A-Za-z0-9._~+/=-]{6,}[\"']?"
    ), r"\1\2<redacted>"),
    # Credentials inside a URL.
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://<redacted>@"),
    # JWTs anywhere, even unlabelled.
    (re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b"),
     "<redacted-jwt>"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "<redacted-email>"),
]


def _home() -> str:
    return str(Path.home())


def build_placeholders(extra: dict[str, str] | None = None) -> list[tuple[str, str]]:
    """Literal strings to mask, longest first so the specific one wins."""
    pairs: list[tuple[str, str]] = list(_LITERAL_PLACEHOLDERS)
    for value, placeholder in (extra or {}).items():
        if value:
            pairs.append((value, placeholder))
    home = _home()
    pairs.append((home, "<home>"))
    # The account name leaks through paths this benchmark never touches, so
    # mask it on its own too.
    user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    if user and len(user) > 2:
        pairs.append((user, "<user>"))
    hostname = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or ""
    if hostname and len(hostname) > 2:
        pairs.append((hostname, "<host>"))
    return sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)


def sanitize_text(text: str, placeholders: list[tuple[str, str]] | None = None) -> str:
    """Redact one string. Idempotent, so re-sanitizing is always safe."""
    if not text:
        return text
    out = text
    for literal, placeholder in placeholders if placeholders is not None else build_placeholders():
        if not literal:
            continue
        out = out.replace(literal, placeholder)
        # Windows hands back both separators for the same directory.
        if "\\" in literal:
            out = out.replace(literal.replace("\\", "/"), placeholder)
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def sanitize(value: Any, placeholders: list[tuple[str, str]] | None = None) -> Any:
    """Walk any JSON-shaped value, redacting every string inside it.

    Dictionary *keys* are sanitized too: a path used as a key is still a path.
    """
    active = placeholders if placeholders is not None else build_placeholders()
    if isinstance(value, str):
        return sanitize_text(value, active)
    if isinstance(value, dict):
        return {
            sanitize_text(str(k), active): sanitize(v, active) for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize(v, active) for v in value]
    if isinstance(value, tuple):
        return [sanitize(v, active) for v in value]
    if isinstance(value, Path):
        return sanitize_text(str(value), active)
    return value


def environment_summary() -> dict[str, str]:
    """A non-identifying description of the machine a run happened on.

    The family and release, never the exact build: "Windows 10" lets a reader
    judge whether their own numbers should look similar, while
    "Windows-10-10.0.19045-SP0" is a fingerprint that belongs in no committed
    result. Matches what the perception and provider benches record.
    """
    import platform

    return {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
