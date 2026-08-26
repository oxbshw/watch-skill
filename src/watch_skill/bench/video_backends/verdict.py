"""Qualification gates, defined as principles and applied mechanically.

The gates below restate the criteria this evaluation was set up against,
before any result existed: no unexplained order corruption, no systematic
wrong-frame identity, timing error measured and bounded, transcript
alignment usable, partial evidence explicit, failures that do not masquerade
as success, provenance preservable, evidence mappable without invented
semantics, nondeterminism containable, output stable enough to be durable.

Each becomes one predicate over the raw result, and the verdict falls out of
the predicates. That ordering matters: a threshold picked after seeing the
numbers is not a threshold, it is a rationalization, and the whole point of
writing them down here is that they cannot be quietly moved later.

Three outcomes per gate, never two. A gate whose evidence could not be
gathered is ``NOT_ESTABLISHED`` — distinct from ``FAIL``, and equally
distinct from a pass. Absence of evidence is not evidence of qualification.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any

# Bounds fixed up front, from the fixture's own scale rather than from any
# observation: the fixture's frame period is 20 ms and its shortest event is
# 200 ms, so half a second is already far looser than a backend claiming
# frame-accurate extraction should ever need.
MAX_ACCEPTABLE_ABS_ERROR_SECONDS = 0.5
MIN_RESOLVED_PROBES = 10
MAX_ACCEPTABLE_WER = 0.50
MIN_ACCEPTABLE_CUE_OVERLAP = 0.50

# What a *video backend* exists to hand over. Watch Skill can compute source
# identity, content digests and freshness for itself; it cannot invent a frame,
# a frame's time, a transcript, or the order they belong in.
CORE_EVIDENCE = frozenset({
    "frame timestamp", "frame artifact", "transcript", "transcript interval",
    "ordering",
})


class GateResult(str, Enum):  # noqa: UP042
    PASS = "pass"
    FAIL = "fail"
    NOT_ESTABLISHED = "not_established"


@dataclass
class Gate:
    name: str
    principle: str
    result: GateResult
    detail: str
    required: bool = True

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["result"] = self.result.value
        return data


def _gate(name: str, principle: str, required: bool = True):
    def build(result: GateResult, detail: str) -> Gate:
        return Gate(name, principle, result, detail, required)

    return build


def evaluate(data: dict[str, Any], evidence_rows: list[dict[str, str]]) -> list[Gate]:
    """Apply every gate to one benchmark result."""
    gates: list[Gate] = []

    # --- ordering -----------------------------------------------------------
    build = _gate("frame order integrity",
                  "no unexplained frame-order corruption")
    ordering = data.get("ordering") or {}
    if not ordering:
        gates.append(build(GateResult.NOT_ESTABLISHED, "no frame run produced an order"))
    else:
        inversions = len(ordering.get("inversions") or [])
        picture_order = ordering.get("identity_order_matches_time_order")
        if inversions == 0 and picture_order is not False:
            gates.append(build(
                GateResult.PASS,
                f"{ordering.get('frames')} frames, monotonic, no inversions, and "
                "picture order followed time order",
            ))
        else:
            gates.append(build(
                GateResult.FAIL,
                f"{inversions} out-of-order pairs; picture order matched time "
                f"order: {picture_order}",
            ))

    # --- identity -----------------------------------------------------------
    build = _gate("frame identity", "no systematic wrong-frame identity")
    identity = data.get("frame_identity") or {}
    if not identity:
        gates.append(build(GateResult.NOT_ESTABLISHED, "no frames were graded"))
    else:
        wrong = identity.get("wrong_event", 0)
        unidentified = identity.get("unidentified", 0)
        undelivered = identity.get("no_image", 0)
        # The principle covers every frame the provider hands over, not only the
        # ones a caller named. Frames the provider selects for itself became
        # measurable once an account existed; the gate was always meant to
        # include them, there was simply nothing to include before.
        chosen = (data.get("pipeline") or {}).get("provider_frames") or {}
        chosen_graded = chosen.get("graded", 0)
        chosen_ok = chosen.get("picture_matches_claimed_time", 0)
        chosen_bad = chosen_graded - chosen_ok

        if wrong or unidentified or undelivered:
            gates.append(build(
                GateResult.FAIL,
                f"requested-frame path: wrong_event={wrong}, "
                f"unidentified={unidentified}, not_delivered={undelivered}",
            ))
        elif chosen_graded and chosen_bad == chosen_graded:
            gates.append(build(
                GateResult.FAIL,
                f"the requested-frame path is clean across {identity.get('total')} "
                f"frames, but every one of the {chosen_graded} frames the provider "
                "chose for itself shows content from a different moment than the "
                f"timestamp it carries (at least "
                f"{chosen.get('min_provable_error_seconds')} s out)",
            ))
        elif chosen_bad:
            gates.append(build(
                GateResult.FAIL,
                f"{chosen_bad} of {chosen_graded} provider-chosen frames do not "
                "match the timestamp they carry",
            ))
        else:
            gates.append(build(
                GateResult.PASS,
                f"{identity.get('total')} requested frames plus {chosen_graded} "
                "provider-chosen: no wrong-event, no unidentified, none "
                "named-but-not-delivered",
            ))

    # --- timing -------------------------------------------------------------
    build = _gate("timestamp error bounded", "timestamp error is measured and bounded")
    stats = data.get("frame_resolved_stats")
    resolved = data.get("frame_resolved_count", 0)
    if not stats or resolved < MIN_RESOLVED_PROBES:
        gates.append(build(
            GateResult.NOT_ESTABLISHED,
            f"{resolved} probes resolved exactly; at least {MIN_RESOLVED_PROBES} "
            "are needed before a bound means anything",
        ))
    elif stats["max_abs"] <= MAX_ACCEPTABLE_ABS_ERROR_SECONDS:
        gates.append(build(
            GateResult.PASS,
            f"{resolved} exactly resolved probes, max |error| "
            f"{stats['max_abs'] * 1000:.0f} ms, signed mean "
            f"{stats['signed_mean'] * 1000:+.0f} ms — a fixed offset, not scatter",
        ))
    else:
        gates.append(build(
            GateResult.FAIL,
            f"max |error| {stats['max_abs'] * 1000:.0f} ms exceeds the "
            f"{MAX_ACCEPTABLE_ABS_ERROR_SECONDS * 1000:.0f} ms bound",
        ))

    # --- transcript ---------------------------------------------------------
    build = _gate("transcript alignment usable", "transcript alignment is usable")
    transcript = data.get("transcript")
    if not transcript:
        gates.append(build(
            GateResult.NOT_ESTABLISHED,
            "no transcript was obtained — the artifact tool needs a completed "
            "backend job",
        ))
    else:
        overlap = transcript.get("mean_overlap")
        if (transcript["wer"] <= MAX_ACCEPTABLE_WER
                and overlap is not None and overlap >= MIN_ACCEPTABLE_CUE_OVERLAP):
            gates.append(build(
                GateResult.PASS,
                f"WER {transcript['wer']:.1%}, mean cue overlap {overlap:.2f}",
            ))
        else:
            gates.append(build(
                GateResult.FAIL,
                f"WER {transcript['wer']:.1%}, mean cue overlap {overlap}",
            ))

    # --- explicitness -------------------------------------------------------
    build = _gate("partial evidence explicit",
                  "partial and missing evidence is explicit, never silent")
    not_measured = data.get("not_measured") or []
    unreasoned = [e for e in not_measured if not e.get("reason")]
    if unreasoned:
        gates.append(build(GateResult.FAIL,
                           f"{len(unreasoned)} unmeasured paths carry no reason"))
    else:
        gates.append(build(
            GateResult.PASS,
            f"{len(not_measured)} unmeasured paths, each named with a reason",
        ))

    # --- failures -----------------------------------------------------------
    # Two different properties, deliberately not one gate. An error that is
    # unmistakably an error but arrives as unstructured prose is a limitation;
    # an error that arrives looking like a result is a disqualification. Fusing
    # them would let the milder problem carry the harsher verdict.
    build = _gate("failures do not masquerade as success",
                  "an invalid request is never answered as a result")
    failures = data.get("failures") or []
    if not failures:
        gates.append(build(GateResult.NOT_ESTABLISHED, "no failure probes were run"))
    else:
        false_success = [f for f in failures if f.get("status") == "ok"]
        if not false_success:
            gates.append(build(
                GateResult.PASS,
                f"{len(failures)} invalid requests, every one refused",
            ))
        else:
            gates.append(build(
                GateResult.FAIL,
                f"{len(false_success)} invalid requests answered as success",
            ))

    build = _gate("errors structurally distinguishable",
                  "a caller can tell error kinds apart without reading English",
                  required=False)
    if not failures:
        gates.append(build(GateResult.NOT_ESTABLISHED, "no failure probes were run"))
    else:
        unclassified = [f for f in failures if not f.get("classified")]
        if not unclassified:
            gates.append(build(
                GateResult.PASS,
                f"all {len(failures)} replies carried a marker a parser could key on",
            ))
        else:
            gates.append(build(
                GateResult.FAIL,
                f"{len(unclassified)} of {len(failures)} replies carry no status "
                "marker at all: "
                + ", ".join(f["name"] for f in unclassified),
            ))

    # --- provenance ---------------------------------------------------------
    build = _gate("provenance preservable",
                  "what produced the evidence can be recorded with it",
                  required=False)
    backend = data.get("backend") or {}
    if backend.get("version") in (None, "", "unknown"):
        gates.append(build(GateResult.FAIL, "the provider version could not be established"))
    else:
        gates.append(build(
            GateResult.PASS,
            f"version {backend['version']} via {backend.get('version_source')} — "
            "readable, though not over the MCP interface itself",
        ))

    # --- mapping ------------------------------------------------------------
    build = _gate("evidence maps without invented semantics",
                  "nothing has to be made up to store it as evidence")
    unavailable = [
        row["requirement"] for row in evidence_rows
        if row["requirement"] in CORE_EVIDENCE
        and row["classification"] == "unavailable"
    ]
    unmeasured = [
        row["requirement"] for row in evidence_rows
        if row["requirement"] in CORE_EVIDENCE
        and row["classification"].startswith("not measured")
    ]
    if unavailable:
        gates.append(build(
            GateResult.FAIL,
            "unavailable for core evidence: " + ", ".join(unavailable),
        ))
    elif unmeasured:
        gates.append(build(
            GateResult.NOT_ESTABLISHED,
            "not obtainable in this run: " + ", ".join(unmeasured),
        ))
    else:
        gates.append(build(GateResult.PASS,
                           "every core evidence field is native or derivable"))

    # --- determinism --------------------------------------------------------
    build = _gate("nondeterminism containable",
                  "run-to-run variation is confined to identifiers")
    repeat = data.get("repeatability") or {}
    if not repeat:
        gates.append(build(GateResult.NOT_ESTABLISHED, "fewer than two runs"))
    elif repeat.get("differing_fields"):
        gates.append(build(
            GateResult.FAIL,
            "evidence differed between runs: "
            + ", ".join(repeat["differing_fields"]),
        ))
    else:
        gates.append(build(
            GateResult.PASS,
            f"{repeat.get('runs')} runs identical in count, timestamps, identity "
            "and order",
        ))

    # --- durability ---------------------------------------------------------
    build = _gate("output stable enough to be durable",
                  "the same source yields the same evidence later")
    byte_identical = (data.get("repeatability") or {}).get("byte_identical_across_runs")
    if byte_identical is None:
        gates.append(build(GateResult.NOT_ESTABLISHED,
                           "not enough runs to compare returned bytes"))
    elif byte_identical:
        gates.append(build(GateResult.PASS,
                           "returned images were byte-identical across runs"))
    else:
        gates.append(build(
            GateResult.FAIL,
            "the same request returned different bytes on different runs",
        ))

    return gates


def decide(gates: list[Gate]) -> tuple[str, list[str]]:
    """Turn the gates into one of the three permitted verdicts.

    A required gate that could not be established blocks qualification just as
    a failure does, so a backend never qualifies because nobody managed to test
    the part that would have disqualified it.
    """
    failed = [g for g in gates if g.result is GateResult.FAIL]
    unestablished_required = [
        g for g in gates
        if g.result is GateResult.NOT_ESTABLISHED and g.required
    ]
    unestablished_optional = [
        g for g in gates
        if g.result is GateResult.NOT_ESTABLISHED and not g.required
    ]
    failed_optional = [g for g in gates if g.result is GateResult.FAIL and not g.required]

    if [g for g in failed if g.required]:
        verdict = "NOT YET QUALIFIED"
    elif unestablished_required:
        verdict = "NOT YET QUALIFIED"
    elif failed_optional or unestablished_optional:
        verdict = "QUALIFIED WITH LIMITATIONS"
    else:
        verdict = "QUALIFIED"

    reasons: list[str] = []
    passed = [g for g in gates if g.result is GateResult.PASS]
    if passed:
        reasons.append(
            f"**{len(passed)} of {len(gates)} gates passed**: "
            + "; ".join(f"{g.name} ({g.detail})" for g in passed[:4])
            + ("; …" if len(passed) > 4 else "")
        )
    for gate in failed:
        reasons.append(f"**Failed — {gate.name}**: {gate.detail}.")
    for gate in unestablished_required:
        reasons.append(
            f"**Not established — {gate.name}**: {gate.detail}. Untested rather "
            "than found wanting, but it still holds the verdict at *not yet*: "
            "an unrun gate cannot be counted as a passed one."
        )
    for gate in unestablished_optional:
        reasons.append(f"Not established (advisory) — {gate.name}: {gate.detail}.")
    return verdict, reasons
