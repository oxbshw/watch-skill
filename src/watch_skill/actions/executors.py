"""What an approved action is actually allowed to do.

Executors are looked up by ``kind`` from a closed registry. There is no
"run this command" executor and there will not be one: a command assembled
from a string is a command that OCR text, a transcript, or a webpage can
rewrite, and an approved action whose payload can be rewritten is not an
approved action.

Every executor here:

* is reached only through :func:`execute`, which requires a spent approval;
* is checked against the execution policy *and* the same address rules that
  guard every other outbound request;
* returns a structured result, and raises rather than half-succeeding.
"""
from __future__ import annotations

import ipaddress
import json
import socket
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from watch_skill.errors import WatchSkillError
from watch_skill.policy import Channel, guard_egress

MAX_RESPONSE_BYTES = 64 * 1024
"""Enough to record what an endpoint said, bounded so a hostile or broken
server cannot make a correction consume the machine."""


class ExecutionError(WatchSkillError):
    """An approved action could not be carried out."""

    default_code = "actions.execution_failed"


Executor = Callable[[dict[str, Any]], dict[str, Any]]
_REGISTRY: dict[str, Executor] = {}


def register(kind: str, executor: Executor) -> None:
    """Add an executor. Re-registering a kind is refused.

    Silent replacement would let a plugin swap the meaning of an action kind
    that operators have already approved by name.
    """
    if kind in _REGISTRY:
        raise ExecutionError(
            f"an executor for {kind!r} is already registered",
            code="actions.executor_conflict",
            fix="pick a distinct kind; an action kind is part of what an "
                "operator approves, so it may not be redefined underneath them",
        )
    _REGISTRY[kind] = executor


def registered_kinds() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY))


def _assert_reachable(url: str, allowed_origins: list[str]) -> str:
    """The same address discipline the verifier uses, applied to side effects.

    An action's target is more dangerous than a verification target, not less:
    this one writes. So the origin must be explicitly allowlisted *and* the
    resolved addresses are checked, which is what stops an allowlisted name
    that answers with a link-local address.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ExecutionError(
            f"only http(s) actions are supported, got {parts.scheme!r}",
            code="actions.scheme_refused",
            fix="use an http or https URL",
        )
    origin = f"{parts.scheme}://{parts.netloc}".lower()
    allowed = [o.lower().rstrip("/") for o in allowed_origins]
    if origin not in allowed:
        raise ExecutionError(
            f"{origin} is not in this action's allowed_origins",
            code="actions.origin_refused",
            fix="add the origin to the action's allowed_origins — an action "
                "may only reach a destination named before it was approved",
            details={"origin": origin, "allowed": allowed},
        )
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port)
    except OSError as exc:
        raise ExecutionError(
            f"cannot resolve {host}: {exc}",
            code="actions.host_unresolvable",
            fix="check the hostname",
        ) from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        # An explicitly allowlisted loopback origin is honoured — correcting
        # your own dev server is the common case — but a name that resolves
        # to the metadata endpoint never is, whatever the allowlist says.
        if str(address) in ("169.254.169.254", "100.100.100.200", "192.0.0.192"):
            raise ExecutionError(
                "refusing to act against a cloud metadata endpoint",
                code="actions.metadata_refused",
                fix="this address is never a legitimate action target",
            )
    return origin


def http_request(inputs: dict[str, Any]) -> dict[str, Any]:
    """Perform one HTTP request as an approved side effect.

    Headers are passed through because a correction usually needs a token to
    be accepted, but the response is bounded and header *values* never make it
    into the recorded output — the outcome of an action is evidence, and
    evidence that carries credentials is a leak with a paper trail.
    """
    import httpx  # noqa: PLC0415

    url = str(inputs["url"])
    method = str(inputs.get("method", "POST")).upper()
    allowed = list(inputs.get("allowed_origins") or [])
    _assert_reachable(url, allowed)
    guard_egress(Channel.ACTION)

    headers = {str(k): str(v) for k, v in (inputs.get("headers") or {}).items()}
    body = inputs.get("json")
    timeout = float(inputs.get("timeout_seconds", 20.0))
    try:
        response = httpx.request(method, url, headers=headers, json=body,
                                 timeout=timeout, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise ExecutionError(
            f"the action request failed: {type(exc).__name__}: {exc}",
            code="actions.request_failed",
            fix="check the target is reachable and try again; the action is "
                "recorded as failed and has not been retried automatically",
            details={"url": _safe(url), "method": method},
        ) from exc

    text = response.text[:MAX_RESPONSE_BYTES]
    try:
        parsed: Any = json.loads(text)
    except ValueError:
        parsed = None
    expected = inputs.get("expect_status")
    if expected is not None and response.status_code != int(expected):
        raise ExecutionError(
            f"the endpoint answered {response.status_code}, not {expected}",
            code="actions.unexpected_status",
            fix="the side effect did not take; the action is recorded as "
                "failed and the postcondition will still be unmet",
            details={"status": response.status_code, "url": _safe(url),
                     "body": text[:500]},
        )
    return {
        "status": response.status_code,
        "url": _safe(url),
        "method": method,
        "body": parsed if parsed is not None else text[:2000],
        "bytes": len(response.content),
    }


def _safe(url: str) -> str:
    """A URL without its query string, for recording."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def execute(kind: str, inputs: dict[str, Any]) -> dict[str, Any]:
    """Run a registered executor. Called only after an approval is spent."""
    executor = _REGISTRY.get(kind)
    if executor is None:
        raise ExecutionError(
            f"no executor is registered for action kind {kind!r}",
            code="actions.unknown_kind",
            fix=f"registered kinds: {', '.join(registered_kinds()) or 'none'}",
            details={"kind": kind, "registered": list(registered_kinds())},
        )
    return executor(inputs)


register("http_request", http_request)


__all__ = [
    "MAX_RESPONSE_BYTES",
    "ExecutionError",
    "execute",
    "http_request",
    "register",
    "registered_kinds",
]
