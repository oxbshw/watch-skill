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

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from watch_skill.surfaces.bridge.protocol import BridgeError
from watch_skill.surfaces.bridge.redact import safe_message, scrub
from watch_skill.surfaces.bridge.wire import (
    AnswerCitation,
    LibraryHit,
    LibraryPage,
    LibraryRecord,
    SourceAnswer,
    VerificationCheck,
    VerificationOutcome,
)

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
    working_dir = params.get("workingDir")
    bundle, _attestation = verify_run(
        contract,
        working_dir=Path(str(working_dir)) if working_dir else Path("."),
        isolated=True,
    )
    return _outcome_from_bundle(verification_id, bundle)


def verification_show(params: dict[str, Any]) -> Any:
    """`watch.verification.show` -> :func:`watch_skill.verify.load_run`."""
    from watch_skill.verify import load_run

    run_id = str(_require(params, "runId"))
    _contract, bundle, _attestation = load_run(run_id)
    return _outcome_from_bundle(run_id, bundle)


# -- browser -----------------------------------------------------------------


def _browser_unavailable(method: str) -> Handler:
    """Declare a browser method present in the contract and absent in Core.

    Core has a browser subsystem (:mod:`watch_skill.operate`), and it is real.
    What it does not have is a *Bridge-owned session lifecycle*: `observe`,
    `act` and `receipt` are three calls against one live page, and the Bridge
    has nowhere to keep that page between them.

    Building that lifecycle is a product decision, not a transport detail, so
    the transport does not quietly invent one. Until it exists these methods
    report unavailable, the handshake reports the same for
    ``watch.browser.observe`` and ``watch.browser.operate``, and the Host
    disables the surface instead of drawing a button that cannot work.
    """

    def handler(_params: dict[str, Any]) -> Any:
        raise _unavailable(
            method,
            "this Watch Core exposes no Bridge-owned browser session to act on.",
            "Drive the browser through Watch Core directly; the Bridge does not "
            "own browser sessions in this release.",
        )

    return handler


# -- evidence ----------------------------------------------------------------


def evidence_get(params: dict[str, Any]) -> Any:
    """`watch.evidence.get` — declared, and not backed by a Core operation.

    Core mints evidence *inside* a verification bundle and *inside* a live
    session; it has no global store keyed by ``evidenceId``, so there is
    nothing to look one up in. Saying so is the honest answer. Returning a
    synthesised record would put a fabricated observation in front of a user
    under the one contract that is supposed to guarantee the opposite.
    """
    raise _unavailable(
        "watch.evidence.get",
        "this Core has no global evidence store to resolve an evidenceId against.",
        "Read evidence through the verification run or live session that produced it.",
    )


#: Every method the Bridge answers, and the Core call behind it.
#:
#: ``watch.handshake``, ``watch.health``, ``watch.shutdown`` and
#: ``watch.cancel`` are handled by the server itself, because they are about
#: the connection rather than about the engine.
HANDLERS: dict[str, Handler] = {
    "watch.browser.act": _browser_unavailable("watch.browser.act"),
    "watch.browser.observe": _browser_unavailable("watch.browser.observe"),
    "watch.browser.receipt": _browser_unavailable("watch.browser.receipt"),
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
