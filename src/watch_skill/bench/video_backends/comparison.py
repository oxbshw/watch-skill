"""Head-to-head measurements: the provider and Watch Skill, same input.

The rest of this benchmark asks whether a provider's output can be ingested
as evidence. This module asks the narrower question a maintainer actually has
— *is the external service better than what we already do locally* — and it
only asks it where both sides can be given identical work.

Three rules keep the answer honest.

**Same input, same scorer, same machine.** Every comparison here runs both
sides over one file with one metric. Where the two systems do genuinely
different work, the axis is left out rather than fudged into a number.

**A tie is reported as a tie.** Watch Skill and a provider that both shell out
to the same `ffmpeg` will agree exactly, and a chart that dressed that up as a
win would be measuring nothing.

**Nothing is inferred from a document's fluency.** A written analysis is
scored on whether its vocabulary traces back to something observed in the
video and whether it cites the second it came from — not on how well it
reads.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.bench.video_backends.scoring import (
    analysis_groundedness,
    transcript_report,
)
from watch_skill.bench.video_backends.types import BackendCue


@dataclass
class SideResult:
    """One system's showing on one axis."""

    system: str
    value: float | None
    unit: str
    detail: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Axis:
    """One comparable measurement, with both sides and how to read it."""

    name: str
    question: str
    higher_is_better: bool
    unit: str
    sample: str
    watch_skill: SideResult | None = None
    provider: SideResult | None = None
    note: str = ""

    @property
    def verdict(self) -> str:
        """`watch_skill`, `provider`, `tie`, or `not_comparable`."""
        if self.watch_skill is None or self.provider is None:
            return "not_comparable"
        ours, theirs = self.watch_skill.value, self.provider.value
        if ours is None or theirs is None:
            return "not_comparable"
        if abs(ours - theirs) < 1e-9:
            return "tie"
        better_is_ours = ours > theirs if self.higher_is_better else ours < theirs
        return "watch_skill" if better_is_ours else "provider"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "question": self.question,
            "higher_is_better": self.higher_is_better,
            "unit": self.unit,
            "sample": self.sample,
            "watch_skill": self.watch_skill.to_dict() if self.watch_skill else None,
            "provider": self.provider.to_dict() if self.provider else None,
            "verdict": self.verdict,
            "note": self.note,
        }


# --- transcript -------------------------------------------------------------


def watch_skill_transcript(
    video: Path, cues: list[dict[str, Any]], work_dir: Path
) -> dict[str, Any]:
    """Watch Skill's own transcript over the speech fixture, same scorer.

    The ladder is called exactly as the product calls it — captions first,
    then local whisper — so this measures the transcript a user would really
    get, not a tuned configuration that exists only in a benchmark.
    """
    from watch_skill.transcribe.ladder import get_transcript

    work_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    try:
        transcript = get_transcript(
            video, work_dir, has_audio=True, word_timestamps=True
        )
    except Exception as exc:  # noqa: BLE001 — a failed rung is a result
        return {"error": f"{type(exc).__name__}: {exc}"[:300]}
    elapsed = time.perf_counter() - started

    hypothesis = [
        BackendCue(index=i, start=s.start, end=s.end, text=s.text)
        for i, s in enumerate(transcript.segments)
    ]
    report = transcript_report(cues, hypothesis, transcript_source=transcript.source)
    payload = report.to_dict()
    payload.update({
        "wall_seconds": round(elapsed, 2),
        "engine": transcript.source,
        "word_level_timestamps": any(s.words for s in transcript.segments),
        "offline": True,
    })
    return payload


# --- written analysis -------------------------------------------------------


def observed_texts(video_id: str) -> list[str]:
    """Everything Watch Skill actually observed in a video.

    The yardstick a written analysis is measured against: if a term appears
    nowhere in the transcript or the on-screen text, no document about this
    video can have got it from the video.
    """
    from watch_skill.index.db import connect

    conn = connect()
    try:
        rows = [
            r["text"] for r in conn.execute(
                "SELECT text FROM segments WHERE video_id = ?", (video_id,)
            )
        ]
        rows += [
            r["text"] for r in conn.execute(
                "SELECT text FROM ocr_blocks WHERE video_id = ?", (video_id,)
            )
        ]
    finally:
        conn.close()
    return rows


def compare_written_analysis(
    *,
    provider_document: Path | None,
    watch_skill_video_id: str | None,
    label: str,
) -> dict[str, Any]:
    """Score both write-ups of one video against what the video contained.

    Deliberately not a quality judgement. A provider's document may be a
    better read; what is measured is whether a reader could check it.
    """
    result: dict[str, Any] = {"video": label}
    if watch_skill_video_id is None:
        result["error"] = "the video is not in the local index — nothing to compare against"
        return result

    source = observed_texts(watch_skill_video_id)
    result["observed_text_blocks"] = len(source)
    if not source:
        result["error"] = "nothing was observed in this video; groundedness is undefined"
        return result

    from watch_skill.extract.notes import build_notes, render_notes

    try:
        ours = render_notes(build_notes(watch_skill_video_id))
        result["watch_skill"] = analysis_groundedness(ours, source).to_dict()
        result["watch_skill"]["document"] = "watch-skill notes"
    except Exception as exc:  # noqa: BLE001
        result["watch_skill"] = {"error": f"{type(exc).__name__}: {exc}"[:200]}

    if provider_document is not None and provider_document.is_file():
        text = provider_document.read_text(encoding="utf-8", errors="replace")
        result["provider"] = analysis_groundedness(text, source).to_dict()
        result["provider"]["document"] = provider_document.name
    else:
        result["provider"] = {
            "error": "no provider analysis document was downloaded for this video"
        }
    return result


# --- usage ------------------------------------------------------------------


def reconcile_usage(quota_before: str, quota_after: str) -> dict[str, Any]:
    """What the provider actually billed, against what was actually submitted.

    Both numbers come from the provider — its own quota readings and its own
    job registry — so this is measured usage, never a price list.
    """
    import json
    import re

    def minutes(text: str) -> float | None:
        match = re.search(r"used_minutes:\s*([\d.]+)", text or "")
        return float(match.group(1)) if match else None

    def remaining(text: str) -> float | None:
        match = re.search(r"remaining_minutes:\s*([\d.]+)", text or "")
        return float(match.group(1)) if match else None

    submitted_seconds = 0.0
    jobs: list[dict[str, Any]] = []
    registry = Path.home() / ".adversal" / "jobs.json"
    if registry.is_file():
        try:
            payload = json.loads(registry.read_text(encoding="utf-8"))
            entries = payload.get("jobs", payload) if isinstance(payload, dict) else payload
            if isinstance(entries, dict):
                entries = list(entries.values())
            seen: set[str] = set()
            for entry in entries or []:
                if not isinstance(entry, dict):
                    continue
                meta = entry.get("source_metadata") or entry
                digest = str(meta.get("hash") or entry.get("hash") or "")
                if digest and digest in seen:
                    continue
                seen.add(digest)
                duration = float(meta.get("source_duration_seconds") or 0.0)
                submitted_seconds += duration
                jobs.append({
                    "file": str(meta.get("uploaded_file_name") or "?"),
                    "duration_seconds": round(duration, 1),
                    "status": entry.get("status"),
                })
        except (OSError, ValueError):
            pass

    before, after = minutes(quota_before), minutes(quota_after)
    # Two different quantities, and mixing them produces nonsense — a first
    # version subtracted a per-run delta from a cumulative total and reported
    # negative rounding overhead. `this_run` is what this execution cost;
    # `lifetime` reconciles everything the registry has ever submitted against
    # everything the provider has ever billed.
    this_run = (after - before) if (before is not None and after is not None) else None
    submitted_minutes = submitted_seconds / 60.0 if submitted_seconds else None
    overhead = (
        round(after - submitted_minutes, 2)
        if after is not None and submitted_minutes else None
    )
    return {
        "this_run_billed_minutes": round(this_run, 2) if this_run is not None else None,
        "lifetime_billed_minutes": after,
        "lifetime_submitted_minutes": (
            round(submitted_minutes, 2) if submitted_minutes else None
        ),
        "rounding_overhead_minutes": overhead,
        "jobs_in_registry": len(jobs),
        "remaining_after": remaining(quota_after),
        "used_minutes_before": before,
        "jobs": jobs,
        "note": (
            "Both figures are the provider's own: its quota readings, and the "
            "durations in its own job registry. Billing rounds up to a whole "
            "minute per job, so short fixtures cost more than the media they "
            "contain. A re-run usually bills nothing at all: submissions are "
            "deduplicated on the MD5 of the bytes, so the same file resubmitted "
            "reuses its existing job — which is a point in the provider's favour "
            "and makes this benchmark cheap to repeat."
        ),
    }


# --- assembly ---------------------------------------------------------------


def build_axes(data: dict[str, Any]) -> list[Axis]:
    """Turn a finished benchmark result into the comparable axes.

    Only axes where both sides were actually measured on the same input reach
    the list. An axis nobody could run is absent, not zero.
    """
    axes: list[Axis] = []
    head = data.get("head_to_head") or {}

    # Written analysis, averaged over the real videos that produced both docs.
    notes = [
        row for row in (head.get("written_analysis") or [])
        if isinstance(row.get("watch_skill"), dict)
        and isinstance(row.get("provider"), dict)
        and row["watch_skill"].get("grounded_rate") is not None
        and row["provider"].get("grounded_rate") is not None
    ]
    if notes:
        ours = sum(r["watch_skill"]["grounded_rate"] for r in notes) / len(notes)
        theirs = sum(r["provider"]["grounded_rate"] for r in notes) / len(notes)
        axes.append(Axis(
            name="Written analysis, groundedness",
            question="How much of the write-up traces back to something in the video?",
            higher_is_better=True, unit="%",
            sample=f"{len(notes)} video(s)",
            watch_skill=SideResult("watch_skill", round(ours * 100, 1), "%",
                                   "watch-skill notes"),
            provider=SideResult("provider", round(theirs * 100, 1), "%", "notes.md"),
            note="Vocabulary not present in the transcript or on-screen text cannot "
                 "have come from the video.",
        ))
        ours_cit = sum(r["watch_skill"]["citations_per_100_words"] for r in notes) / len(notes)
        theirs_cit = sum(r["provider"]["citations_per_100_words"] for r in notes) / len(notes)
        axes.append(Axis(
            name="Written analysis, citations",
            question="How often does the write-up point at a timestamp?",
            higher_is_better=True, unit="per 100 words",
            sample=f"{len(notes)} video(s)",
            watch_skill=SideResult("watch_skill", round(ours_cit, 2), "per 100 words"),
            provider=SideResult("provider", round(theirs_cit, 2), "per 100 words"),
            note="A claim with no timestamp cannot be checked against the source.",
        ))

    # Frame delivery on real footage.
    real = [s for s in (data.get("real_media") or []) if s.get("summary")]
    if real:
        asked = sum(s["summary"].get("probes", 0) for s in real)
        got = sum(s["summary"].get("returned", 0) for s in real)
        control = sum((s.get("control") or {}).get("returned", 0) for s in real)
        if asked:
            axes.append(Axis(
                name="Frame delivery, real footage",
                question="Of the frames requested, how many arrived?",
                higher_is_better=True, unit="%",
                sample=f"{asked} requested across {len(real)} video(s)",
                watch_skill=SideResult("watch_skill", round(control / asked * 100, 1),
                                       "%", f"{control}/{asked}"),
                provider=SideResult("provider", round(got / asked * 100, 1), "%",
                                    f"{got}/{asked}"),
            ))

    # Transcript: text and alignment, scored the same way for both.
    theirs_tr = data.get("transcript")
    ours_tr = (head.get("transcript") or {})
    if theirs_tr and ours_tr and not ours_tr.get("error"):
        axes.append(Axis(
            name="Transcript text accuracy",
            question="How many words came back right?",
            higher_is_better=True, unit="%",
            sample="speech fixture, known script",
            watch_skill=SideResult("watch_skill", round((1 - ours_tr["wer"]) * 100, 1),
                                   "%", ours_tr.get("engine", "")),
            provider=SideResult("provider", round((1 - theirs_tr["wer"]) * 100, 1), "%"),
        ))
        if ours_tr.get("mean_overlap") is not None and theirs_tr.get("mean_overlap"):
            axes.append(Axis(
                name="Transcript interval alignment",
                question="Do the cue intervals land where the speech actually is?",
                higher_is_better=True, unit="IoU",
                sample="speech fixture, cue intervals known to the millisecond",
                watch_skill=SideResult("watch_skill", round(ours_tr["mean_overlap"], 3), "IoU"),
                provider=SideResult("provider", round(theirs_tr["mean_overlap"], 3), "IoU"),
            ))
        # Expressed as a hit rate rather than as a raw error, because the chart
        # draws taller as better. A "median error" panel put the worse system's
        # bar on top and read as a win for it at a glance; inverting the bar
        # instead would have made the geometry contradict the number printed on
        # it. Counting cues that land inside a tolerance is the same
        # measurement, the right way up.
        tolerance = 0.5

        def within(report: dict[str, Any]) -> float | None:
            rows = [
                a for a in (report.get("alignments") or [])
                if a.get("start_error") is not None
            ]
            if not rows:
                return None
            hits = sum(1 for a in rows if abs(a["start_error"]) <= tolerance)
            return round(hits / len(rows) * 100, 1)

        ours_hit, theirs_hit = within(ours_tr), within(theirs_tr)
        if ours_hit is not None and theirs_hit is not None:
            ours_median = (ours_tr.get("start_stats") or {}).get("median_abs")
            theirs_median = (theirs_tr.get("start_stats") or {}).get("median_abs")
            axes.append(Axis(
                name=f"Cue starts within {tolerance:g}s",
                question="How often does a cue start where the speech starts?",
                higher_is_better=True, unit="%",
                sample="speech fixture, cue starts known to the millisecond",
                watch_skill=SideResult(
                    "watch_skill", ours_hit, "%",
                    f"median |error| {ours_median:.3f}s" if ours_median else "",
                ),
                provider=SideResult(
                    "provider", theirs_hit, "%",
                    f"median |error| {theirs_median:.3f}s" if theirs_median else "",
                ),
                note=f"Median absolute start error: Watch Skill "
                     f"{ours_median:.3f}s, Adversal {theirs_median:.3f}s."
                     if ours_median and theirs_median else "",
            ))

    # Frame identity at a requested time — where both shell out to the same tool.
    identity = data.get("frame_identity") or {}
    baseline = (data.get("baseline") or {}).get("identity") or {}
    if identity.get("total") and baseline.get("total"):
        def clean(row: dict[str, Any]) -> float:
            bad = row.get("wrong_event", 0) + row.get("unidentified", 0) + row.get("no_image", 0)
            return round((row["total"] - bad) / row["total"] * 100, 1)

        axes.append(Axis(
            name="Frame identity, requested time",
            question="Is the returned picture from the moment that was asked for?",
            higher_is_better=True, unit="%",
            sample=f"{identity['total']} probes, generated fixture",
            watch_skill=SideResult("watch_skill", clean(baseline), "%"),
            provider=SideResult("provider", clean(identity), "%"),
            note="Both sides invoke the same ffmpeg seek, so an exact tie here is "
                 "the expected result rather than a finding.",
        ))
    return axes
