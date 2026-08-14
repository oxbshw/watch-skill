"""The deterministic checks a contract can contain, and how each one runs.

Every check answers a question with a defined right answer, records what it
expected and what it observed, and reports :attr:`CheckStatus.INCONCLUSIVE`
when it could not look rather than assuming the best. Nothing here consults a
model, and nothing here builds a command, a query, or a URL out of content
that came from a video.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
import sqlite3
import subprocess
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from watch_skill.verify.contract import Check, CheckStatus

CHECK_RUNNER_VERSION = "1"


class CheckResult(BaseModel):
    """Everything one check did, in a form an auditor can re-read later."""

    check_id: str
    type: str
    required: bool
    status: CheckStatus
    expected: Any = None
    observed: Any = None
    summary: str = ""
    evidence_refs: list[str] = Field(default_factory=list)
    started_at: str = ""
    ended_at: str = ""
    duration_seconds: float = 0.0
    error: dict[str, Any] | None = None
    tool: dict[str, str] = Field(default_factory=dict)
    input_digest: str | None = None
    output_digest: str | None = None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _digest(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


class CheckContext(BaseModel):
    """Bounds a check may not step outside of."""

    working_dir: str
    allowed_roots: list[str] = Field(default_factory=list)
    allowed_origins: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] = Field(default_factory=dict)


# --- path safety ------------------------------------------------------------


def _resolve_within(raw: str, ctx: CheckContext) -> Path:
    """Resolve a path and refuse anything outside the permitted roots.

    ``resolve()`` follows symlinks before the comparison, so a link pointing
    out of the sandbox is caught by the same test as a literal ``../..``.
    """
    roots = [Path(r).resolve() for r in (ctx.allowed_roots or [ctx.working_dir])]
    candidate = (Path(ctx.working_dir) / raw).resolve() if not Path(raw).is_absolute() \
        else Path(raw).resolve()
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise PermissionError(
            f"{candidate} is outside the allowed roots "
            f"({', '.join(str(r) for r in roots)})"
        )
    return candidate


_PRIVATE_HOST_ERROR = (
    "refusing a request to a private, loopback, or link-local address: an "
    "allowlisted hostname that resolves inward is the classic SSRF shape"
)


def _assert_public_origin(url: str, ctx: CheckContext) -> str:
    """Origin allowlist plus a resolved-address check.

    The allowlist alone is not enough: a permitted hostname can resolve to
    169.254.169.254 or 127.0.0.1, so the resolved addresses are checked too.
    An explicitly allowlisted loopback origin is honoured, because a contract
    testing a local dev server is a legitimate and common case.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise PermissionError(f"only http(s) URLs may be checked, got {parts.scheme!r}")
    origin = f"{parts.scheme}://{parts.netloc}".lower()
    allowed = [o.lower().rstrip("/") for o in ctx.allowed_origins]
    if origin not in allowed:
        raise PermissionError(
            f"{origin} is not in the contract's allowed_origins ({allowed or 'none'})"
        )
    host = parts.hostname or ""
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))
    except OSError as exc:
        raise PermissionError(f"cannot resolve {host}: {exc}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_reserved) and origin not in allowed:
            raise PermissionError(_PRIVATE_HOST_ERROR)
    return origin


# --- individual checks ------------------------------------------------------


def _file_exists(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    path = _resolve_within(str(check.params["path"]), ctx)
    exists = path.is_file()
    want = bool(check.params.get("expected", True))
    return (
        CheckStatus.PASS if exists == want else CheckStatus.FAIL,
        f"file_exists={want}",
        f"file_exists={exists}",
        f"{path} {'exists' if exists else 'does not exist'}",
    )


def _file_digest(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    path = _resolve_within(str(check.params["path"]), ctx)
    if not path.is_file():
        return (CheckStatus.FAIL, check.params.get("sha256"), None,
                f"{path} does not exist, so it cannot match a digest")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    actual = digest.hexdigest()
    expected = str(check.params["sha256"]).lower().removeprefix("sha256:")
    return (
        CheckStatus.PASS if actual == expected else CheckStatus.FAIL,
        f"sha256:{expected}", f"sha256:{actual}",
        "digest matches" if actual == expected else "digest differs",
    )


def _json_pointer(document: Any, pointer: str) -> Any:
    """RFC 6901 JSON Pointer resolution.

    A real pointer implementation rather than an expression evaluator: there is
    no syntax here that could execute anything, which matters because the
    document may have been produced by the agent under test.
    """
    if pointer in ("", "/"):
        return document
    if not pointer.startswith("/"):
        raise ValueError(f"JSON Pointer must start with '/', got {pointer!r}")
    current = document
    for raw in pointer.lstrip("/").split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            current = current[int(token)]
        elif isinstance(current, dict):
            current = current[token]
        else:
            raise KeyError(f"cannot descend into {type(current).__name__} at {token!r}")
    return current


def _json_value(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    path = _resolve_within(str(check.params["path"]), ctx)
    # utf-8-sig, not utf-8: the file under test was written by whatever the
    # agent used, and plenty of Windows tooling emits a BOM. Decoding a
    # BOM-less file with utf-8-sig is identical, so this only ever helps.
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    pointer = str(check.params.get("pointer", ""))
    try:
        actual = _json_pointer(document, pointer)
    except (KeyError, IndexError, ValueError) as exc:
        return (CheckStatus.FAIL, check.params.get("equals"), None,
                f"{pointer} not present: {exc}")
    expected = check.params.get("equals")
    return (
        CheckStatus.PASS if actual == expected else CheckStatus.FAIL,
        expected, actual, f"{pointer} = {actual!r}",
    )


def _json_schema(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    try:
        import jsonschema  # noqa: PLC0415
    except ImportError:
        return (CheckStatus.INCONCLUSIVE, "schema valid", None,
                "jsonschema is not installed, so the document was not validated")
    path = _resolve_within(str(check.params["path"]), ctx)
    # utf-8-sig, not utf-8: the file under test was written by whatever the
    # agent used, and plenty of Windows tooling emits a BOM. Decoding a
    # BOM-less file with utf-8-sig is identical, so this only ever helps.
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    try:
        jsonschema.validate(document, check.params["schema"])
    except jsonschema.ValidationError as exc:
        return (CheckStatus.FAIL, "schema valid", exc.message,
                f"schema violation at {list(exc.absolute_path)}: {exc.message}")
    return (CheckStatus.PASS, "schema valid", "schema valid", "document matches schema")


_WRITE_KEYWORDS = (
    "insert", "update", "delete", "drop", "alter", "create", "replace",
    "attach", "detach", "pragma", "vacuum", "reindex", "begin", "commit",
)


def _sqlite_query(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    sql = str(check.params["sql"]).strip().rstrip(";")
    lowered = sql.lower()
    if not lowered.startswith("select") and not lowered.startswith("with"):
        raise ValueError("only SELECT (or WITH ... SELECT) queries may be verified")
    if ";" in sql:
        raise ValueError("a verification query must be a single statement")
    if any(f" {word} " in f" {lowered} " for word in _WRITE_KEYWORDS):
        raise ValueError(f"query contains a write keyword: {sql[:80]!r}")

    path = _resolve_within(str(check.params["database"]), ctx)
    # Read-only at the driver level, not by convention: even a query that
    # slipped past the keyword screen cannot write through this handle.
    uri = f"file:{path.as_uri()[8:]}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10.0)
    try:
        conn.row_factory = sqlite3.Row
        params = check.params.get("parameters") or []
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    actual = [dict(row) for row in rows]
    expected = check.params.get("equals")
    if expected is None and "row_count" in check.params:
        expected = {"row_count": check.params["row_count"]}
        observed = {"row_count": len(actual)}
        return (
            CheckStatus.PASS if observed == expected else CheckStatus.FAIL,
            expected, observed, f"{len(actual)} row(s)",
        )
    return (
        CheckStatus.PASS if actual == expected else CheckStatus.FAIL,
        expected, actual, f"{len(actual)} row(s) returned",
    )


def _http_request(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    import httpx  # noqa: PLC0415

    from watch_skill.policy import Channel, get_policy  # noqa: PLC0415

    url = str(check.params["url"])
    if not get_policy().check(Channel.VERIFICATION_HTTP).allowed:
        return (CheckStatus.INCONCLUSIVE, check.params.get("status"), None,
                "offline policy forbade the request, so nothing was checked")
    _assert_public_origin(url, ctx)
    method = str(check.params.get("method", "GET")).upper()
    if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
        raise ValueError(f"unsupported HTTP method {method!r}")
    response = httpx.request(
        method, url,
        headers=check.params.get("headers") or None,
        json=check.params.get("json_body"),
        timeout=check.timeout_seconds,
        follow_redirects=False,  # a redirect off the allowlist is an escape
    )
    expected: dict[str, Any] = {}
    observed: dict[str, Any] = {}
    if "status" in check.params:
        expected["status"] = check.params["status"]
        observed["status"] = response.status_code
    for name, value in (check.params.get("headers_contain") or {}).items():
        expected.setdefault("headers", {})[name] = value
        observed.setdefault("headers", {})[name] = response.headers.get(name)
    if "body_contains" in check.params:
        expected["body_contains"] = check.params["body_contains"]
        observed["body_contains"] = check.params["body_contains"] in response.text
        expected["body_contains"] = True
    return (
        CheckStatus.PASS if expected == observed else CheckStatus.FAIL,
        expected, observed, f"HTTP {response.status_code}",
    )


def _command_exit(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    command = check.params["command"]
    if not isinstance(command, list) or not command:
        raise ValueError("command must be a non-empty list of arguments")
    cwd = _resolve_within(str(check.params.get("cwd", ".")), ctx)
    expected_code = int(check.params.get("exit_code", 0))
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False, bounded cwd
            command,
            cwd=cwd,
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=check.timeout_seconds,
            env=_sanitized_env(),
        )
    except FileNotFoundError as exc:
        return (CheckStatus.ERROR, f"exit {expected_code}", None,
                f"command not found: {command[0]} ({exc})")
    except subprocess.TimeoutExpired:
        return (CheckStatus.INCONCLUSIVE, f"exit {expected_code}", None,
                f"command exceeded its {check.timeout_seconds:.0f}s timeout")
    return (
        CheckStatus.PASS if completed.returncode == expected_code else CheckStatus.FAIL,
        f"exit {expected_code}", f"exit {completed.returncode}",
        (completed.stdout or completed.stderr or "")[-600:],
    )


def _numeric_invariant(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    value = float(check.params["value"])
    lo = check.params.get("min")
    hi = check.params.get("max")
    equals = check.params.get("equals")
    tolerance = float(check.params.get("tolerance", 0.0))
    ok = True
    if lo is not None:
        ok = ok and value >= float(lo)
    if hi is not None:
        ok = ok and value <= float(hi)
    if equals is not None:
        ok = ok and abs(value - float(equals)) <= tolerance
    expected = {k: check.params.get(k) for k in ("min", "max", "equals") if k in check.params}
    return (
        CheckStatus.PASS if ok else CheckStatus.FAIL,
        expected, value, f"value = {value}",
    )


def _visual_absent(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """A banned term must not appear in the OCR evidence.

    Deterministic only because OCR text is an artifact with a digest, not a
    model's opinion. With no OCR evidence at all this is INCONCLUSIVE — an
    empty haystack is not proof the needle is absent.
    """
    ocr_lines = ctx.evidence.get("ocr_text") or []
    if not ocr_lines:
        return (CheckStatus.INCONCLUSIVE, f"absent: {check.params['term']}", None,
                "no OCR evidence was collected, so absence cannot be established")
    term = str(check.params["term"]).lower()
    hits = [line for line in ocr_lines if term in str(line).lower()]
    return (
        CheckStatus.FAIL if hits else CheckStatus.PASS,
        f"absent: {term}", f"{len(hits)} occurrence(s)",
        hits[0][:200] if hits else f"{term!r} not present in {len(ocr_lines)} OCR lines",
    )


_RUNNERS: dict[str, Callable[[Check, CheckContext], tuple[CheckStatus, Any, Any, str]]] = {
    "file_exists": _file_exists,
    "file_digest": _file_digest,
    "json_value": _json_value,
    "json_schema": _json_schema,
    "sqlite_query": _sqlite_query,
    "http_request": _http_request,
    "command_exit": _command_exit,
    "numeric_invariant": _numeric_invariant,
    "visual_absent": _visual_absent,
}

SUPPORTED_CHECK_TYPES = tuple(sorted(_RUNNERS))


def _sanitized_env() -> dict[str, str]:
    """The environment a spawned check gets: the minimum, and no secrets.

    Built by allowlist. A denylist would leak every provider key added after
    it was written, and those are exactly what must not reach a subprocess
    running code the agent under test produced.
    """
    import os  # noqa: PLC0415

    keep = ("PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
            "HOME", "LANG", "LC_ALL", "PATHEXT", "NUMBER_OF_PROCESSORS")
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env["WATCH_SKILL_VERIFIER"] = "1"
    return env


def run_check(check: Check, ctx: CheckContext) -> CheckResult:
    """Run one check, recording everything about it. Never raises."""
    started = time.monotonic()
    result = CheckResult(
        check_id=check.id, type=check.type, required=check.required,
        status=CheckStatus.ERROR, started_at=_now(),
        tool={"runner": "watch-skill", "version": CHECK_RUNNER_VERSION},
        input_digest=_digest({"type": check.type, "params": check.params}),
    )
    runner = _RUNNERS.get(check.type)
    if runner is None:
        result.status = CheckStatus.ERROR
        result.summary = f"unsupported check type {check.type!r}"
        result.error = {"code": "verify.unsupported_check",
                        "supported": list(SUPPORTED_CHECK_TYPES)}
    else:
        try:
            status, expected, observed, summary = runner(check, ctx)
            result.status, result.expected = status, expected
            result.observed, result.summary = observed, summary
        except PermissionError as exc:
            result.status = CheckStatus.ERROR
            result.summary = str(exc)
            result.error = {"code": "verify.check_refused", "message": str(exc)}
        except (KeyError, ValueError, TypeError) as exc:
            result.status = CheckStatus.ERROR
            result.summary = f"malformed check: {exc}"
            result.error = {"code": "verify.check_malformed", "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - an unknown failure is not a pass
            result.status = CheckStatus.ERROR
            result.summary = f"{type(exc).__name__}: {exc}"
            result.error = {"code": "verify.check_crashed", "message": str(exc)}

    result.ended_at = _now()
    result.duration_seconds = round(time.monotonic() - started, 4)
    result.output_digest = _digest(
        {"status": result.status.value, "observed": result.observed}
    )
    return result
