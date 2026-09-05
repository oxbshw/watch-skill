"""The method table: every Bridge operation, and the Core call behind it.

The rule this module exists to keep is one line long and worth stating on its
own: **every handler calls a function that already exists elsewhere in Core.**
Nothing here computes an answer. A handler validates params, calls the engine,
and shapes the result into the wire contract — and when Core has no operation
for a declared method, the handler says ``bridge.capability_unavailable``
rather than returning something plausible.

That last part is the whole design. A Bridge that invents an evidence record,
a verdict, or a Library row is worse than no Bridge, because it lets a green
screen ship with nothing real behind it. The Host is built to render an
unavailable capability gracefully; it has no defence at all against a
convincing lie.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from watch_skill.surfaces.bridge.protocol import BridgeError
from watch_skill.surfaces.bridge.redact import safe_message, scrub
from watch_skill.surfaces.bridge.wire import (
    AnswerCitation,
    EvidenceRecord,
    LibraryHit,
    LibraryPage,
    LibraryRecord,
    SourceAnswer,
    VerificationCheck,
    VerificationOutcome,
)
from watch_skill.workspace_root import WorkspaceNotEstablished, require_workspace

_log = logging.getLogger(__name__)

#: A handler receives validated params and returns a JSON-serializable result.
Handler = Callable[[dict[str, Any]], Any]


def _require(params: dict[str, Any], name: str) -> Any:
    value = params.get(name)
    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise BridgeError(
            error="bridge.invalid_params",
            message=f'"{name}" is required.',
            fix=f"Send {name} with the request.",
            details={"parameter": name},
        )
    return value


def _int(params: dict[str, Any], name: str, default: int, *, maximum: int) -> int:
    """Read a bounded integer, refusing rather than clamping silently.

    Clamping would be friendlier and wrong: a caller asking for 100000 rows
    should learn that the ceiling exists, not receive 200 and believe that was
    all there was.
    """
    raw = params.get(name, default)
    if raw is None:
        return default
    if not isinstance(raw, int) or isinstance(raw, bool):
        raise BridgeError(
            error="bridge.invalid_params",
            message=f'"{name}" must be an integer.',
            fix=f"Send {name} as a whole number.",
            details={"parameter": name},
        )
    if raw < 1 or raw > maximum:
        raise BridgeError(
            error="bridge.invalid_params",
            message=f'"{name}" must be between 1 and {maximum}.',
            fix=f"Send {name} within the supported range.",
            details={"parameter": name, "maximum": maximum},
        )
    return raw


def _unavailable(method: str, reason: str, fix: str) -> BridgeError:
    """The honest answer for a declared method Core cannot perform.

    Distinct from ``method_not_found``: the method is part of the contract and
    the Host is right to have called it. What is missing is an engine
    operation behind it, and conflating the two would send someone looking for
    a typo.
    """
    return BridgeError(
        error="bridge.capability_unavailable",
        message=f'"{method}" is not available on this Watch Core: {reason}',
        fix=fix,
        details={"method": method},
        retryable=False,
    )


def _seconds_to_ms(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value) * 1000.0
    except (TypeError, ValueError):
        return None


# -- library -----------------------------------------------------------------


def _record_from_row(row: dict[str, Any], hits: list[LibraryHit] | None = None) -> LibraryRecord:
    """Shape one index row as a Library record.

    ``source_label`` is the title when there is one and the *basename* of the
    source otherwise — never the full path. A Library row is rendered in a
    browser and copied into model context, and an absolute host path in either
    is the privacy defect this contract was rewritten to close.
    """
    source = str(row.get("source") or "")
    title = row.get("title") or None
    if title:
        label = str(title)
    elif source:
        label = source.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or "source"
    else:
        label = "source"
    return LibraryRecord(
        source_id=str(row.get("id") or ""),
        title=str(title) if title else None,
        source_label=label,
        duration_ms=_seconds_to_ms(row.get("duration_seconds")),
        indexed_at=str(row["indexed_at"]) if row.get("indexed_at") else None,
        revision_id=str(row["revision_id"]) if row.get("revision_id") else None,
        hits=hits or [],
    )


def library_list(params: dict[str, Any]) -> Any:
    """`watch.library.list` -> :func:`watch_skill.index.list_videos`."""
    from watch_skill.index import list_videos

    limit = _int(params, "limit", 20, maximum=500)
    rows = list_videos()
    page = [_record_from_row(row) for row in rows[:limit]]
    return LibraryPage(
        sources=page, total=len(rows), truncated=len(rows) > limit
    ).model_dump(by_alias=True)


def library_search(params: dict[str, Any]) -> Any:
    """`watch.library.search` -> :func:`watch_skill.index.search_videos`."""
    from watch_skill.index import search_videos

    query = str(_require(params, "query"))
    limit = _int(params, "limit", 12, maximum=200)
    groups = search_videos(query, k=limit)
    records: list[LibraryRecord] = []
    for group in groups:
        video = group.get("video") or {}
        hits = [
            LibraryHit(
                timestamp_ms=_seconds_to_ms(hit.get("timestamp")),
                kind=str(hit.get("kind") or "unknown"),
                text=str(hit.get("text") or ""),
                score=float(hit.get("score") or 0.0),
            )
            for hit in (group.get("hits") or [])
        ]
        records.append(_record_from_row(video, hits))
    return LibraryPage(
        sources=records, total=len(records), truncated=False
    ).model_dump(by_alias=True)


# -- source ------------------------------------------------------------------


def source_ask(params: dict[str, Any]) -> Any:
    """`watch.source.ask` -> :func:`watch_skill.answer.answer_question`.

    The engine's ``Answer`` carries cache bookkeeping and token accounting
    that the contract does not promise and no screen should read; only the
    fields the contract names cross the wire.
    """
    from watch_skill.answer import answer_question

    source_id = str(_require(params, "sourceId"))
    question = str(_require(params, "question"))
    answer = answer_question(source_id, question)
    citations = [
        AnswerCitation(
            timestamp_ms=_seconds_to_ms(item.timestamp),
            kind=str(item.kind),
            text=str(item.text),
            score=float(item.score),
        )
        for item in getattr(answer, "evidence", [])
    ]
    return SourceAnswer(
        source_id=str(getattr(answer, "video_id", source_id)),
        question=question,
        answer=str(answer.text),
        confidence=float(answer.confidence),
        verified=bool(answer.verified),
        honest_floor=bool(getattr(answer, "honest_floor", False)),
        citations=citations,
        # Core mints EvidenceRecords through the verification path, not the
        # answer path. Returning [] is the accurate answer; synthesising
        # records from citations would mint evidence outside Core's authority,
        # which ADR-002 forbids for exactly this reason.
        evidence=[],
    ).model_dump(by_alias=True)


def source_moment(params: dict[str, Any]) -> Any:
    """`watch.source.moment` -> :func:`watch_skill.index.get_moment`."""
    from watch_skill.index import get_moment

    source_id = str(_require(params, "sourceId"))
    timestamp_ms = params.get("timestampMs")
    if not isinstance(timestamp_ms, (int, float)) or isinstance(timestamp_ms, bool):
        raise BridgeError(
            error="bridge.invalid_params",
            message='"timestampMs" must be a number.',
            fix="Send timestampMs as milliseconds on the source clock.",
            details={"parameter": "timestampMs"},
        )
    window_ms = params.get("windowMs") or 10_000
    context = get_moment(source_id, float(timestamp_ms) / 1000.0, window=float(window_ms) / 1000.0)
    payload = context.to_dict() if hasattr(context, "to_dict") else dict(context)
    # Frame paths are absolute on this machine. They are useful to Core and
    # disclosive to the Host, so they are rewritten rather than forwarded.
    return scrub(payload)


# -- capture and live --------------------------------------------------------


def capture_capabilities(_params: dict[str, Any]) -> Any:
    """`watch.capture.capabilities` -> :func:`watch_skill.live.capability_matrix`.

    The per-kind rows are published as ``capture`` rather than under the
    engine's own ``capabilities`` key. The handshake already answers something
    called capabilities and it is a different list -- what the *product* can
    do, versus what this machine can *record* -- and one word for both is how a
    reader ends up asserting against the wrong one.
    """
    from watch_skill.live import capability_matrix

    matrix = dict(capability_matrix())
    matrix["capture"] = matrix.pop("capabilities", [])
    return scrub(matrix)


def live_start(params: dict[str, Any]) -> Any:
    """`watch.live.start` -> :func:`watch_skill.live.start_live`."""
    from watch_skill.live import start_live

    target = str(_require(params, "target"))
    session = start_live(
        target,
        kind=str(params.get("kind") or "file_replay"),
        profile=str(params.get("profile") or "local-lite"),
        # These are the deliberately narrow public policy knobs exposed by
        # the Host tool.  Dropping allowLocal here made loopback fixtures --
        # and legitimate locally hosted applications -- impossible through
        # the Bridge even after the person explicitly allowed them.
        allow_local=params.get("allowLocal") is True,
        allowed_hosts=[str(host) for host in (params.get("allowedHosts") or [])]
        if isinstance(params.get("allowedHosts"), list)
        else None,
    )
    payload = session.to_public() if hasattr(session, "to_public") else session
    return scrub(payload)


def live_observe(params: dict[str, Any]) -> Any:
    """`watch.live.observe` -> :func:`watch_skill.live.observe`."""
    from watch_skill.live import observe

    session_id = str(_require(params, "sessionId"))
    cursor = params.get("cursor")
    return scrub(
        observe(
            session_id,
            cursor=str(cursor) if cursor else None,
            limit=_int(params, "limit", 50, maximum=500),
        )
    )


def live_ask(params: dict[str, Any]) -> Any:
    """`watch.live.ask` -> :func:`watch_skill.live.ask_live`."""
    from watch_skill.live import ask_live

    return scrub(
        ask_live(
            str(_require(params, "sessionId")),
            str(_require(params, "question")),
            scope=str(params.get("scope") or "recent"),
        )
    )


def live_aligned(params: dict[str, Any]) -> Any:
    """`watch.live.aligned` -> :func:`watch_skill.live.aligned_evidence`.

    What every stream observed around one moment. Correlation is deterministic
    -- timestamp overlap, nothing learned -- so an operator can reproduce the
    answer by hand, which is the property that makes it evidence.
    """
    from watch_skill.live import aligned_evidence

    media_ts = params.get("mediaTs")
    if not isinstance(media_ts, (int, float)) or isinstance(media_ts, bool):
        raise BridgeError(
            error="bridge.invalid_params",
            message='"mediaTs" must be a number.',
            fix="Send mediaTs as seconds on the session clock.",
            details={"parameter": "mediaTs"},
        )
    return scrub(
        aligned_evidence(
            str(_require(params, "sessionId")),
            float(media_ts),
            window=float(params.get("windowSeconds") or 2.0),
        )
    )


def live_status(params: dict[str, Any]) -> Any:
    """`watch.live.status` -> :func:`watch_skill.live.status`."""
    from watch_skill.live import list_live, status

    session_id = params.get("sessionId")
    if not session_id:
        return scrub({"sessions": list_live()})
    return scrub(status(str(session_id)))


def live_stop(params: dict[str, Any]) -> Any:
    """`watch.live.stop` -> :func:`watch_skill.live.stop_live`."""
    from watch_skill.live import stop_live

    return scrub(
        stop_live(
            str(_require(params, "sessionId")),
            reason=str(params.get("reason") or "stopped by the Host"),
        )
    )


# -- verification ------------------------------------------------------------


def _outcome_from_bundle(verification_id: str, bundle: Any) -> dict[str, Any]:
    checks = [
        VerificationCheck(
            check_id=str(result.check_id),
            kind=str(getattr(result, "kind", "") or "check"),
            description=str(getattr(result, "summary", "") or ""),
            passed=None
            if str(result.status.value if hasattr(result.status, "value") else result.status)
            not in ("pass", "fail")
            else str(result.status.value if hasattr(result.status, "value") else result.status)
            == "pass",
            evidence_refs=[],
            detail=safe_message(str(getattr(result, "summary", "") or "")) or None,
        )
        for result in getattr(bundle, "check_results", [])
    ]
    # Core's verdict is carried through untouched. The Bridge has no authority
    # to promote, demote or reinterpret it (ADR-002), and an unknown value maps
    # to INCONCLUSIVE rather than to a guess.
    verdict_map = {
        "pass": "VERIFIED",
        "fail": "FAILED",
        "inconclusive": "INCONCLUSIVE",
        "blocked": "BLOCKED",
        "stale": "STALE",
        "unverified": "UNVERIFIED",
    }
    verdict = verdict_map.get(str(bundle.verdict).lower(), "INCONCLUSIVE")
    limitations = list(getattr(bundle, "limitations", []) or [])

    # A verdict is only actionable if it says which check produced it. "Core
    # returned verdict fail" is true and tells a reader nothing they can open,
    # so a failure names the checks that failed before falling back to the
    # engine's own limitations.
    failed = [check.check_id for check in checks if check.passed is False]
    if failed:
        listed = ", ".join(failed[:5])
        more = "" if len(failed) <= 5 else f" (and {len(failed) - 5} more)"
        reason = f"{len(failed)} required check(s) failed: {listed}{more}."
    elif limitations:
        reason = limitations[0]
    else:
        reason = f"Core returned verdict {bundle.verdict}."
    return VerificationOutcome(
        verification_id=verification_id,
        verdict=verdict,  # type: ignore[arg-type]
        reason=safe_message(reason),
        checks=checks,
        contract_digest=str(getattr(bundle, "contract_digest", "") or ""),
        evaluated_at=str(getattr(bundle, "ended_at", "") or getattr(bundle, "created_at", "")),
    ).model_dump(by_alias=True)


def verification_run(params: dict[str, Any]) -> Any:
    """`watch.verification.run` -> :func:`watch_skill.verify.verify_run`.

    The Host sends an *expectation* and, when it has them, a list of checks —
    that is what `watch_verify` in ``@deepwatch/dsh-tools`` actually puts on
    the wire. This assembles a contract from them, freezes it, and runs it.

    **An expectation with no checks does not pass.** It returns ``UNVERIFIED``,
    because a sentence is not an executable postcondition and Core's whole
    verdict taxonomy exists to keep those apart (ADR-002). That is the answer a
    caller gets for "the deploy worked", and it is the correct one.

    Checks are never read from a Host path. A method that took a filename and
    had Core read it would be a filesystem read primitive wearing a
    verification method's name, so the checks arrive inline and
    ``workingDir`` bounds where they may look.
    """
    import uuid

    from pydantic import ValidationError

    from watch_skill.verify import VerificationContract, verify_run

    expectation = str(_require(params, "expectation"))
    verification_id = str(params.get("verificationId") or f"ver_{uuid.uuid4().hex[:16]}")
    raw_checks = params.get("checks") or []
    if not isinstance(raw_checks, list):
        raise BridgeError(
            error="bridge.invalid_params",
            message='"checks" must be a list.',
            fix="Send checks as a list of check objects, or omit it entirely.",
            details={"parameter": "checks"},
        )

    if not raw_checks:
        # A sentence is not an executable postcondition, and `UNVERIFIED` is
        # the taxonomy's word for exactly that. Core refuses an empty contract
        # outright (`verify.contract_empty`), which is right for its own CLI —
        # you should not be able to *ask* for a verdict with nothing to check.
        # Over the Bridge it is the wrong answer: the Host is reporting what an
        # agent claimed, and "no executable expectation" is a finding to render
        # rather than an error to raise. Nothing is invented here; this is the
        # one verdict that follows from the request alone.
        return VerificationOutcome(
            verification_id=verification_id,
            verdict="UNVERIFIED",
            reason=(
                "The expectation is prose, with no executable check behind it, "
                "so nothing was verified."
            ),
            checks=[],
            contract_digest="",
            evaluated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        ).model_dump(by_alias=True)

    try:
        contract = VerificationContract(
            contract_id=verification_id,
            title=expectation[:200],
            created_by="bridge",
            checks=raw_checks,
            source_prompt=expectation,
        )
    except ValidationError as exc:
        # The count, never the messages: a validation error quotes the value it
        # rejected, and the value came from the Host.
        raise BridgeError(
            error="verify.contract_invalid",
            message="The verification checks did not validate.",
            fix="`watch-skill verify checks` lists the supported check types and their parameters.",
            details={"errors": len(exc.errors())},
        ) from None

    contract = contract.freeze(created_by="bridge")
    # `Path(".")` used to stand here, and it is the whole of the workspace
    # defect: given no `workingDir`, the verifier measured against whatever
    # directory this process happened to be started in — neither the directory
    # the agent wrote in nor the one the person chose. A file created correctly
    # verified as INCONCLUSIVE: honest, and useless. There is no default for
    # this. Either the request names a directory or the launcher established
    # one, and otherwise this stops and says how to fix it.
    working_dir = params.get("workingDir")
    try:
        root = require_workspace("watch.verification.run", working_dir)
    except WorkspaceNotEstablished as exc:
        raise BridgeError(
            error="verify.workspace_unresolved",
            message=str(exc),
            fix=WorkspaceNotEstablished.fix,
        ) from None
    bundle, _attestation = verify_run(contract, working_dir=root, isolated=True)
    return _outcome_from_bundle(verification_id, bundle)


def verification_show(params: dict[str, Any]) -> Any:
    """`watch.verification.show` -> :func:`watch_skill.verify.load_run`."""
    from watch_skill.verify import load_run

    run_id = str(_require(params, "runId"))
    _contract, bundle, _attestation = load_run(run_id)
    return _outcome_from_bundle(run_id, bundle)


# -- browser and evidence ----------------------------------------------------


# The live-session registry owns browser processes.  The Bridge owns only the
# operator facade, command receipts, and evidence lookup for the life of this
# Core process.  Keeping those roles separate means stopping a live session
# still closes Chromium in one place, while a deadline on a Bridge request can
# be recovered through the idempotency key even if the browser thread finishes
# after the Host stopped waiting.
_browser_runtimes: dict[str, Any] = {}
_browser_attempts: dict[str, dict[str, Any]] = {}
_evidence: dict[str, dict[str, Any]] = {}
_browser_state_lock = threading.RLock()


def _canonical(value: Any) -> bytes:
    """Stable bytes for an id/digest, with no value copied into the id."""
    return json.dumps(
        scrub(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _digest(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical(value)).hexdigest()}"


def _runtime_for_session(session_id: str) -> Any | None:
    """Return one operator facade for a browser session running here."""
    from watch_skill.live.session import running_session
    from watch_skill.operate.runtime import BrowserRuntime

    runner = running_session(session_id)
    source = None if runner is None else getattr(runner, "_source", None)
    kind = None if runner is None else getattr(runner.session.spec.kind, "value", None)
    if runner is None or kind != "browser" or not bool(getattr(source, "running", False)):
        with _browser_state_lock:
            stale = _browser_runtimes.pop(session_id, None)
        if stale is not None:
            stale.close()
        return None
    with _browser_state_lock:
        runtime = _browser_runtimes.get(session_id)
        if runtime is None:
            runtime = BrowserRuntime(source, run_id=f"bridge_{session_id}", session_id=session_id)
            _browser_runtimes[session_id] = runtime
        return runtime


def _browser_runtime(params: dict[str, Any]) -> tuple[str, Any]:
    session_id = str(_require(params, "sessionId"))
    runtime = _runtime_for_session(session_id)
    if runtime is None:
        raise BridgeError(
            error="browser.session_unavailable",
            message="The named browser session is not running in this Watch Core process.",
            fix="Start a live session with kind=browser and use the returned sessionId.",
            details={"sessionId": session_id},
            retryable=False,
        )
    return session_id, runtime


def _mint_evidence(
    *, session_id: str, navigation_epoch: int, modality: str, content: Any
) -> dict[str, Any]:
    """Mint and retain a Core-authored EvidenceRecord from a real runtime result."""
    from watch_skill import __version__

    content_digest = _digest(content)
    evidence_id = "evi_" + hashlib.sha256(
        f"{session_id}\0{navigation_epoch}\0{modality}\0{content_digest}".encode()
    ).hexdigest()[:24]
    record = EvidenceRecord(
        evidence_id=evidence_id,
        source_revision_id=f"browser:{session_id}:epoch:{navigation_epoch}",
        artifact_ids=[],
        modality=modality,  # type: ignore[arg-type]
        provenance="observation",
        producer="watch-core-browser-runtime",
        producer_version=__version__,
        capture_quality="structured browser observation",
        freshness="current",
        content_digest=content_digest,
        retention_class="core-process-session",
        confidence=None,
    ).model_dump(by_alias=True)
    with _browser_state_lock:
        _evidence[evidence_id] = record
    return record


def browser_observe(params: dict[str, Any]) -> Any:
    """Observe the real page and mint a DOM evidence record for the reading."""
    session_id, runtime = _browser_runtime(params)
    observation = runtime.observe()
    public = scrub(observation.model_dump(mode="json"))
    record = _mint_evidence(
        session_id=session_id,
        navigation_epoch=int(observation.navigation_epoch),
        modality="dom",
        content=public,
    )
    return {
        "authority": "watch-core",
        "observation": public,
        "evidenceId": record["evidenceId"],
        # Observation establishes what the page showed.  It does not establish
        # that an intended effect worked.
        "verification": None,
    }


def _parse_action(raw: Any, operation_id: str) -> Any:
    from watch_skill.operate.types import Action

    if not isinstance(raw, dict):
        raise BridgeError(
            error="bridge.invalid_params",
            message='"action" must be an object.',
            fix="Send one typed browser action.",
            details={"parameter": "action"},
        )
    try:
        # The Host operation identity becomes the Core action identity.  A
        # model cannot choose either one, and every receipt can be followed
        # across the transport with the same value.
        return Action.model_validate({**raw, "action_id": operation_id})
    except ValidationError as exc:
        raise BridgeError(
            error="bridge.invalid_params",
            message="The browser action did not match the supported action contract.",
            fix="Use one of the advertised action kinds and its typed fields.",
            details={"parameter": "action", "errors": len(exc.errors())},
        ) from None


def browser_act(params: dict[str, Any]) -> Any:
    """Perform one typed action with approval and idempotency before touch."""
    from watch_skill.operate.types import SideEffect, Verdict

    # Command identity is transport policy, not optional action metadata.
    operation_id = str(_require(params, "operationId"))
    key = str(_require(params, "idempotencyKey"))
    input_digest = str(_require(params, "inputDigest"))
    action = _parse_action(_require(params, "action"), operation_id)

    # Approval is checked before resolving the session and therefore before a
    # BrowserRuntime can enqueue anything on the Playwright thread.
    if action.risk in (SideEffect.SIDE_EFFECTING, SideEffect.DESTRUCTIVE):
        approval_id = params.get("approvalId")
        if not isinstance(approval_id, str) or not approval_id.strip():
            raise BridgeError(
                error="bridge.approval_required",
                message="This browser action may change server state and has no Host approval.",
                fix="Ask through the Host approval service, then dispatch the exact approved action once.",
                details={"operationId": operation_id, "risk": action.risk.value},
                retryable=False,
            )

    with _browser_state_lock:
        existing = _browser_attempts.get(key)
        if existing is not None:
            if existing["inputDigest"] != input_digest:
                raise BridgeError(
                    error="bridge.idempotency_conflict",
                    message="That idempotency key already names a different browser action.",
                    fix="Read the existing receipt; use a fresh Host-minted operation for different input.",
                    details={"idempotencyKey": key},
                    retryable=False,
                )
            if existing["status"] == "completed":
                return existing["result"]
            if existing["status"] == "failed":
                raise BridgeError(**existing["error"])
            return {
                "status": "in_flight",
                "idempotencyKey": key,
                "operationId": existing["operationId"],
            }
        _browser_attempts[key] = {
            "status": "in_flight",
            "inputDigest": input_digest,
            "operationId": operation_id,
        }

    try:
        session_id, runtime = _browser_runtime(params)
        receipt = runtime.act(action)
        public = scrub(receipt.to_public())
        epoch = int(getattr(runtime.source, "_navigation_epoch", 0)) if hasattr(runtime, "source") else 0
        record = _mint_evidence(
            session_id=session_id,
            navigation_epoch=epoch,
            modality="dom",
            content=public,
        )
        result = {
            **public,
            "authority": "watch-core",
            "operationId": operation_id,
            "idempotencyKey": key,
            "completed": True,
            "verified": receipt.verdict is Verdict.SUCCEEDED,
            "evidenceId": record["evidenceId"],
        }
    except Exception as exc:
        if isinstance(exc, BridgeError):
            error = {
                "error": exc.error,
                "message": exc.message,
                "fix": exc.fix,
                "details": scrub(exc.details),
                "retryable": exc.retryable,
            }
        else:
            error = {
                "error": getattr(exc, "code", "browser.action_failed"),
                "message": safe_message(getattr(exc, "message", "The browser action failed.")),
                "fix": safe_message(getattr(exc, "fix", None) or "Inspect the browser session and receipt before retrying."),
                "details": scrub(getattr(exc, "details", {})),
                "retryable": False,
            }
        with _browser_state_lock:
            _browser_attempts[key] = {
                "status": "failed", "inputDigest": input_digest,
                "operationId": operation_id, "error": error,
            }
        raise BridgeError(**error) from None

    with _browser_state_lock:
        _browser_attempts[key] = {
            "status": "completed", "inputDigest": input_digest,
            "operationId": operation_id, "result": result,
        }
    return result


def browser_receipt(params: dict[str, Any]) -> Any:
    """Read, never repeat, an action named by its idempotency key."""
    key = str(_require(params, "idempotencyKey"))
    with _browser_state_lock:
        attempt = _browser_attempts.get(key)
        if attempt is None:
            return {"status": "unknown", "idempotencyKey": key}
        if attempt["status"] == "completed":
            return {"status": "completed", **attempt["result"]}
        if attempt["status"] == "failed":
            return {
                "status": "failed", "idempotencyKey": key,
                "operationId": attempt["operationId"],
                "error": attempt["error"]["error"],
                "message": attempt["error"]["message"],
                "fix": attempt["error"]["fix"],
            }
        return {
            "status": "in_flight", "idempotencyKey": key,
            "operationId": attempt["operationId"],
        }


# -- evidence ----------------------------------------------------------------


def evidence_get(params: dict[str, Any]) -> Any:
    """Resolve evidence minted by this Core process's browser authority."""
    evidence_id = str(_require(params, "evidenceId"))
    with _browser_state_lock:
        record = _evidence.get(evidence_id)
        if record is not None:
            return dict(record)
    raise BridgeError(
        error="evidence.not_found",
        message="That evidence id is not retained by this Watch Core process.",
        fix="Use an evidence id returned by the current Core session, or re-observe the source.",
        details={"evidenceId": evidence_id},
        retryable=False,
    )


def _reset_browser_bridge_state() -> None:
    """Close facades and clear process-local records. Tests and shutdown hooks."""
    with _browser_state_lock:
        runtimes = list(_browser_runtimes.values())
        _browser_runtimes.clear()
        _browser_attempts.clear()
        _evidence.clear()
    for runtime in runtimes:
        runtime.close()


#: Every method the Bridge answers, and the Core call behind it.
#:
#: ``watch.handshake``, ``watch.health``, ``watch.shutdown`` and
#: ``watch.cancel`` are handled by the server itself, because they are about
#: the connection rather than about the engine.
HANDLERS: dict[str, Handler] = {
    "watch.browser.act": browser_act,
    "watch.browser.observe": browser_observe,
    "watch.browser.receipt": browser_receipt,
    "watch.capture.capabilities": capture_capabilities,
    "watch.evidence.get": evidence_get,
    "watch.library.list": library_list,
    "watch.library.search": library_search,
    "watch.live.aligned": live_aligned,
    "watch.live.ask": live_ask,
    "watch.live.observe": live_observe,
    "watch.live.start": live_start,
    "watch.live.status": live_status,
    "watch.live.stop": live_stop,
    "watch.source.ask": source_ask,
    "watch.source.moment": source_moment,
    "watch.verification.run": verification_run,
    "watch.verification.show": verification_show,
}

__all__ = ["HANDLERS", "Handler"]
