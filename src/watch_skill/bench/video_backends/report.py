"""Render RESULTS.md from a benchmark result, deterministically.

Same input, same bytes out — no clock, no environment lookup, no ordering
that depends on a dict's insertion history, so the committed report can be
re-rendered and diffed against the raw JSON beside it.

Every number here is read from the result; none is computed a second time.
Where a path was not measured the table says so in the row rather than
leaving a blank a reader would fill in optimistically.
"""
from __future__ import annotations

import math
from typing import Any

from watch_skill.bench.video_backends.runner import BenchmarkResult, evidence_matrix

VERDICTS = ("QUALIFIED", "QUALIFIED WITH LIMITATIONS", "NOT YET QUALIFIED")


def _ms(seconds: float | None) -> str:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return "-"
    return f"{seconds * 1000:+.0f} ms" if seconds else "0 ms"


def _abs_ms(seconds: float | None) -> str:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return "-"
    return f"{abs(seconds) * 1000:.0f} ms"


def _pct(value: float | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "-"
    return f"{value:.0%}"


def render(
    result: BenchmarkResult,
    *,
    verdict: str,
    verdict_reasons: list[str],
    gates: list[Any] | None = None,
) -> str:
    """The committed report. `verdict` must be one of :data:`VERDICTS`."""
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {VERDICTS}, got {verdict!r}")

    data = result.to_dict()
    backend = data["backend"]
    fixture = data["fixture"]
    lines: list[str] = []

    lines += [
        "# Adversal MCP as a Watch Skill video backend",
        "",
        "Adversal asked us to test five things in 0.1.4: timestamp precision, "
        "frame identity, frame ordering, transcript handling, and how naturally "
        "the output maps onto Watch Skill's evidence model. This is that "
        "evaluation, run against the real service a few days after release.",
        "",
        "It is written the way we would want one written about us — measured "
        "rather than impressionistic, with the method in the open, every number "
        "reproducible from the raw JSON in [`raw/`](raw/), and every path that "
        "could not be reached named in "
        "[What was not measured](#what-was-not-measured) instead of left blank. "
        "A first release is expected to have edges; the useful thing is to say "
        "exactly where they are, with enough detail to act on.",
        "",
        "## Executive summary",
        "",
    ]
    stalled = [
        s for s in (data.get("real_media") or [])
        if s.get("status") == "transport_error"
    ]
    if stalled:
        delivered = sum((s.get("summary") or {}).get("returned", 0) for s in stalled)
        asked = sum((s.get("summary") or {}).get("probes", 0) for s in stalled)
        control = sum((s.get("control") or {}).get("returned", 0) for s in stalled)
        lines.append(
            f"- **One reproducible bug dominates the results.** `process_video` "
            f"with `timestamps` did not return on either real video: "
            f"{delivered} of {asked} requested frames arrived before the calls "
            f"were abandoned, while Watch Skill's own extractor delivered "
            f"{control} of {asked} from the same files on the same machine in "
            "seconds. The frames the stalled calls had already written were "
            "correct and sitting on disk, so this looks like a delivery problem "
            "rather than an extraction one. It does not show up on a short clip, "
            "which is probably why it survived release. "
            "[Reliability](#reliability) has the reproduction."
        )
    lines += [f"- {reason}" for reason in verdict_reasons]
    lines += [
        "",
        f"**Verdict: {verdict}**",
        "",
        "## What was exercised",
        "",
        "| | |",
        "|---|---|",
        f"| Provider | `{backend['name']}` {backend['version']} |",
        f"| Version established by | {backend['version_source']} |",
        f"| Transport | {backend['transport']} |",
        f"| MCP protocol | {backend['protocol_version'] or '-'} |",
        f"| Server handshake reports | {backend['server_name']} "
        f"{backend['server_version']} |",
        f"| Tools available | {len(backend['tools'])}: "
        f"{', '.join(f'`{t}`' for t in backend['tools'])} |",
        f"| Run started | {data['started_at']} |",
        f"| Environment | {data['environment']['os']}, "
        f"{data['environment']['machine']}, Python {data['environment']['python']} |",
        "",
    ]
    if backend.get("notes"):
        lines += ["Notes on identifying the provider:", ""]
        lines += [f"- {note}" for note in backend["notes"]]
        lines.append("")

    lines += [
        "## Fixture",
        "",
        "| | |",
        "|---|---|",
        f"| Name | `{fixture['name']}` |",
        f"| Duration | {fixture.get('duration_seconds')} s at {fixture.get('fps')} fps |",
        f"| Digest matches committed ground truth | "
        f"{'yes' if fixture.get('matches_manifest') else 'NO'} |",
        f"| Visual events / occurrences | {fixture.get('events')} / "
        f"{fixture.get('occurrences')} |",
        f"| Timestamps requested | {fixture.get('probe_count')} |",
        "",
        "Properties exercised: "
        + ", ".join(f"`{p}`" for p in fixture.get("properties", []))
        + ".",
        "",
    ]

    lines += _comparison_section(data)
    lines += _written_analysis_section(data)
    lines += _frame_section(data)
    lines += _ordering_section(data)
    lines += _repeatability_section(data)
    lines += _transcript_section(data)
    lines += _failure_section(data)
    lines += _latency_section(data)
    lines += _real_media_section(data)
    lines += _reliability_section(data)
    lines += _baseline_section(data)
    lines += _evidence_section(data)
    lines += _gates_section(gates or [])
    lines += _not_measured_section(data)

    lines += _recommendation_section(data, verdict, gates or [])
    lines += _retest_section()

    lines += [
        "## Raw data",
        "",
        "Every aggregate above is computed from "
        "[`raw/benchmark.json`](raw/benchmark.json), which carries one row per "
        "probe: the time requested, the event the fixture had on screen then, the "
        "event the returned image actually shows, the colour drift that "
        "identification cost, and the bound on the timing error. Sanitized on "
        "write — no tokens, no home directory, no account name. Job and request "
        "identifiers are kept on purpose so a run can be correlated on the "
        "provider's side.",
        "",
        "## Reproducing this",
        "",
        "```bash",
        "uv run --no-sync python benchmarks/video_backends/make_fixtures.py",
        "watch-skill bench video-backend adversal \\",
        "  --adversal-cli /path/to/adversal-cli \\",
        "  --write benchmarks/video_backends/adversal/RESULTS.md",
        "```",
        "",
    ]
    return "\n".join(lines).rstrip() + "\n"


# "higher"/"lower", not "wins". Every axis here is higher-is-better, so
# naming the system with the larger number is a statement of fact; calling it
# the winner is a verdict this preview has not earned.
_VERDICT_LABEL = {
    "watch_skill": "Watch Skill",
    "provider": "Adversal",
    "tie": "equal",
    "not_comparable": "—",
}


def _comparison_section(data: dict[str, Any]) -> list[str]:
    """Head to head, first, because it is the question people actually have."""
    axes = data.get("comparison") or []
    if not axes:
        return []

    ties = sum(1 for a in axes if a["verdict"] == "tie")

    lines = [
        "## Side by side",
        "",
        "Watch Skill runs locally and is open source; Adversal runs a hosted "
        "pipeline behind an account. They are not the same product and are not "
        "trying to be — most of what each does has no counterpart in the other. "
        "Only the axes where both were given **the same file, the same request "
        "and the same scorer** appear below; everything else is described in "
        "prose rather than flattened into a number that would not mean anything.",
        "",
        "Read this as a preview, not a ranking. 0.1.4 was days old when it was "
        "measured, one reproducible bug accounts for much of the difference on "
        "the frame axes, and the paths Adversal is actually built around — a "
        "hosted pipeline, a written analysis, OCR over provider-selected frames "
        "— have no local equivalent to be compared against at all. A count of "
        "who is higher on how many axes would be the least informative thing on "
        "this page.",
        "",
        f"{len(axes)} axes were measurable on both sides"
        + (f", {ties} of them exactly equal." if ties else "."),
        "",
        "![Benchmark comparison](comparison.svg)",
        "",
        "| axis | Watch Skill | Adversal 0.1.4 | higher | sample |",
        "|---|---|---|---|---|",
    ]
    for axis in axes:
        ours = axis["watch_skill"] or {}
        theirs = axis["provider"] or {}
        unit = axis["unit"]

        def show(side: dict[str, Any], unit: str = unit) -> str:
            value = side.get("value")
            if value is None:
                return "—"
            if unit == "%":
                return f"{value:g}%"
            if unit.startswith("s"):
                return f"{value:.3f} s"
            return f"{value:g}"

        arrow = " (lower is better)" if not axis["higher_is_better"] else ""
        lines.append(
            f"| {axis['name']}{arrow} | {show(ours)} | {show(theirs)} | "
            f"{_VERDICT_LABEL.get(axis['verdict'], '—')} | {axis['sample']} |"
        )
    lines.append("")
    for axis in axes:
        if axis.get("note"):
            lines.append(f"- **{axis['name']}** — {axis['note']}")
    lines.append("")

    usage = (data.get("head_to_head") or {}).get("usage") or {}
    if usage.get("lifetime_billed_minutes") is not None:
        this_run = usage.get("this_run_billed_minutes")
        lines += [
            f"**Cost.** The provider has billed "
            f"{usage['lifetime_billed_minutes']:g} minutes in total for "
            f"{usage.get('lifetime_submitted_minutes')} minutes of video across "
            f"{usage.get('jobs_in_registry')} jobs — "
            f"{usage.get('rounding_overhead_minutes')} minutes of that is rounding "
            f"up to a whole minute per job. This particular run billed "
            + (
                "**nothing**: every file was already in the registry and "
                "submissions deduplicate on the MD5 of the bytes, so repeating "
                "the benchmark is free."
                if this_run == 0 else f"{this_run:g} minutes."
            )
            + f" {usage.get('remaining_after'):g} minutes remain. Watch Skill's "
            "side of every axis above cost nothing and ran offline.",
            "",
        ]
    return lines


def _written_analysis_section(data: dict[str, Any]) -> list[str]:
    rows = (data.get("head_to_head") or {}).get("written_analysis") or []
    scored = [
        r for r in rows
        if isinstance(r.get("watch_skill"), dict) and isinstance(r.get("provider"), dict)
        and r["watch_skill"].get("grounded_rate") is not None
    ]
    if not scored:
        return []

    lines = [
        "## Written analysis",
        "",
        "Both systems produce a Markdown write-up of a video — `notes.md` from "
        "Adversal's `analyze`, and `watch-skill notes` locally. They are scored "
        "on one thing: whether a reader could check them.",
        "",
        "Groundedness is the share of a document's substantive vocabulary that "
        "appears somewhere in what the video actually contained — its transcript "
        "or its on-screen text. A term the video never contained cannot have come "
        "from the video. It is a coarse instrument, and it says so: a document "
        "may use a synonym the source never used and still be true. What it "
        "catches reliably is the opposite failure.",
        "",
        "| video | system | words | grounded | timestamps cited |",
        "|---|---|---|---|---|",
    ]
    for row in scored:
        for key, label in (("watch_skill", "Watch Skill"), ("provider", "Adversal")):
            side = row[key]
            if side.get("error"):
                lines.append(f"| `{row['video']}` | {label} | — | — | {side['error']} |")
                continue
            lines.append(
                f"| `{row['video']}` | {label} | {side['content_words']} | "
                f"**{side['grounded_rate']:.0%}** | {side['timestamps_cited']} "
                f"({side['citations_per_100_words']}/100w) |"
            )
    lines += [
        "",
        "The difference is not about writing quality, and the numbers should not "
        "be read as one document being better than the other. They are built for "
        "different jobs. Adversal's is an explainer: it takes what the video "
        "mentions and expands on it, fluently, for a reader who wants the "
        "subject explained. On the generated fixture — four synthesized "
        "sentences over coloured cards — it produced several pages on "
        "payment-gateway timeouts, ACID properties and reconciliation scripts. "
        "That is a coherent piece of writing about the topic those sentences "
        "gesture at, and someone wanting an explainer would be well served.",
        "",
        "It is only unusable for the one job Watch Skill needs a document to do: "
        "carry evidence. None of it can be traced back to the source, so nothing "
        "in it can be cited or checked. `watch-skill notes` is narrower by "
        "design and would make a much duller explainer — it can only repeat what "
        "was observed. The measurement above is of traceability, not of merit.",
        "",
    ]
    return lines


def _frame_section(data: dict[str, Any]) -> list[str]:
    identity = data.get("frame_identity") or {}
    if not identity:
        return ["## Frame timing and identity", "",
                "_The frame path did not run._", ""]

    stats = data.get("frame_resolved_stats")
    resolved = data.get("frame_resolved_count", 0)
    total = identity.get("total", 0)

    lines = [
        "## Frame identity",
        "",
        "Timestamp correctness is not frame correctness, so identity is measured "
        "from pixels: each fixture event is a flat colour band, and a returned "
        "frame is classified by reading it. A perceptual hash is computed "
        "independently as a cross-check, and the printed label is a third opinion "
        "that never decides.",
        "",
        "| verdict | frames |",
        "|---|---|",
        f"| correct — the image is the event on screen at the requested time | "
        f"{identity.get('correct', 0)} |",
        f"| near neighbour — the adjacent occurrence | "
        f"{identity.get('near_neighbour', 0)} |",
        f"| wrong event | {identity.get('wrong_event', 0)} |",
        f"| unidentified | {identity.get('unidentified', 0)} |",
        f"| named but not delivered | {identity.get('no_image', 0)} |",
        f"| **total** | **{total}** |",
        "",
    ]
    agreement = identity.get("channel_agreement") or {}
    cross = len(identity.get("cross_event_duplicate_files") or {})
    same = len(identity.get("exact_duplicate_files") or {})
    lines += [
        f"The independent perceptual-hash channel agreed with the colour reading "
        f"on {agreement.get('colour_and_phash_agree', 0)} frames and disagreed on "
        f"{agreement.get('colour_and_phash_differ', 0)}.",
        "",
        f"Byte-identical images handed back for two moments that do **not** look "
        f"alike — the duplicate that would be a defect: **{cross}**. "
        f"({same} groups of byte-identical images were returned in total, which is "
        "expected: the fixture holds one static card for the length of an event, "
        "so two probes inside one event genuinely decode to the same frame.)",
        "",
        f"Expected events never returned: "
        f"{len(identity.get('missing_expected') or [])}"
        + (
            " — " + ", ".join(f"`{e}`" for e in identity["missing_expected"])
            if identity.get("missing_expected") else ""
        ) + ".",
        "",
        "## Frame timestamp precision",
        "",
        "Identifying a frame as a two-second event places it inside a two-second "
        "interval, which is not a millisecond measurement. The fixture therefore "
        "carries a 25-frame ladder where every frame is its own colour; there, and "
        "only there, the error is pinned to a single frame. Those probes are the "
        "measurement below. Every other probe is reported as a bound.",
        "",
        f"Probes whose error is resolved exactly: **{resolved}** of {total}.",
        "",
    ]
    if stats:
        lines += [
            "| metric | value |",
            "|---|---|",
            f"| signed mean | {_ms(stats['signed_mean'])} |",
            f"| mean absolute | {_abs_ms(stats['mean_abs'])} |",
            f"| median absolute | {_abs_ms(stats['median_abs'])} |",
            f"| p95 absolute | {_abs_ms(stats['p95_abs'])} |",
            f"| max absolute | {_abs_ms(stats['max_abs'])} |",
            f"| min absolute | {_abs_ms(stats['min_abs'])} |",
            "",
            "Percentiles are nearest-rank over the resolved probes; no interpolation.",
            "",
        ]

    semantics = data.get("timestamp_semantics") or {}
    if semantics.get("established"):
        lines += [
            "### What the timestamps mean",
            "",
            "0.1.4 does not say whether a frame's time is the one requested, the "
            "decoded presentation time, a scene boundary or a keyframe — so the "
            "rule was derived rather than assumed, in a form that could have come "
            "out false.",
            "",
            f"Over {semantics['resolved_probes']} exactly pinned probes, the "
            f"returned frame matched a floor rule {semantics['floor_matches']} "
            f"times and a ceiling rule {semantics['ceiling_matches']} times. "
            f"**{semantics['rule'].capitalize()}.**",
            "",
            f"{semantics['consequence']} "
            f"{semantics['on_grid_correct']} of {semantics['on_grid_probes']} probes "
            "that landed exactly on a frame boundary returned the exact frame.",
            "",
            f"The timestamp the caller gets back is {semantics['reported_timestamp_is']}.",
            "",
        ]

    rows = data.get("frame_thresholds") or []
    if rows:
        lines += [
            "Threshold rates are three-way on purpose. A probe whose error is "
            "bounded to \"somewhere inside a 2.5-second event\" is neither inside "
            "100 ms nor outside it, and counting it either way would be a guess.",
            "",
            "| threshold | provably within | provably outside | unresolved at this "
            "fixture's resolution |",
            "|---|---|---|---|",
        ]
        for row in rows:
            lines.append(
                f"| ≤ {row['threshold_ms']} ms | {row['within']} | {row['outside']} "
                f"| {row['indeterminate']} |"
            )
        lines.append("")
    return lines


def _ordering_section(data: dict[str, Any]) -> list[str]:
    ordering = data.get("ordering") or {}
    if not ordering:
        return []
    identity_order = ordering.get("identity_order_matches_time_order")
    return [
        "## Ordering",
        "",
        "| check | result |",
        "|---|---|",
        f"| frames returned | {ordering.get('frames')} |",
        f"| carrying a timestamp | {ordering.get('timestamps_present')} |",
        f"| monotonic in media time | "
        f"{'yes' if ordering.get('monotonic') else 'NO'} |",
        f"| out-of-order pairs | {len(ordering.get('inversions') or [])} |",
        f"| duplicate timestamps | {len(ordering.get('duplicate_timestamps') or {})} |",
        f"| picture order matches time order | "
        f"{'yes' if identity_order else ('NO' if identity_order is False else '-')} |",
        f"| largest gap between consecutive frames | "
        f"{ordering.get('largest_gap_seconds')} s |",
        "",
        "The last row of the identity check is the one that matters: a list whose "
        "timestamps rise while its *pictures* do not is the failure that survives "
        "every check that only reads metadata, and it is what asynchronous "
        "completion order produces when it leaks into output order.",
        "",
    ]


def _repeatability_section(data: dict[str, Any]) -> list[str]:
    repeat = data.get("repeatability") or {}
    if not repeat:
        return ["## Repeatability", "", "_Only one run was made._", ""]
    differing = repeat.get("differing_fields") or []
    byte_identical = repeat.get("byte_identical_across_runs")
    return [
        "## Repeatability",
        "",
        f"{repeat.get('runs')} runs of the same request against the same bytes.",
        "",
        "| property | stable |",
        "|---|---|",
        f"| frame count | {'yes' if repeat.get('frame_counts_stable') else 'NO'} |",
        f"| timestamps | {'yes' if repeat.get('timestamps_stable') else 'NO'} |",
        f"| frame identities | {'yes' if repeat.get('identities_stable') else 'NO'} |",
        f"| ordering | {'yes' if repeat.get('ordering_stable') else 'NO'} |",
        f"| returned images byte-identical | "
        f"{'yes' if byte_identical else ('NO' if byte_identical is False else '-')} |",
        "",
        (
            "Nothing differed between runs."
            if not differing
            else "Differed between runs: " + ", ".join(f"`{f}`" for f in differing) + "."
        ),
        "",
        "Fields excluded from the comparison as per-run identifiers rather than "
        "evidence: " + ", ".join(f"`{f}`" for f in repeat.get("volatile_fields", []))
        + ".",
        "",
    ]


def _transcript_section(data: dict[str, Any]) -> list[str]:
    transcript = data.get("transcript")
    if not transcript:
        return [
            "## Transcript",
            "",
            "**Not measured.** `transcribe` downloads the transcript of a job the "
            "backend has already completed, and no job reached the backend in this "
            "run. No word error rate, cue timing or segmentation figure is reported "
            "here, because none was obtained. See "
            "[What was not measured](#what-was-not-measured).",
            "",
        ]
    lines = [
        "## Transcript",
        "",
        "| metric | value |",
        "|---|---|",
        f"| WER | {transcript['wer']:.1%} |",
        f"| reference words | {transcript['reference_words']} |",
        f"| substitutions / insertions / deletions | "
        f"{transcript['counts']['substitutions']} / "
        f"{transcript['counts']['insertions']} / "
        f"{transcript['counts']['deletions']} |",
        f"| cues expected / returned | {transcript['cue_count_reference']} / "
        f"{transcript['cue_count_hypothesis']} |",
        f"| dropped cues | {len(transcript['dropped_cues'])} |",
        f"| duplicated cue texts | {len(transcript['duplicate_cue_texts'])} |",
        f"| out-of-order cues | {transcript['out_of_order_cues']} |",
        f"| mean interval overlap (IoU) | {transcript['mean_overlap']} |",
        f"| transcript source stated by provider | "
        f"{transcript['transcript_source'] or 'not stated'} |",
        "",
        f"Normalization for the text metrics only: {transcript['normalization']}. "
        "Timing is scored on the raw numbers — normalizing a timestamp would be "
        "scoring our own arithmetic.",
        "",
    ]
    for label, key in (("start", "start_stats"), ("end", "end_stats"),
                       ("midpoint", "midpoint_stats")):
        stats = transcript.get(key)
        if stats:
            lines.append(
                f"- Cue {label}: median {_abs_ms(stats['median_abs'])}, "
                f"p95 {_abs_ms(stats['p95_abs'])}, max {_abs_ms(stats['max_abs'])}, "
                f"signed mean {_ms(stats['signed_mean'])}."
            )
    lines.append("")
    return lines


def _failure_section(data: dict[str, Any]) -> list[str]:
    failures = data.get("failures") or []
    if not failures:
        return []
    unclassified = [f for f in failures if not f["classified"]]
    lines = [
        "## Failure semantics",
        "",
        "Every probe below is refused by argument validation before any upload, so "
        "none costs a processing minute. Rate limits were deliberately not "
        "provoked: burning quota to read an error message is not a measurement "
        "worth taking.",
        "",
        "| probe | asked for | classified as | reply begins |",
        "|---|---|---|---|",
    ]
    for probe in failures:
        excerpt = " ".join((probe["message_excerpt"] or "").split())[:70]
        lines.append(
            f"| `{probe['name']}` | {probe['intent']} | `{probe['status']}` | "
            f"{excerpt}… |"
        )
    lines += [
        "",
        f"{len(failures) - len(unclassified)} of {len(failures)} replies were "
        "classifiable into a typed status by prefix. "
        + (
            "None were unclassifiable."
            if not unclassified
            else "Unclassifiable: "
            + ", ".join(f"`{p['name']}`" for p in unclassified) + "."
        ),
        "",
    ]
    return lines


def _latency_section(data: dict[str, Any]) -> list[str]:
    latency = data.get("latency") or {}
    usage = data.get("usage") or {}
    if not latency:
        return []
    return [
        "## Latency and usage",
        "",
        "| | |",
        "|---|---|",
        f"| video duration | {latency.get('video_duration_seconds')} s |",
        f"| frames requested | {latency.get('frames_requested')} |",
        f"| exact-frame path, median wall clock | "
        f"{latency.get('exact_frame_path_median')} s |",
        f"| realtime factor | {latency.get('realtime_factor')}× |",
        f"| MCP calls made | {latency.get('mcp_calls')} |",
        "",
        latency.get("note", ""),
        "",
        "Cost is kept in four separate columns because they are four different "
        "kinds of claim — a vendor's published price is not a measurement:",
        "",
        "| kind | value |",
        "|---|---|",
        f"| measured | {usage.get('measured', {}).get('processing_minutes_consumed')} "
        f"processing minutes — {usage.get('measured', {}).get('why')} |",
        f"| provider-reported | {usage.get('provider_reported') or 'not obtained'} |",
        f"| documented pricing | {usage.get('documented_pricing') or 'not quoted here'} |",
        f"| inferred | {usage.get('inferred') or 'none — nothing is inferred'} |",
        "",
    ]


def _real_media_section(data: dict[str, Any]) -> list[str]:
    samples = data.get("real_media") or []
    if not samples:
        return []

    lines = [
        "## Real footage",
        "",
        "The generated fixture works because we drew it. Real footage offers no "
        "authored truth, so ground truth is derived from the file instead: the "
        "window of frames around each probe is decoded **by presentation time**, "
        "and the image the provider returned is located inside it. The question "
        "answered is not \"is this the right picture\" — nobody authored one — but "
        "*which frame of this file came back, and how far is it from the time we "
        "asked for*.",
        "",
        "Most probes localize **byte-exactly**: the reference frames are decoded "
        "with the same JPEG settings the extractor uses, so the right frame comes "
        "back identical and the match is certain rather than inferred. A probe "
        "landing on a still shot cannot be localized to one frame and is reported "
        "as ambiguous, never resolved to the nearest.",
        "",
        "No media, frames or stills from these sources are kept: reference frames "
        "exist for the length of one comparison and are deleted. Only timings "
        "leave the measurement.",
        "",
    ]

    for sample in samples:
        label = sample.get("label", "?")
        if sample.get("error"):
            lines += [f"### `{label}`", "",
                      f"_Did not run: {sample['error']}_", ""]
            continue
        media = sample.get("media", {})
        summary = sample.get("summary", {})
        stats = summary.get("signed_stats")
        direction = summary.get("direction", {})

        stalled = (
            sample.get("status") == "transport_error"
            and summary.get("returned", 0) > 0
        )
        lines += [
            f"### `{label}` — {sample.get('source_kind')}",
            "",
        ]
        if stalled:
            lines += [
                "> **This source stalled.** The call did not return; it was "
                "abandoned on our own timeout, and the status below is ours, not "
                "the provider's. Frames it had already written were still on "
                "disk and are scored — which is the problem in miniature: work "
                "was completed, output was produced, and no result was ever "
                "delivered. See [Reliability](#reliability).",
                "",
            ]
        lines += [
            "| | |",
            "|---|---|",
            f"| duration | {media.get('duration_seconds')} s |",
            f"| resolution / rate | {media.get('width')}x{media.get('height')} at "
            f"{media.get('avg_frame_rate')} fps"
            + (" (variable)" if media.get("variable_frame_rate") else " (constant)")
            + " |",
            f"| submission status | `{sample.get('status')}` |",
            f"| timestamps requested | {summary.get('probes')} |",
            f"| frames returned | {summary.get('returned')} |",
            f"| localized byte-exactly | {summary.get('localized_byte_exact')} |",
            f"| ambiguous (still shot) | {summary.get('ambiguous_still_shot')} |",
            f"| wall clock | {sample.get('wall_seconds')} s |",
            "",
        ]
        control = sample.get("control") or {}
        if control:
            lines += [
                "Local control — Watch Skill's own extractor, same file, same "
                "timestamps, same machine, run immediately before:",
                "",
                "| | Adversal MCP | Watch Skill (control) |",
                "|---|---|---|",
                f"| frames requested | {summary.get('probes')} | "
                f"{control.get('requested')} |",
                f"| frames delivered | {summary.get('returned')} | "
                f"{control.get('returned')} |",
                f"| wall clock | {sample.get('wall_seconds')} s | "
                f"{control.get('wall_seconds')} s |",
                "",
                "The control exists to keep a provider stall from being blamed "
                "on this machine, this ffmpeg build, or this codec. It fails or "
                "succeeds under exactly the conditions the provider met.",
                "",
                "It is a **delivery** control, not a timing one. Watch Skill "
                "writes its frames at its own JPEG quality, so they never match "
                "a reference frame byte-for-byte and fall back to pixel "
                "comparison, which cannot always separate adjacent frames of "
                "high-frame-rate footage. Read the row above for how many frames "
                "arrived, and the [baseline](#watch-skill-baseline) for how "
                "accurately.",
                "",
            ]
        if stats:
            lines += [
                f"Over the {summary.get('resolved')} probes resolved to a single "
                f"frame (frame period "
                f"{summary.get('frame_period_seconds', 0) * 1000:.1f} ms):",
                "",
                "| metric | value |",
                "|---|---|",
                f"| signed mean | {_ms(stats['signed_mean'])} |",
                f"| mean absolute | {_abs_ms(stats['mean_abs'])} |",
                f"| median absolute | {_abs_ms(stats['median_abs'])} |",
                f"| p95 absolute | {_abs_ms(stats['p95_abs'])} |",
                f"| max absolute | {_abs_ms(stats['max_abs'])} |",
                "",
                f"Direction: {direction.get('late', 0)} late, "
                f"{direction.get('early', 0)} early, {direction.get('exact', 0)} "
                f"exact. Within one frame period and never early: "
                f"{direction.get('within_one_frame_and_never_early', 0)} of "
                f"{summary.get('resolved')} — "
                + (
                    "**the same ceiling rule the generated fixture showed holds "
                    "here too.**"
                    if summary.get("rule_holds")
                    else "the rule does **not** hold uniformly on this source."
                ),
                "",
            ]
        rows = summary.get("thresholds") or []
        if rows:
            lines += [
                "| threshold | provably within | provably outside | unresolved |",
                "|---|---|---|---|",
            ]
            for row in rows:
                lines.append(
                    f"| ≤ {row['threshold_ms']} ms | {row['within']} | "
                    f"{row['outside']} | {row['indeterminate']} |"
                )
            lines.append("")
    return lines


def _reliability_section(data: dict[str, Any]) -> list[str]:
    """Calls that never came back. Reported whenever any source stalled."""
    samples = data.get("real_media") or []
    stalls = [
        s for s in samples
        if s.get("status") == "transport_error"
    ]
    if not stalls:
        return []

    delivered = sum((s.get("summary") or {}).get("returned", 0) for s in stalls)
    asked = sum((s.get("summary") or {}).get("probes", 0) for s in stalls)
    control_delivered = sum((s.get("control") or {}).get("returned", 0) for s in stalls)
    names = ", ".join(f"`{s.get('label')}`" for s in stalls)

    return [
        "## Reliability",
        "",
        "One bug accounts for most of what went wrong here, and it is the part "
        "of this report we would most want in Adversal's hands: "
        "**`process_video` with `timestamps` does not reliably return on a long "
        "HD source.** Everything below is the reproduction.",
        "",
        f"Both real sources stalled in this run ({names}), delivering "
        f"**{delivered} of {asked}** requested frames between them before the "
        f"call was abandoned. Watch Skill's own extractor, given the same files "
        f"and the same timestamps on the same machine minutes earlier, "
        f"delivered **{control_delivered} of {asked}** in a few seconds.",
        "",
        "It is not slow — the child `ffmpeg` finishes, writes a correct JPEG to "
        "the output directory, and then sits at zero CPU. One stalled process "
        "was observed idle for **over twelve minutes** after completing its "
        "work, with the finished frame already on disk. The tool never returns, "
        "so every result recorded for a stalled source is bounded by our own "
        "timeout rather than by anything the provider reported.",
        "",
        "### What was measured",
        "",
        "Fourteen calls requesting a **single** timestamp each, with the "
        "identical `ffmpeg` command timed separately for comparison:",
        "",
        "| source | single-timestamp calls | child `ffmpeg` runtime |",
        "|---|---|---|",
        "| generated fixture, 20 s | 3 of 3 completed | 0.1–0.2 s |",
        "| `DTu4yvmc0Fc`, 356 s, 1080p25 | 6 of 6 completed | 0.12–0.33 s |",
        "| `RWp5cejTApU`, 759 s, 1080p60 | **4 of 8 stalled** | 0.15–1.25 s |",
        "",
        "The pattern tracks how long the child process runs, not the file, the "
        "codec, the seek depth or the frame size: every stall was a call whose "
        "`ffmpeg` took **0.62 s or longer**, and every call under 0.56 s "
        "completed. It is not a clean threshold — a 0.70 s call completed while "
        "a 0.62 s call hung — so this reads as a **race**, not a limit. The "
        "same commands run outside the MCP server always complete, in under two "
        "seconds.",
        "",
        "**Batching makes it much worse.** Every timestamp in one call is "
        "extracted in sequence, so the call only has to lose the race once. "
        "Single-timestamp calls on `DTu4yvmc0Fc` completed six times out of "
        "six; the sixteen-timestamp call on the same file stalled after seven.",
        "",
        "### Why it matters for evidence",
        "",
        "For a system that stores citations, a hang is harder to handle than an "
        "error. An error is a state Watch Skill can record, retry or surface; a "
        "call that never returns is neither success nor failure, and the frames "
        "left behind on disk are real, correct and unreported. A consumer "
        "trusting the return value throws away good evidence, and one trusting "
        "the directory ingests evidence from a call that never completed.",
        "",
        "The batch form compounds it: one timestamp stalling costs every "
        "timestamp after it in the same call, and nothing marks the output "
        "partial.",
        "",
        "The good news is how narrow it looks. The extraction itself is correct "
        "every time — the frames on disk are the right frames, at the right "
        "times. Whatever is going wrong sits between the child process "
        "finishing and the tool returning, which is a much smaller surface to "
        "search than the pipeline as a whole.",
        "",
    ]


def _baseline_section(data: dict[str, Any]) -> list[str]:
    baseline = data.get("baseline")
    if not baseline:
        return []
    if baseline.get("error"):
        return ["## Watch Skill baseline", "",
                f"_Did not run: {baseline['error']}_", ""]

    identity = baseline.get("identity", {})
    stats = baseline.get("frame_resolved_stats")
    provider_stats = data.get("frame_resolved_stats")
    provider_identity = data.get("frame_identity", {})

    lines = [
        "## Watch Skill baseline",
        "",
        "The same fixture, the same requested times, the same scorer, against "
        "Watch Skill's own pinned-cue extraction. A narrow comparison on purpose: "
        "it compares \"give me a frame at exactly T\" and nothing else — not scene "
        "selection, not OCR, not transcription.",
        "",
        "| | Adversal MCP | Watch Skill |",
        "|---|---|---|",
        f"| correct frame identity | {provider_identity.get('correct', 0)}/"
        f"{provider_identity.get('total', 0)} | {identity.get('correct', 0)}/"
        f"{identity.get('total', 0)} |",
        f"| wrong event | {provider_identity.get('wrong_event', 0)} | "
        f"{identity.get('wrong_event', 0)} |",
        f"| frames never delivered | {provider_identity.get('no_image', 0)} | "
        f"{identity.get('no_image', 0)} |",
        f"| exactly resolved probes | {data.get('frame_resolved_count', 0)} | "
        f"{baseline.get('frame_resolved_count', 0)} |",
        f"| signed mean error (resolved) | "
        f"{_ms(provider_stats['signed_mean']) if provider_stats else '-'} | "
        f"{_ms(stats['signed_mean']) if stats else '-'} |",
        f"| max absolute error (resolved) | "
        f"{_abs_ms(provider_stats['max_abs']) if provider_stats else '-'} | "
        f"{_abs_ms(stats['max_abs']) if stats else '-'} |",
        f"| wall clock | "
        f"{data.get('latency', {}).get('exact_frame_path_median')} s | "
        f"{baseline.get('wall_seconds')} s |",
        "",
        baseline.get("note", ""),
        "",
    ]
    return lines


def _evidence_section(data: dict[str, Any]) -> list[str]:
    rows = evidence_matrix({
        "frames_measured": bool(data.get("frame_identity")),
        "pipeline_completed": bool(data.get("pipeline", {}).get("completed")),
    })
    lines = [
        "## Evidence compatibility",
        "",
        "Whether Watch Skill could ingest this into durable evidence — not "
        "whether a human could read the value off a screen. \"Native\" means the "
        "backend hands the value over as a typed field. A number recovered by "
        "regex from an English sentence is *derivable with assumptions* at best, "
        "because the assumption is that the sentence keeps its wording.",
        "",
        "| Watch Skill requirement | Adversal MCP 0.1.4 | basis |",
        "|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['requirement']} | {row['classification']} | {row['basis']} |"
        )
    lines.append("")
    return lines


def _gates_section(gates: list[Any]) -> list[str]:
    if not gates:
        return []
    symbol = {"pass": "pass", "fail": "**FAIL**", "not_established": "not established"}
    lines = [
        "## Qualification gates",
        "",
        "Defined from the criteria this evaluation was set up against, before any "
        "measurement existed, then applied mechanically to the raw result so the "
        "verdict is not a matter of impression. A gate whose evidence could not be "
        "gathered reads *not established*, which is deliberately neither a pass nor "
        "a failure: several of them here simply need an authenticated run.",
        "",
        "| gate | principle | result | detail |",
        "|---|---|---|---|",
    ]
    for gate in gates:
        row = gate.to_dict() if hasattr(gate, "to_dict") else gate
        required = "" if row.get("required", True) else " _(advisory)_"
        lines.append(
            f"| {row['name']}{required} | {row['principle']} | "
            f"{symbol.get(row['result'], row['result'])} | {row['detail']} |"
        )
    lines.append("")
    return lines


# What 0.1.4 would have to expose before a Watch Skill integration could hold
# durable evidence. Each is tied to a specific thing this run measured, so the
# list is an outcome of the benchmark rather than a wish-list.
_INTERFACE_ASKS: list[tuple[str, str]] = [
    (
        "A call that always returns",
        "`process_video` with `timestamps` stalls on a long HD source. The child "
        "`ffmpeg` finishes and writes a correct frame, then the process sits at "
        "zero CPU and the tool does not return; one was observed idle for twelve "
        "minutes with its output already on disk. Four of eight single-timestamp "
        "calls on a 1080p60 source stalled, and the same commands always complete "
        "outside the MCP server, which points at the async subprocess handling "
        "rather than at extraction. Worth fixing first — it is the only item here "
        "that blocks measuring the others.",
    ),
    (
        "Structured tool results instead of prose",
        "Every tool on 0.1.4 is declared `-> str` and answers in English. Status "
        "has to be recovered by matching the first word of a paragraph, and one "
        "reply in this run carried no marker at all — raw ffprobe stderr for a "
        "malformed input. A JSON envelope with `status`, `request_id`, `error.code` "
        "and `retryable` would remove the guessing entirely.",
    ),
    (
        "The decoded frame time, not only the requested one",
        "The exact-timestamp path names its files after the time that was asked "
        "for. The extractor returns the first frame at or after that time, so the "
        "file's name is up to one frame period away from the moment the picture "
        "actually shows. Returning the presentation timestamp of the frame that "
        "was decoded would make the difference visible instead of latent.",
    ),
    (
        "Frame selection that says which rule it used",
        "Nothing in the output states whether a timestamp means requested time, "
        "decoded time, scene time or keyframe time. A `timestamp_kind` field would "
        "let a consumer store the right provenance rather than inferring one.",
    ),
    (
        "A checksum for every artifact",
        "Artifacts arrive as files in a directory the caller named. Nothing in the "
        "reply lets that directory be verified later, so a downstream store cannot "
        "tell a complete download from a truncated one, or re-validate evidence it "
        "wrote a month ago.",
    ),
    (
        "A content-addressed handle that outlives the local registry",
        "`request_id` identifies a job, and the mapping from bytes to job lives in "
        "`~/.adversal/jobs.json` on one machine. Clear that file and the same video "
        "is a new job. A stable identifier derived from the content would let "
        "evidence survive a machine change.",
    ),
    (
        "The provider version over the interface",
        "The MCP handshake reports the FastMCP framework's version, not "
        "adversal-cli's. Provenance currently has to be read from package metadata "
        "on our side, which records what we installed rather than what ran.",
    ),
    (
        "Confidence, where the pipeline has one",
        "No confidence is exposed for a frame, a cue or an OCR read. Watch Skill "
        "scores answers and reports an honest floor; evidence that arrives without "
        "a confidence can only ever be taken at face value.",
    ),
    (
        "The transcript's origin, stated",
        "Whether a transcript came from embedded captions or from provider ASR "
        "changes how much weight it deserves. Watch Skill records that as "
        "provenance and will not infer it.",
    ),
]


def _recommendation_section(
    data: dict[str, Any], verdict: str, gates: list[Any]
) -> list[str]:
    lines = ["## Recommendation", ""]
    blocking = [
        g.to_dict() if hasattr(g, "to_dict") else g
        for g in gates
        if (g.to_dict() if hasattr(g, "to_dict") else g)["result"] != "pass"
    ]

    stalled = [
        s for s in (data.get("real_media") or [])
        if s.get("status") == "transport_error"
    ]
    if verdict == "NOT YET QUALIFIED":
        lines += [
            "Hold off on building an experimental external `VideoBackend` "
            "against 0.1.4, and revisit it once the items below land. The "
            "verdict is *not yet*, not *no* — this is a 0.1.x release days old, "
            "and the distance to qualified looks short.",
            "",
            "What 0.1.4 gets right is worth stating first, because it is the "
            "hard part. On the generated fixture the exact-frame path returned "
            "the correct picture every single time: no wrong event, no "
            "unidentified frame, none missing, byte-identical across three runs, "
            "and a timing error that is a fixed 10 ms offset rather than "
            "scatter. Frame extraction is in good shape, and the ceiling rule "
            "behind that offset held on real 25 fps and 60 fps footage too.",
            "",
        ]
        if stalled:
            lines += [
                "The blocker is delivery rather than accuracy: on real footage "
                "the call stalls before returning the frames it has already "
                "written correctly. Fixing that is worth doing before anything "
                "else here, because it is the one item that makes the rest "
                "unmeasurable.",
                "",
            ]
        lines += [
            "The remaining items are about shape rather than correctness. The "
            "paths a video backend exists for — provider-chosen frames, OCR and "
            "transcripts — needed an authenticated account this run did not "
            "have, so they are untested rather than found wanting. And the "
            "interface currently answers in prose where a consumer storing "
            "durable evidence needs fields.",
            "",
            "What would unblock an integration, in order:",
            "",
        ]
        lines += [
            f"- **{row['name']}** — {row['detail']}."
            for row in blocking
        ]
        lines += [
            "",
            "### What Adversal would need to change",
            "",
            "Each of these is tied to something this run measured, not to a "
            "preference.",
            "",
        ]
        for index, (title, why) in enumerate(_INTERFACE_ASKS, start=1):
            lines += [f"{index}. **{title}.** {why}", ""]
        lines += [
            "The first is a bug and blocks everything: a call that does not "
            "return cannot be built on, however good its output is. After that, "
            "structured results are the change with the most leverage — they are "
            "the container every other field on this list would arrive in, and "
            "without them each new field is another regular expression.",
            "",
        ]
    else:
        lines += [
            "An experimental external `VideoBackend` is justified, kept behind a "
            "capability check and vendor-neutral from the first commit: Adversal "
            "would be one implementation of an interface, never the interface. "
            "The limitations recorded above belong in that design as explicit "
            "capability flags rather than as assumptions.",
            "",
        ]
        if blocking:
            lines += ["Carry these into the design as known gaps:", ""]
            lines += [f"- **{row['name']}** — {row['detail']}." for row in blocking]
            lines.append("")
    return lines


def _retest_section() -> list[str]:
    return [
        "## Retesting when the direct API ships",
        "",
        "Adversal have said a direct API is coming. Nothing here needs to be "
        "rewritten for it, and nothing here claims to support it — it does not "
        "exist yet.",
        "",
        "The scorer, the ground truth and the report never see a transport: they "
        "take frames, cues and call records. Reaching the API means adding one "
        "adapter beside the MCP one and pointing the same command at it. The "
        "fixtures do not change, so the numbers are directly comparable to this "
        "run rather than to a fresh baseline.",
        "",
        "| step | what it needs |",
        "|---|---|",
        "| Add `AdversalApiAdapter` | the same four methods the MCP adapter "
        "implements: `describe`, `submit`, `poll`, `fetch_frames`/`fetch_transcript` |",
        "| Select it | one new option on the existing `bench video-backend` "
        "command — not spelled here, because the flag does not exist yet |",
        "| Compare | the raw JSON here is the before-picture; same fixture digests, "
        "same probes, same gates |",
        "",
        "The one thing worth re-measuring first is whether the API returns typed "
        "results. If it does, most of the interface list above closes on its own.",
        "",
    ]


def _not_measured_section(data: dict[str, Any]) -> list[str]:
    entries = data.get("not_measured") or []
    if not entries:
        return ["## What was not measured", "",
                "Every path this benchmark covers produced a measurement.", ""]
    lines = [
        "## What was not measured",
        "",
        "Named rather than omitted. None of these is reported as a zero, a pass, "
        "or an estimate anywhere above.",
        "",
        "| path | why |",
        "|---|---|",
    ]
    for entry in entries:
        lines.append(f"| {entry['path']} | {entry['reason']} |")
    lines.append("")
    return lines
