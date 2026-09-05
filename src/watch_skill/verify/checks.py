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
import re
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


def _shown(path: Path, ctx: CheckContext) -> str:
    """A path as a *record* may carry it: relative to the working directory.

    A check summary is not a debug line. It crosses the Bridge, is indexed into
    the Library, is rendered in a browser, is exported, and is read back into
    model context — and it used to carry the resolved absolute path, so a
    verification that passed announced the operating system user's name and the
    shape of somebody's disk to every one of those places.

    The contract asked about ``owner-test/totals.json``; that is what the answer
    should say. Forward slashes, because the record is read on machines that did
    not write it. A path that somehow lands outside the working directory is
    named ``<path>`` rather than printed, since there is no relative spelling
    for it and the absolute one is the thing being avoided.
    """
    try:
        return path.resolve().relative_to(Path(ctx.working_dir).resolve()).as_posix()
    except ValueError:
        return "<path>"


def _redact_paths(text: str, ctx: CheckContext) -> str:
    """Rewrite absolute paths out of a diagnostic a check produced.

    The safety net behind :func:`_shown`. Check bodies build their own summaries
    and can be careful; the messages that arrive from the operating system
    cannot — ``FileNotFoundError`` quotes the full path it was given, and that
    string became a summary verbatim.

    Bounded on purpose, in the same spirit as the Host's own redaction: the
    working directory is replaced by its relative remainder, and any other
    absolute local path is replaced whole. Nothing else in the string is
    touched, because a summary also carries digests, pointers and values that a
    blanket rewrite would corrupt.
    """
    if not text:
        return text
    root = str(Path(ctx.working_dir).resolve())
    out = text
    for spelling in {root, root.replace("\\", "/")}:
        # The remainder keeps its own separators normalised, so one file reads
        # the same however the message that named it was built.
        pattern = re.escape(spelling) + r"[\\/]?([^\s\"'`,;)\]]*)"
        out = re.sub(
            pattern,
            lambda m: (m.group(1) or ".").replace("\\", "/"),
            out,
        )
    # Anything still absolute belongs to no root this check may speak about.
    out = re.sub(r"(?<![A-Za-z:])[A-Za-z]:[\\/][^\s\"'`,;)\]]*", "<path>", out)
    out = re.sub(r"(?<![\w:])/(?:home|Users|var|tmp|root|mnt|opt)/[^\s\"'`,;)\]]*",
                 "<path>", out)
    return out


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
        f"{_shown(path, ctx)} {'exists' if exists else 'does not exist'}",
    )


def _file_digest(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    path = _resolve_within(str(check.params["path"]), ctx)
    if not path.is_file():
        return (CheckStatus.FAIL, check.params.get("sha256"), None,
                f"{_shown(path, ctx)} does not exist, so it cannot match a digest")
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


def read_only_sqlite_uri(path: Path) -> str:
    """A `mode=ro` SQLite URI for ``path``.

    Read-only at the driver level rather than by convention: a query that slips
    past the keyword screen still cannot write through this handle.

    The whole URI is kept rather than sliced. Trimming a fixed `file:///`
    prefix leaves the drive letter intact on Windows but eats the leading
    slash on POSIX, turning `/tmp/app.db` into the relative `tmp/app.db` --
    which opened nothing, so every `sqlite_query` check errored on Linux and
    macOS while passing on Windows.
    """
    return f"{path.as_uri()}?mode=ro"


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
    uri = read_only_sqlite_uri(path)
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


def _directory_manifest(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """A directory contains exactly the files it is supposed to.

    Two failures are distinguished because they mean different things: a
    missing file is work that did not happen, an unexpected file is work that
    happened and nobody described. ``exact`` decides whether the second one
    counts against the verdict.
    """
    root = _resolve_within(str(check.params["path"]), ctx)
    if not root.is_dir():
        return (CheckStatus.FAIL, str(check.params.get("expected_files", [])),
                None, f"{root} is not a directory")
    expected = sorted(str(name) for name in check.params.get("expected_files", []))
    found = sorted(
        p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()
    )
    missing = [name for name in expected if name not in found]
    unexpected = [name for name in found if name not in expected]
    exact = bool(check.params.get("exact", False))
    ok = not missing and (not unexpected or not exact)
    summary = f"{len(found)} file(s)"
    if missing:
        summary += f"; missing {missing[:5]}"
    if unexpected and exact:
        summary += f"; unexpected {unexpected[:5]}"
    return (CheckStatus.PASS if ok else CheckStatus.FAIL,
            {"expected_files": expected, "exact": exact},
            {"found": found[:200], "missing": missing, "unexpected": unexpected},
            summary)


_DOM_MODES = ("exists", "absent", "text", "attribute", "value", "visible", "enabled")


def _browser_dom(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """Read one fact out of a live page, in this verifier's own browser.

    This is the oracle that makes "the agent fixed the UI" checkable rather
    than asserted. Three properties make it independent of the agent that did
    the work:

    * it opens its **own** browser, in the verifier process, against the URL
      named in the frozen contract — not the agent's session, whose state the
      agent controls;
    * it is **read-only**. There is no click, no fill, no evaluate. The only
      operations are locate-and-read, so verification cannot become the thing
      that makes the postcondition true;
    * the same origin allowlist and address checks as every other network
      check apply, so a contract cannot be used as an SSRF primitive.
    """
    url = str(check.params["url"])
    _assert_public_origin(url, ctx)
    selector = str(check.params["selector"])
    mode = str(check.params.get("mode", "exists"))
    if mode not in _DOM_MODES:
        raise ValueError(f"mode must be one of {_DOM_MODES}, got {mode!r}")
    expected = check.params.get("expected")
    match = str(check.params.get("match", "exact"))
    timeout_ms = int(check.params.get("timeout_ms", 10_000))

    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        return (CheckStatus.INCONCLUSIVE, expected, None,
                "playwright is not installed, so a DOM postcondition cannot be "
                "evaluated; install watch-skill[loop] and `playwright install "
                "chromium`")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--disable-background-networking", "--no-first-run",
            "--disable-component-update", "--disable-sync",
        ])
        try:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            locator = page.locator(selector).first
            if mode == "absent":
                count = page.locator(selector).count()
                return (CheckStatus.PASS if count == 0 else CheckStatus.FAIL,
                        f"absent: {selector}", f"{count} match(es)",
                        f"{selector!r} matched {count} element(s)")
            try:
                locator.wait_for(state="attached", timeout=timeout_ms)
            except Exception:  # noqa: BLE001 - a missing element is a FAIL, not an error
                return (CheckStatus.FAIL, expected, None,
                        f"{selector!r} never appeared within {timeout_ms} ms")
            observed = _read_dom(locator, mode, check)
        finally:
            browser.close()

    if mode in ("exists", "visible", "enabled"):
        want = bool(expected) if expected is not None else True
        return (CheckStatus.PASS if bool(observed) is want else CheckStatus.FAIL,
                want, observed, f"{selector} {mode} = {observed}")
    ok = _text_matches(str(observed), expected, match)
    return (CheckStatus.PASS if ok else CheckStatus.FAIL, expected, observed,
            f"{selector} {mode} = {str(observed)[:200]!r}")


def _read_dom(locator: Any, mode: str, check: Check) -> Any:
    if mode == "exists":
        return True
    if mode == "visible":
        return locator.is_visible()
    if mode == "enabled":
        return locator.is_enabled()
    if mode == "attribute":
        return locator.get_attribute(str(check.params["attribute"]))
    if mode == "value":
        return locator.input_value()
    return (locator.text_content() or "").strip()


def _text_matches(observed: str, expected: Any, match: str) -> bool:
    if expected is None:
        return bool(observed)
    want = str(expected)
    if match == "contains":
        return want.lower() in observed.lower()
    if match == "regex":
        return re.search(want, observed) is not None
    return observed == want


def _live_console(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """Assert about browser errors recorded in a live session's event log.

    Reads the persisted log rather than the running session, so the answer is
    the same from any process and cannot be changed by whatever is still
    executing. With no browser evidence at all the verdict is INCONCLUSIVE:
    an empty log is not proof a page threw nothing, it is proof nobody looked.
    """
    from watch_skill.live import db  # noqa: PLC0415

    session_id = str(check.params["session_id"])
    events = db.read_events(session_id, limit=500)
    browser_events = [e for e in events if e.detector.startswith("browser:")]
    if not browser_events:
        return (CheckStatus.INCONCLUSIVE, check.params.get("expect", "no_errors"),
                None, f"no browser evidence was recorded for {session_id}")

    errors = [
        e for e in browser_events
        if e.detector in ("browser:page_error", "browser:request_failed",
                          "browser:target_crashed")
        or (e.detector == "browser:console"
            and (e.detail.get("browser", {}).get("detail", {}).get("level")
                 == "error"))
    ]
    since = check.params.get("since_media_ts")
    if since is not None:
        errors = [e for e in errors if e.media_ts >= float(since)]

    expect = str(check.params.get("expect", "none"))
    texts = [e.summary[:200] for e in errors[:10]]
    if expect == "none":
        return (CheckStatus.PASS if not errors else CheckStatus.FAIL,
                "no browser errors", f"{len(errors)} error(s)",
                texts[0] if texts else "no browser errors were recorded")
    pattern = str(check.params.get("pattern", ""))
    hits = [t for t in texts if re.search(pattern, t)] if pattern else texts
    return (CheckStatus.PASS if hits else CheckStatus.FAIL,
            f"an error matching {pattern!r}", f"{len(errors)} error(s)",
            hits[0] if hits else f"no recorded error matched {pattern!r}")


def _live_evidence(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """A named clip or frame exists and still hashes to what it did.

    Evidence that cannot be re-hashed is evidence nobody can rely on later, so
    the artifact is read off disk and digested here rather than trusting the
    row that describes it.
    """
    from watch_skill.live import buffer as buf  # noqa: PLC0415

    session_id = str(check.params["session_id"])
    artifact_id = str(check.params["artifact_id"])
    segment = buf.resolve(session_id, artifact_id)
    if segment is None:
        return (CheckStatus.FAIL, artifact_id, None,
                f"no artifact {artifact_id!r} in session {session_id}")
    if segment.expired or not segment.path.is_file():
        return (CheckStatus.FAIL, artifact_id, "expired",
                f"{artifact_id} has aged out of the rolling buffer")
    from watch_skill.verify.evidence import digest_file  # noqa: PLC0415

    actual = digest_file(segment.path)
    wanted = check.params.get("digest")
    if wanted is None:
        return (CheckStatus.PASS, artifact_id, actual,
                f"{artifact_id} present, {segment.path.stat().st_size} bytes")
    return (CheckStatus.PASS if actual == wanted else CheckStatus.FAIL,
            wanted, actual,
            "digest matches" if actual == wanted else "digest does NOT match")


def _human_approval(check: Check, ctx: CheckContext) -> tuple[CheckStatus, Any, Any, str]:
    """A named side effect was explicitly approved by a human.

    The approval is read from the durable approval store, which the acting
    agent has no write path into. An agent that could satisfy this by
    asserting it had been approved would make every other control decorative,
    so nothing in the evidence dict is consulted — only the store.
    """
    from watch_skill.actions.approvals import approval_state  # noqa: PLC0415

    approval_id = str(check.params["approval_id"])
    state = approval_state(approval_id)
    if state is None:
        return (CheckStatus.FAIL, f"approved: {approval_id}", None,
                f"no approval record exists for {approval_id!r}")
    if state["status"] != "approved":
        return (CheckStatus.FAIL, f"approved: {approval_id}", state["status"],
                f"{approval_id} is {state['status']}")
    if state.get("expired"):
        return (CheckStatus.FAIL, f"approved: {approval_id}", "expired",
                f"the approval for {approval_id} expired before it was used")
    return (CheckStatus.PASS, f"approved: {approval_id}", state["status"],
            f"approved by {state.get('actor', 'unknown')} "
            f"at {state.get('decided_at', 'unknown')}")


_RUNNERS: dict[str, Callable[[Check, CheckContext], tuple[CheckStatus, Any, Any, str]]] = {
    "file_exists": _file_exists,
    "file_digest": _file_digest,
    "directory_manifest": _directory_manifest,
    "json_value": _json_value,
    "json_schema": _json_schema,
    "sqlite_query": _sqlite_query,
    "http_request": _http_request,
    "command_exit": _command_exit,
    "numeric_invariant": _numeric_invariant,
    "visual_absent": _visual_absent,
    "browser_dom": _browser_dom,
    "live_console": _live_console,
    "live_evidence": _live_evidence,
    "human_approval": _human_approval,
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
            "LANG", "LC_ALL", "PATHEXT", "NUMBER_OF_PROCESSORS",
            # A home directory, under whichever name this platform uses.
            # Windows sets USERPROFILE and not HOME, and without one httpx
            # raises "Could not determine home directory" while looking for a
            # .netrc — which turned every isolated http_request check on
            # Windows into an ERROR, and therefore every contract containing
            # one into `inconclusive`.
            "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH")
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

    # One place, after every branch above. A summary or error message that
    # reaches here carrying an absolute path would be indexed, exported and
    # rendered with it, and the branches that build those messages include the
    # ones where the operating system wrote them.
    result.summary = _redact_paths(result.summary or "", ctx)
    if result.error is not None and isinstance(result.error.get("message"), str):
        result.error["message"] = _redact_paths(result.error["message"], ctx)

    result.ended_at = _now()
    result.duration_seconds = round(time.monotonic() - started, 4)
    result.output_digest = _digest(
        {"status": result.status.value, "observed": result.observed}
    )
    return result
