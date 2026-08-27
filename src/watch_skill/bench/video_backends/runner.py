"""Execute the video-backend benchmark and emit machine-readable results.

The runner does the arranging; :mod:`scoring` does the judging. Everything
this module writes is sanitized on the way out and carries enough context —
fixture digests, package version, environment, per-call latency — to be
re-read a year later and still mean something.

Nothing here waits on an authenticated account to produce output. Paths that
need credentials are attempted, classified, and recorded as *not measured*,
which is a result; they are never quietly skipped and never counted as zero.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from watch_skill.bench.video_backends.sanitize import environment_summary, sanitize
from watch_skill.bench.video_backends.scoring import (
    FrameJudgement,
    TimingStats,
    VisualTruth,
    frame_identity_report,
    judge_frame,
    measure_image,
    ordering_report,
    repeatability_report,
    threshold_report,
    transcript_report,
)
from watch_skill.bench.video_backends.types import Outcome, OutcomeStatus

MANIFEST = "manifest.json"

# Identifiers that legitimately differ between two identical runs. Named here
# rather than discovered, so the repeatability report can say what it chose to
# forgive instead of quietly forgiving it.
VOLATILE_FIELDS = ["provider_job_id", "request_id", "output_path", "temp_dir"]


@dataclass
class FrameProbeRun:
    """One pass of the request-a-frame-at-T path."""

    run: int
    status: str
    frames_returned: int
    frames_requested: int
    wall_seconds: float
    judgements: list[FrameJudgement] = field(default_factory=list)
    detail: str = ""
    file_digests: dict[int, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run": self.run,
            "status": self.status,
            "frames_requested": self.frames_requested,
            "frames_returned": self.frames_returned,
            "wall_seconds": self.wall_seconds,
            "detail": self.detail,
            "judgements": [j.to_dict() for j in self.judgements],
        }


@dataclass
class FailureProbe:
    """One deliberately invalid request, and how the backend answered it."""

    name: str
    intent: str
    tool: str
    arguments: dict[str, Any]
    status: str
    latency_seconds: float
    message_excerpt: str
    classified: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "intent": self.intent,
            "tool": self.tool,
            "arguments": self.arguments,
            "status": self.status,
            "latency_seconds": self.latency_seconds,
            "message_excerpt": self.message_excerpt,
            "classified": self.classified,
        }


@dataclass
class BenchmarkResult:
    """Everything one execution learned. Serialized verbatim to raw/."""

    schema: str = "watch-skill/video-backend-benchmark/1"
    started_at: str = ""
    finished_at: str = ""
    environment: dict[str, str] = field(default_factory=dict)
    backend: dict[str, Any] = field(default_factory=dict)
    fixture: dict[str, Any] = field(default_factory=dict)
    frame_runs: list[FrameProbeRun] = field(default_factory=list)
    frame_identity: dict[str, Any] = field(default_factory=dict)
    frame_thresholds: list[dict[str, Any]] = field(default_factory=list)
    frame_resolved_stats: dict[str, Any] | None = None
    frame_resolved_count: int = 0
    timestamp_semantics: dict[str, Any] = field(default_factory=dict)
    ordering: dict[str, Any] = field(default_factory=dict)
    repeatability: dict[str, Any] = field(default_factory=dict)
    pipeline: dict[str, Any] = field(default_factory=dict)
    transcript: dict[str, Any] | None = None
    failures: list[FailureProbe] = field(default_factory=list)
    latency: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    baseline: dict[str, Any] | None = None
    real_media: list[dict[str, Any]] = field(default_factory=list)
    head_to_head: dict[str, Any] = field(default_factory=dict)
    comparison: list[dict[str, Any]] = field(default_factory=list)
    not_measured: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "environment": self.environment,
            "backend": self.backend,
            "fixture": self.fixture,
            "frame_runs": [
                r if isinstance(r, dict) else r.to_dict() for r in self.frame_runs
            ],
            "frame_identity": self.frame_identity,
            "frame_thresholds": self.frame_thresholds,
            "frame_resolved_stats": self.frame_resolved_stats,
            "frame_resolved_count": self.frame_resolved_count,
            "timestamp_semantics": self.timestamp_semantics,
            "ordering": self.ordering,
            "repeatability": self.repeatability,
            "pipeline": self.pipeline,
            "transcript": self.transcript,
            "failures": [
                f if isinstance(f, dict) else f.to_dict() for f in self.failures
            ],
            "latency": self.latency,
            "usage": self.usage,
            "baseline": self.baseline,
            "real_media": self.real_media,
            "head_to_head": self.head_to_head,
            "comparison": self.comparison,
            "not_measured": self.not_measured,
        }


def result_from_raw(payload: dict[str, Any]) -> BenchmarkResult:
    """Rebuild a result from the JSON it was written as.

    The point of writing every number down is that the write-up can be
    regenerated from it without touching the provider again. This is what
    makes "reproducible from the raw data" a property anyone can check rather
    than a claim in a README — re-render, diff, and see nothing change.

    ``frame_runs`` come back as plain dictionaries. Nothing in the report
    reaches into them, and rebuilding the judgement objects would only invite
    the round trip to drift from what was measured.
    """
    known = {f.name for f in fields(BenchmarkResult)}
    result = BenchmarkResult(**{k: v for k, v in payload.items() if k in known
                                and k != "frame_runs"})
    result.frame_runs = payload.get("frame_runs", [])  # type: ignore[assignment]
    return result


def load_manifest(fixtures_dir: Path) -> dict[str, Any]:
    path = fixtures_dir / MANIFEST
    if not path.is_file():
        raise FileNotFoundError(
            f"no ground truth at {path} — run benchmarks/video_backends/make_fixtures.py"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _digest(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def verify_fixture(fixtures_dir: Path, fixture: dict[str, Any]) -> dict[str, Any]:
    """Confirm the media on disk is the media the ground truth describes.

    A manifest that has drifted from its video would make every number below
    a measurement of the wrong thing, so this is a precondition rather than a
    diagnostic.
    """
    media = fixtures_dir / fixture["file"]
    if not media.is_file():
        return {
            "present": False,
            "matches_manifest": False,
            "note": f"{fixture['file']} is not present — regenerate the fixtures",
        }
    actual = _digest(media)
    return {
        "present": True,
        "matches_manifest": actual == fixture["sha256"],
        "sha256": actual,
        "expected_sha256": fixture["sha256"],
        "duration_seconds": fixture["media"]["duration_seconds"],
        "fps": fixture["fps"],
        "size_bytes": media.stat().st_size,
    }


def _indexed_id(source: str) -> str | None:
    """The local index's id for a source, if Watch Skill has already watched it.

    The comparison needs both sides to have seen the same file. Rather than
    indexing inside the benchmark — minutes of transcription nobody asked for
    — this looks the video up and reports honestly when it is absent.
    """
    try:
        from watch_skill.index.store import get_video

        video = get_video(source)
        return video["id"] if video else None
    except Exception:  # noqa: BLE001 — an absent index is a result
        return None


# --- the frame path ---------------------------------------------------------


def run_frame_probes(
    adapter: Any,
    video: Path,
    fixture: dict[str, Any],
    work_dir: Path,
    *,
    repeats: int,
) -> list[FrameProbeRun]:
    """Ask for the same exact timestamps, `repeats` times, and grade each."""
    truth = VisualTruth.from_manifest(fixture)
    band = fixture["identity_band"]
    probes = [float(t) for t in fixture["probe_timestamps"]]

    runs: list[FrameProbeRun] = []
    for attempt in range(1, repeats + 1):
        out = work_dir / f"frames_run{attempt}"
        started = time.perf_counter()
        outcome: Outcome = adapter.submit(video, output_dir=out, timestamps=probes)
        elapsed = time.perf_counter() - started

        judgements: list[FrameJudgement] = []
        digests: dict[int, str] = {}
        for frame in outcome.frames:
            measured = measure_image(frame.path, band) if frame.path else None
            color, phash = measured if measured else (None, None)
            judgements.append(
                judge_frame(frame, truth, measured_color=color, phash=phash)
            )
            if frame.path and frame.path.is_file():
                digests[frame.index] = _digest(frame.path)

        runs.append(FrameProbeRun(
            run=attempt,
            status=outcome.status.value,
            frames_requested=len(probes),
            frames_returned=len(outcome.frames),
            wall_seconds=round(elapsed, 3),
            judgements=judgements,
            detail=outcome.detail[:600],
            file_digests=digests,
        ))
    return runs


def timestamp_semantics_finding(
    judgements: list[FrameJudgement], fps: int
) -> dict[str, Any]:
    """What a returned timestamp turned out to mean, as a falsifiable claim.

    Adversal was asked what its timestamps refer to; 0.1.4 does not say. So
    the rule is derived instead of assumed, and stated in a form that could
    have come out false: for every probe whose frame is pinned exactly, is the
    frame returned the last one at or before the requested time (floor), or
    the first one at or after it (ceiling)?
    """
    period = 1.0 / fps
    resolved = [
        j for j in judgements
        if j.uncertainty == 0.0 and j.requested_seconds is not None
        and j.actual_interval is not None
    ]
    if not resolved:
        return {"established": False,
                "why": "no probe was pinned to a single frame"}

    def grid(value: float) -> float:
        return round(value / period)

    floor_matches = sum(
        1 for j in resolved
        if grid(j.actual_interval[0]) == math_floor(j.requested_seconds / period)
    )
    ceiling_matches = sum(
        1 for j in resolved
        if grid(j.actual_interval[0]) == math_ceil(j.requested_seconds / period)
    )
    on_grid = [
        j for j in judgements
        if j.requested_seconds is not None
        and abs(j.requested_seconds / period - round(j.requested_seconds / period)) < 1e-6
    ]
    on_grid_correct = sum(1 for j in on_grid if j.verdict.value == "correct")

    if ceiling_matches == len(resolved) and floor_matches != len(resolved):
        rule = (
            "the frame returned is the FIRST frame at or after the requested "
            "time (ceiling), not the frame being displayed at it (floor)"
        )
        semantics = "requested-time, rounded up to the next frame boundary"
    elif floor_matches == len(resolved):
        rule = (
            "the frame returned is the frame being displayed at the requested "
            "time (floor)"
        )
        semantics = "decoded frame containing the requested time"
    else:
        rule = "neither a consistent floor nor a consistent ceiling"
        semantics = "unknown — the rule is not consistent across probes"

    return {
        "established": True,
        "resolved_probes": len(resolved),
        "floor_matches": floor_matches,
        "ceiling_matches": ceiling_matches,
        "rule": rule,
        "semantics": semantics,
        "on_grid_probes": len(on_grid),
        "on_grid_correct": on_grid_correct,
        "consequence": (
            "A request landing exactly on a frame boundary is exact. A request "
            "between boundaries comes back up to one frame period late and never "
            "early, so the error is a bounded, signed offset rather than scatter — "
            f"[0, {period * 1000:.0f} ms) at this fixture's {fps} fps."
        ),
        "reported_timestamp_is": (
            "the time the caller asked for, echoed in the filename; the provider "
            "never states the presentation time of the frame it actually decoded"
        ),
    }


def math_floor(value: float) -> int:
    import math

    return math.floor(round(value, 9))


def math_ceil(value: float) -> int:
    import math

    return math.ceil(round(value, 9))


def frame_resolved(judgements: list[FrameJudgement]) -> list[FrameJudgement]:
    """The probes whose error is known exactly, not merely bounded.

    A frame identified as ``EVENT_002`` sits somewhere in a 2.5-second
    occurrence, and no arithmetic turns that into a millisecond figure. Only
    the ladder rungs — one frame wide — pin the error down, so the headline
    timing numbers are computed from these and the rest are reported as bounds.
    """
    return [
        j for j in judgements
        if j.uncertainty is not None and j.uncertainty == 0.0
    ]


# --- the pipeline path ------------------------------------------------------


def run_pipeline(
    adapter: Any,
    video: Path,
    fixture: dict[str, Any],
    work_dir: Path,
    *,
    poll_attempts: int = 0,
    poll_interval: float = 20.0,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Submit for the backend pipeline, then try to collect its artifacts.

    Written to run end to end the moment a session exists. Without one, each
    stage records the status it actually got — which for 0.1.4 is
    AUTH_REQUIRED at the submit step — and every later stage is recorded as
    not attempted rather than as a failure it never got to have.
    """
    record: dict[str, Any] = {"stages": []}

    submit_dir = work_dir / "pipeline"
    started = time.perf_counter()
    submitted: Outcome = adapter.submit(video, output_dir=submit_dir)
    record["stages"].append({
        "stage": "submit",
        "status": submitted.status.value,
        "latency_seconds": submitted.latency_seconds,
        "wall_seconds": round(time.perf_counter() - started, 3),
        "provider_job_id": submitted.provider_job_id,
        "detail": submitted.detail[:600],
    })

    handle = submitted.provider_job_id
    if submitted.status is not OutcomeStatus.OK or not handle:
        for stage in ("poll", "extract_frames", "transcribe"):
            record["stages"].append({
                "stage": stage,
                "status": "not_attempted",
                "reason": f"submit returned {submitted.status.value}",
            })
        record["completed"] = False
        return record, None

    terminal: Outcome | None = None
    for attempt in range(max(1, poll_attempts)):
        polled = adapter.poll(handle)
        record["stages"].append({
            "stage": "poll",
            "attempt": attempt + 1,
            "status": polled.status.value,
            "latency_seconds": polled.latency_seconds,
            "detail": polled.detail[:400],
        })
        if polled.status is not OutcomeStatus.NOT_READY:
            terminal = polled
            break
        time.sleep(poll_interval)

    if terminal is None or terminal.status is not OutcomeStatus.OK:
        record["completed"] = False
        return record, None

    frames = adapter.fetch_frames(handle, output_dir=work_dir / "pipeline_frames")
    record["stages"].append({
        "stage": "extract_frames",
        "status": frames.status.value,
        "latency_seconds": frames.latency_seconds,
        "frames_returned": len(frames.frames),
        "detail": frames.detail[:400],
    })
    # The frames the provider chose for itself, graded the same way as the ones
    # we asked for by name. This is a different question from the exact-frame
    # path: there the caller names the moment, here the provider does, and the
    # timestamp it attaches is the only thing tying the picture to the source.
    # Both fixtures carry `events`; only the visual one carries the timeline
    # that makes "was this picture on screen then" answerable. Grading the
    # speech fixture's frames against a timeline it does not have was a crash,
    # and would have been a wrong number if it had not been.
    if (
        frames.status is OutcomeStatus.OK
        and fixture.get("events")
        and fixture.get("occurrences")
        and fixture.get("identity_band")
    ):
        record["provider_frames"] = score_provider_frames(frames.frames, fixture)

    transcript = adapter.fetch_transcript(handle, output_dir=work_dir / "pipeline_transcript")
    record["stages"].append({
        "stage": "transcribe",
        "status": transcript.status.value,
        "latency_seconds": transcript.latency_seconds,
        "cues_returned": len(transcript.cues),
        "detail": transcript.detail[:400],
    })
    record["completed"] = True

    transcript_scores = None
    if transcript.status is OutcomeStatus.OK and fixture.get("cues"):
        transcript_scores = transcript_report(
            fixture["cues"], transcript.cues,
            transcript_source=transcript.transcript_source,
        ).to_dict()
    return record, transcript_scores


def score_provider_frames(
    frames: list[Any], fixture: dict[str, Any]
) -> dict[str, Any]:
    """Grade frames the provider selected, against the time it claims for them.

    The exact-frame path can be checked by asking for a moment and seeing what
    arrives. Here there is no request to check against — the provider picked
    both the picture and the timestamp, so the only thing that can be verified
    is whether they agree with each other. They are supposed to: a citation is
    a claim that this frame was on screen at this time.
    """
    truth = VisualTruth.from_manifest(fixture)
    band = fixture["identity_band"]
    rows: list[dict[str, Any]] = []
    for frame in frames:
        row: dict[str, Any] = {
            "index": frame.index,
            "claimed_seconds": frame.timestamp_seconds,
            "provider_id": frame.provider_id,
            "ocr_text": (frame.ocr_text or "")[:120],
        }
        measured = measure_image(frame.path, band) if frame.path else None
        if measured is None:
            row["note"] = "frame named in frames.json was not readable on disk"
            rows.append(row)
            continue
        colour, phash = measured
        from watch_skill.bench.video_backends.scoring import (
            identify_by_color,
            identify_by_phash,
        )

        actual, drift = identify_by_color(colour, truth.events)
        by_phash, _ = identify_by_phash(phash, truth.events)
        row.update({
            "actual_event_id": actual,
            "colour_drift": drift,
            "phash_event_id": by_phash,
            "channels_agree": actual is not None and actual == by_phash,
        })
        claimed = frame.timestamp_seconds
        expected = truth.occurrence_at(claimed) if claimed is not None else None
        row["expected_event_id"] = expected["event_id"] if expected else None
        occurrence = (
            truth.nearest_occurrence_of(actual, claimed) if actual else None
        )
        if occurrence and claimed is not None:
            lo = round(occurrence["start"] - claimed, 6)
            hi = round(occurrence["end"] - truth.frame_period - claimed, 6)
            row.update({
                "true_interval": [occurrence["start"], occurrence["end"]],
                "signed_error_lo": lo,
                "signed_error_hi": max(lo, hi),
                "abs_lower_bound": 0.0 if lo <= 0 <= hi else round(min(abs(lo), abs(hi)), 6),
                "matches_claim": row["actual_event_id"] == row["expected_event_id"],
            })
        rows.append(row)

    graded = [r for r in rows if r.get("abs_lower_bound") is not None]
    agreeing = [r for r in rows if r.get("matches_claim")]
    bounds = [r["abs_lower_bound"] for r in graded]
    return {
        "frames_returned": len(frames),
        "graded": len(graded),
        "picture_matches_claimed_time": len(agreeing),
        "min_provable_error_seconds": min(bounds) if bounds else None,
        "max_provable_error_seconds": max(bounds) if bounds else None,
        "rows": rows,
        "note": (
            "Error is a lower bound: the fixture holds a static card for the "
            "length of an event, so identifying the picture places it inside "
            "that event's interval and no closer."
        ),
    }


# --- failure semantics ------------------------------------------------------


def failure_probes(adapter: Any, video: Path, work_dir: Path) -> list[FailureProbe]:
    """Safe, quota-free probes of how the backend refuses things.

    Every one of these is rejected by argument validation before any upload,
    so none of them costs a processing minute and none of them can disturb a
    real session. Rate limits are deliberately not provoked: burning somebody
    else's quota to see the error message is not a measurement worth taking.
    """
    missing = work_dir / "definitely-not-here.mp4"
    empty = work_dir / "empty.mp4"
    empty.parent.mkdir(parents=True, exist_ok=True)
    empty.write_bytes(b"")
    not_a_video = work_dir / "not-a-video.mp4"
    not_a_video.write_text("this is text, not an MP4", encoding="utf-8")

    # A file the local registry cannot possibly know. Pointing the
    # "never submitted" probe at a fixture was wrong once the pipeline stage
    # started submitting that same fixture minutes earlier: the tool answered
    # FOUND, correctly, and the benchmark scored it as an invalid request that
    # succeeded. The bug was ours. Unique bytes make the MD5 unique, and the
    # registry is keyed on the MD5.
    never_submitted = work_dir / "never-submitted.mp4"
    if video.is_file():
        never_submitted.write_bytes(
            video.read_bytes() + uuid.uuid4().bytes + b"never-submitted"
        )
    else:  # pragma: no cover - the fixture is a precondition of the run
        never_submitted.write_bytes(uuid.uuid4().bytes)

    cases: list[tuple[str, str, str, dict[str, Any]]] = [
        ("no_source", "neither video_path nor video_url",
         "process_video", {"output_path": str(work_dir)}),
        ("both_sources", "both a path and a URL",
         "process_video", {"output_path": str(work_dir), "video_path": str(video),
                           "video_url": "https://example.com/a.mp4"}),
        ("missing_file", "a local path that does not exist",
         "process_video", {"output_path": str(work_dir), "video_path": str(missing)}),
        ("empty_file", "a zero-byte file",
         "process_video", {"output_path": str(work_dir), "video_path": str(empty)}),
        ("malformed_input", "a text file named .mp4",
         "process_video", {"output_path": str(work_dir), "video_path": str(not_a_video)}),
        ("malformed_url", "a URL that is not HTTP(S)",
         "process_video", {"output_path": str(work_dir), "video_url": "notaurl"}),
        ("private_host_url", "a URL pointing at a private address",
         "process_video", {"output_path": str(work_dir),
                           "video_url": "http://127.0.0.1/video.mp4"}),
        ("bad_timestamp", "a timestamp that is not a time",
         "process_video", {"output_path": str(work_dir), "video_path": str(video),
                           "timestamps": ["banana"]}),
        ("duplicate_timestamps", "the same timestamp twice",
         "process_video", {"output_path": str(work_dir), "video_path": str(video),
                           "timestamps": ["1.0", "1.0"]}),
        ("timestamp_past_end", "a timestamp beyond the video duration",
         "process_video", {"output_path": str(work_dir), "video_path": str(video),
                           "timestamps": ["9999"]}),
        ("inverted_window", "end_time earlier than start_time",
         "process_video", {"output_path": str(work_dir), "video_path": str(video),
                           "start_time": "5", "end_time": "2"}),
        ("timestamps_without_output", "exact frames with nowhere to put them",
         "process_video", {"output_path": "", "video_path": str(video),
                           "timestamps": ["1.0"]}),
        ("unknown_job_status", "status for a request_id that was never issued",
         "check_video_status", {"request_id": "00000000-0000-0000-0000-000000000000"}),
        ("artifact_before_submit", "frames for a job that does not exist",
         "extract_frames", {"request_id": "00000000-0000-0000-0000-000000000000",
                            "output_path": str(work_dir)}),
        ("transcript_before_submit", "a transcript for a job that does not exist",
         "transcribe", {"request_id": "00000000-0000-0000-0000-000000000000",
                        "output_path": str(work_dir)}),
        ("artifact_no_output_path", "an artifact request with no output_path",
         "extract_frames", {"request_id": "00000000-0000-0000-0000-000000000000",
                            "output_path": ""}),
        ("request_id_unknown_video", "the handle for a video never submitted",
         "get_request_id", {"video_path": str(never_submitted)}),
    ]

    probes: list[FailureProbe] = []
    for name, intent, tool, arguments in cases:
        record = adapter.call(tool, arguments)
        probes.append(FailureProbe(
            name=name,
            intent=intent,
            tool=tool,
            arguments=record.arguments,
            status=record.status.value,
            latency_seconds=record.latency_seconds,
            message_excerpt=(record.message_excerpt or record.error or "")[:400],
            classified=record.status is not OutcomeStatus.UNKNOWN,
        ))
    return probes


# --- the local baseline -----------------------------------------------------


def run_watch_skill_baseline(
    video: Path, fixture: dict[str, Any], work_dir: Path
) -> dict[str, Any]:
    """Score Watch Skill's own extractor on the same probes, same scorer.

    A fair comparison, and a narrow one: this is the pinned-cue path, which is
    the local analogue of "give me a frame at exactly T". It says nothing
    about scene selection, OCR or transcription, and the report must not let
    it imply otherwise.
    """
    from watch_skill.bench.video_backends.types import BackendFrame, TimestampSemantics
    from watch_skill.perceive import perceive

    truth = VisualTruth.from_manifest(fixture)
    band = fixture["identity_band"]
    probes = [float(t) for t in fixture["probe_timestamps"]]
    out = work_dir / "baseline"
    out.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    result = perceive(
        video, out, cue_timestamps=probes, run_ocr=False,
        max_frames=len(probes) * 4,
    )
    elapsed = time.perf_counter() - started

    cue_frames = [f for f in result.frames if f.reason == "cue"]
    judgements: list[FrameJudgement] = []
    for frame in cue_frames:
        measured = measure_image(frame.path, band)
        color, phash = measured if measured else (None, None)
        judgements.append(judge_frame(
            BackendFrame(
                index=frame.index,
                timestamp_seconds=frame.timestamp_seconds,
                path=frame.path,
                provider_id=frame.path.name,
                semantics=TimestampSemantics.REQUESTED,
                requested_seconds=frame.timestamp_seconds,
            ),
            truth, measured_color=color, phash=phash,
        ))

    resolved = frame_resolved(judgements)
    return {
        "engine": "watch-skill perceive (pinned cue frames)",
        "wall_seconds": round(elapsed, 3),
        "probes": len(probes),
        "cue_frames": len(cue_frames),
        "total_frames": len(result.frames),
        "identity": frame_identity_report(judgements).to_dict(),
        "thresholds": [row.to_dict() for row in threshold_report(judgements)],
        "frame_resolved_count": len(resolved),
        "frame_resolved_stats": (
            TimingStats.from_signed(
                [j.signed_estimate for j in resolved if j.signed_estimate is not None]
            ).to_dict() if resolved else None
        ),
        "judgements": [j.to_dict() for j in judgements],
        "note": (
            "Same fixture, same probes, same scorer. Watch Skill scales frames to "
            "512 px wide and re-encodes as JPEG, which the identity band survives; "
            "the provider's frames are full size."
        ),
    }


# --- real footage -----------------------------------------------------------


def run_real_media(
    adapter: Any,
    *,
    label: str,
    reference: Path,
    submit_source: str | Path,
    is_url: bool,
    work_dir: Path,
    probe_count: int = 30,
) -> dict[str, Any]:
    """Measure the exact-timestamp path against a real video.

    Nothing was authored about this footage, so "correct frame" is not a
    question anyone can answer. What is answerable, and what actually matters
    for evidence, is *which frame of this file came back* — established by
    decoding the neighbourhood around each probe and locating the returned
    image inside it.

    For a URL submission the provider fetches its own copy. The reference here
    is ours, obtained with the provider's own format selector; how often the
    two come back byte-identical is itself a finding about whether a URL
    submission is reproducible.
    """
    from watch_skill.bench.video_backends.realmedia import (
        WINDOW_SECONDS,
        RealMediaResult,
        build_probes,
        decode_window,
        describe_media,
        localize,
    )

    media = describe_media(reference)
    probes = build_probes(media, count=probe_count)
    out = work_dir / f"real_{label}"

    # The control. Watch Skill's own extractor, same file, same times, same
    # machine — run first so a provider stall cannot be blamed on a loaded
    # box, a slow codec, or this particular ffmpeg build. Without it, "the
    # provider hung" and "this machine cannot decode AV1 quickly" look
    # identical from the outside.
    control = _local_control(
        reference, probes, work_dir / f"control_{label}",
        width=int(media.get("width") or 1920),
    )

    started = time.perf_counter()
    outcome: Outcome = adapter.submit(
        Path(submit_source) if not is_url else reference,
        output_dir=out,
        timestamps=probes,
        video_url=str(submit_source) if is_url else None,
    )
    elapsed = time.perf_counter() - started

    returned = [
        frame for frame in outcome.frames if frame.requested_seconds is not None
    ]

    def frame_for(probe: float):
        """The frame returned for this probe, matched within a millisecond.

        The provider echoes the requested time through a filename in whole
        milliseconds, so an exact float key would miss by a rounding step and
        report a delivered frame as never delivered — a harness bug that reads
        exactly like a provider failure. Matching within half a millisecond
        cannot collide: the probe list is itself on whole milliseconds.
        """
        for candidate in returned:
            if abs(candidate.requested_seconds - probe) <= 0.0005:
                return candidate
        return None

    localizations: list[dict[str, Any]] = []
    control_localizations: list[dict[str, Any]] = []
    window_dir = work_dir / f"windows_{label}"
    for index, probe in enumerate(probes):
        frame = frame_for(probe)
        control_frame = control["paths"].get(probe)
        have_provider = frame is not None and frame.path is not None and frame.path.is_file()
        if not have_provider:
            localizations.append({
                "probe": probe, "matched": False, "note": "no frame returned for this probe",
                "exact_byte_match": False, "ambiguous": False,
            })
        if not have_provider and control_frame is None:
            continue

        window = decode_window(
            reference,
            max(0.0, probe - WINDOW_SECONDS),
            min(media["duration_seconds"], probe + WINDOW_SECONDS),
            window_dir / f"p{index:03d}",
            tag="w",
        )
        if have_provider:
            localizations.append(localize(frame.path, window, probe).to_dict())
        # The control is graded against the same decoded window, so any
        # difference between the two is about the extractors and not about
        # two different notions of what the file contains.
        if control_frame is not None:
            control_localizations.append(localize(control_frame, window, probe).to_dict())
        # Reference frames are a decoded copy of copyrighted footage. They
        # exist for the length of one comparison and are removed immediately;
        # nothing derived from them beyond a timestamp leaves this function.
        for ref in window:
            ref.path.unlink(missing_ok=True)

    result = RealMediaResult(
        label=label,
        source=str(submit_source) if is_url else reference.name,
        source_kind="url" if is_url else "local file",
        media={k: v for k, v in media.items() if k != "md5"},
        probes=probes,
        status=outcome.status.value,
        frames_returned=len(outcome.frames),
        wall_seconds=round(elapsed, 3),
        localizations=localizations,
        detail=outcome.detail[:400],
    )
    result.summary = summarize_real_media(localizations, media)
    payload = result.to_dict()
    payload["control"] = {
        **{k: v for k, v in control.items() if k != "paths"},
        "summary": summarize_real_media(control_localizations, media),
    }
    # The frames themselves are not ours to keep.
    _purge(out)
    _purge(window_dir)
    _purge(work_dir / f"control_{label}")
    return payload


def _local_control(
    reference: Path, probes: list[float], out_dir: Path, *, width: int
) -> dict[str, Any]:
    """Extract the same timestamps with Watch Skill's own extractor.

    Deliberately the real function the product uses, not a hand-rolled ffmpeg
    line: if the local path had the same weakness, this is where it would show
    up rather than being argued about.
    """
    from watch_skill.perceive.media import extract_frame_at

    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    produced: dict[float, Path] = {}
    failures = 0
    for index, probe in enumerate(probes):
        destination = out_dir / f"control_{index:03d}.jpg"
        try:
            # Native width: a scaled frame still localizes, but keeping the
            # source size makes the comparison against the provider's frames
            # one fewer variable. Watch Skill still writes at its own -q:v 4,
            # so these will not be byte-identical to the reference window and
            # are localized by pixel comparison instead.
            result = extract_frame_at(reference, probe, destination, width=width)
        except Exception:  # noqa: BLE001 — a failed extraction is a result
            result = None
        if result is None or not destination.is_file():
            failures += 1
            continue
        produced[probe] = destination
    return {
        "engine": "watch-skill perceive.media.extract_frame_at",
        "requested": len(probes),
        "returned": len(produced),
        "failed": failures,
        "wall_seconds": round(time.perf_counter() - started, 3),
        "paths": produced,
    }


def _purge(directory: Path) -> None:
    import shutil

    shutil.rmtree(directory, ignore_errors=True)


def summarize_real_media(
    localizations: list[dict[str, Any]], media: dict[str, Any]
) -> dict[str, Any]:
    """Aggregate the localizations, keeping the ambiguous ones apart."""
    matched = [loc for loc in localizations if loc.get("matched")]
    exact = [loc for loc in matched if loc.get("exact_byte_match")]
    ambiguous = [loc for loc in matched if loc.get("ambiguous")]
    resolved = [
        loc for loc in matched
        if not loc.get("ambiguous") and loc.get("signed_estimate") is not None
    ]

    fps = media.get("avg_frame_rate") or 25.0
    period = 1.0 / fps
    late = [loc for loc in resolved if loc["signed_estimate"] > 1e-6]
    early = [loc for loc in resolved if loc["signed_estimate"] < -1e-6]
    on_time = [loc for loc in resolved if abs(loc["signed_estimate"]) <= 1e-6]
    ceiling = [
        loc for loc in resolved
        if 0 <= loc["signed_estimate"] < period + 1e-6
    ]

    stats = (
        TimingStats.from_signed([loc["signed_estimate"] for loc in resolved]).to_dict()
        if resolved else None
    )
    thresholds = []
    for threshold in (20, 50, 100, 250, 500, 1000):
        limit = threshold / 1000.0
        within = sum(
            1 for loc in matched
            if loc.get("abs_upper_bound") is not None
            and loc["abs_upper_bound"] <= limit
        )
        outside = sum(
            1 for loc in matched
            if loc.get("abs_lower_bound") is not None
            and loc["abs_lower_bound"] > limit
        )
        thresholds.append({
            "threshold_ms": threshold, "within": within, "outside": outside,
            "indeterminate": len(localizations) - within - outside,
            "total": len(localizations),
        })

    return {
        "probes": len(localizations),
        "returned": len(matched),
        "not_returned": len(localizations) - len(matched),
        "localized_byte_exact": len(exact),
        "ambiguous_still_shot": len(ambiguous),
        "resolved": len(resolved),
        "frame_period_seconds": round(period, 6),
        "signed_stats": stats,
        "thresholds": thresholds,
        "direction": {
            "late": len(late), "early": len(early), "exact": len(on_time),
            "within_one_frame_and_never_early": len(ceiling),
        },
        "rule_holds": bool(resolved) and len(ceiling) == len(resolved),
        "note": (
            "Ground truth is derived from the file itself: the window around each "
            "probe is decoded by presentation time and the returned image located "
            "inside it. Probes on a still shot cannot be localized to one frame and "
            "are reported as ambiguous rather than resolved to the nearest."
        ),
    }


# --- evidence compatibility -------------------------------------------------


def evidence_matrix(observations: dict[str, Any]) -> list[dict[str, str]]:
    """Phase 10, answered from what this run actually saw.

    "Native" is reserved for a value the backend hands over as a typed field.
    A number a human could read out of an English sentence is *derivable with
    assumptions* at best, because the assumption is that the sentence keeps
    its wording — and prose is not an interface contract.
    """
    frames_ok = observations.get("frames_measured", False)
    pipeline_ok = observations.get("pipeline_completed", False)
    # Only reached when the pipeline did not complete in *this* run. The
    # published evaluation did complete it, so none of these fire there.
    unverified = "not measured in this run — no completed backend job"

    rows = [
        ("source identity", "derivable without ambiguity",
         "We supply the path; the backend echoes nothing that contradicts it. "
         "Watch Skill's source_alias is ours to keep either way."),
        ("content identity", "derivable with assumptions",
         "0.1.4 keys its local registry on MD5 and prints it as `hash:` inside a "
         "prose reply. Recoverable by regex, not offered as a field — and MD5 is "
         "not the sha256 Watch Skill's revisions are keyed by."),
        ("stable video identity", "derivable with assumptions",
         "request_id is stable per submission and parseable from the reply, but it "
         "identifies a *job*, not the content; the same bytes submitted after the "
         "registry is cleared get a new one."),
        ("frame timestamp",
         "native" if frames_ok else unverified,
         "For the exact-timestamp path the only time present is the one we asked "
         "for, encoded in the filename as `frame-003-15010ms.jpg` — the requested "
         "time rather than the decoded presentation time, which the provider "
         "never states."),
        ("frame artifact", "native" if frames_ok else unverified,
         "Real JPEG files on disk at a path we chose."),
        ("frame identity", "derivable without ambiguity" if frames_ok else unverified,
         "The image is a real frame from the source and was measurable against "
         "ground truth."),
        ("transcript", unverified if not pipeline_ok else "native",
         "`transcript.json` is a JSON list of `{start, end, text}`. The text came "
         "back verbatim — 0% word error over the fixture's known script."
         if pipeline_ok else "`transcribe` needs a completed backend job."),
        ("transcript interval",
         unverified if not pipeline_ok else "derivable without ambiguity",
         "Present, but as `\"00:00:04\"` clock strings quantised to whole "
         "seconds — parseable without guesswork, though a second is the finest "
         "citation the transcript can support."
         if pipeline_ok else
         "transcript.json's schema could not be observed without a session."),
        ("transcript source", "unavailable",
         "Nothing in `transcript.json` says whether a transcript came from "
         "embedded captions or from speech recognition. For this fixture it can "
         "only be recognition — the file carries no caption track — but that is "
         "our deduction about the source, not the provider's statement."),
        ("ordering", "derivable without ambiguity" if frames_ok else unverified,
         "Filenames carry a zero-padded ordinal and the requested millisecond, so "
         "a stable order exists without trusting directory listing order."),
        ("provenance", "derivable with assumptions",
         "The provider version is not exposed over MCP — the handshake reports the "
         "FastMCP framework's version. It has to come from package metadata on the "
         "machine, which is provenance about our install, not about their pipeline."),
        ("provider-native IDs", "derivable with assumptions",
         "request_id appears only inside prose and is recovered by regex."),
        ("durable references", "unavailable",
         "Artifacts are files written into a directory we name. Nothing is "
         "addressable after the fact except by re-downloading with request_id, and "
         "the reply carries no checksum for what was written."),
        ("stale-source protection", "unavailable",
         "The backend dedupes on MD5 of the bytes, which is sound, but nothing in "
         "the output lets a caller revalidate later: no ETag, no digest of the "
         "artifact, no content-addressed handle. Watch Skill's Freshness cannot be "
         "established from a reply."),
        ("hashes / checksums", "derivable with assumptions",
         "MD5 of the source, in prose. No digest of any returned artifact."),
        ("confidence", "unavailable",
         "Nothing in 0.1.4's surface exposes a confidence for a frame, a cue or an "
         "OCR read."),
        ("repeatability", "derivable without ambiguity" if frames_ok else unverified,
         "The exact-timestamp path was run repeatedly and compared field by field."),
    ]
    return [
        {"requirement": name, "classification": classification, "basis": basis}
        for name, classification, basis in rows
    ]


# --- top level --------------------------------------------------------------


def run_benchmark(
    fixtures_dir: Path,
    adapter: Any,
    *,
    work_dir: Path,
    repeats: int = 3,
    include_baseline: bool = True,
    include_failures: bool = True,
    fixture_name: str = "visual_events",
    poll_attempts: int = 0,
    real_media: list[Path] | None = None,
    real_media_urls: list[str] | None = None,
    real_media_probes: int = 30,
    analysis_documents: dict[str, str] | None = None,
) -> BenchmarkResult:
    """Run every phase that can run, and record what could not."""
    manifest = load_manifest(fixtures_dir)
    fixture = manifest["fixtures"][fixture_name]
    video = (fixtures_dir / fixture["file"]).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)

    result = BenchmarkResult(
        started_at=datetime.now(UTC).isoformat(timespec="seconds"),
        environment=environment_summary(),
        backend=adapter.describe().to_dict(),
    )
    quota_before: str | None = None
    if hasattr(adapter, "quota"):
        try:
            quota_before = adapter.quota().detail
        except Exception:  # noqa: BLE001 — no quota reading is a result
            quota_before = None

    result.fixture = {
        "name": fixture_name,
        **verify_fixture(fixtures_dir, fixture),
        "properties": fixture.get("properties", []),
        "probe_count": len(fixture["probe_timestamps"]),
        "occurrences": len(fixture["occurrences"]),
        "events": len(fixture["events"]),
    }
    if not result.fixture.get("matches_manifest"):
        result.not_measured.append({
            "path": "everything",
            "reason": "the fixture on disk does not match the committed ground truth",
        })
        result.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
        return result

    # --- frames -------------------------------------------------------------
    result.frame_runs = run_frame_probes(
        adapter, video, fixture, work_dir, repeats=repeats
    )
    first = result.frame_runs[0] if result.frame_runs else None
    if first and first.judgements:
        expected_ids = sorted({
            j.expected_event_id for j in first.judgements if j.expected_event_id
        })
        result.frame_identity = frame_identity_report(
            first.judgements,
            expected_event_ids=expected_ids,
            file_digests=first.file_digests,
        ).to_dict()
        result.frame_identity["note"] = (
            "duplicate_identities counts probes that legitimately share an event: "
            "several requested times fall inside one occurrence by design. The "
            "signal for an actually repeated frame is exact_duplicate_files."
        )
        result.frame_thresholds = [
            row.to_dict() for row in threshold_report(first.judgements)
        ]
        resolved = frame_resolved(first.judgements)
        result.frame_resolved_count = len(resolved)
        result.timestamp_semantics = timestamp_semantics_finding(
            first.judgements, int(fixture["fps"])
        )
        if resolved:
            result.frame_resolved_stats = TimingStats.from_signed(
                [j.signed_estimate for j in resolved if j.signed_estimate is not None]
            ).to_dict()

        from watch_skill.bench.video_backends.types import BackendFrame, TimestampSemantics

        ordered = [
            BackendFrame(
                index=j.index,
                timestamp_seconds=j.reported_seconds,
                requested_seconds=j.requested_seconds,
                semantics=TimestampSemantics.REQUESTED,
            )
            for j in first.judgements
        ]
        result.ordering = ordering_report(ordered, first.judgements).to_dict()

    if len(result.frame_runs) > 1:
        result.repeatability = repeatability_report(
            [
                {
                    "frames": [
                        {
                            "index": j.index,
                            "timestamp_seconds": j.reported_seconds,
                            "actual_event_id": j.actual_event_id,
                        }
                        for j in run.judgements
                    ],
                    "cues": [],
                }
                for run in result.frame_runs
            ],
            volatile_fields=VOLATILE_FIELDS,
        ).to_dict()
        result.repeatability["byte_identical_across_runs"] = _digests_match(
            result.frame_runs
        )

    # --- pipeline -----------------------------------------------------------
    # The visual fixture carries the frame ground truth; the speech fixture
    # carries the transcript ground truth. Both go through the backend, because
    # scoring a transcript against a video with no speech in it would measure
    # nothing. The backend runs one evaluation per account at a time, so these
    # are deliberately sequential.
    result.pipeline, _ = run_pipeline(
        adapter, video, fixture, work_dir, poll_attempts=poll_attempts
    )
    speech = manifest["fixtures"].get("speech_events")
    if speech is not None and poll_attempts:
        speech_video = (fixtures_dir / speech["file"]).resolve()
        if speech_video.is_file():
            speech_record, result.transcript = run_pipeline(
                adapter, speech_video, speech, work_dir / "speech",
                poll_attempts=poll_attempts,
            )
            result.pipeline["speech"] = speech_record
        else:
            result.not_measured.append({
                "path": "transcript accuracy",
                "reason": "the speech fixture is not present — regenerate the fixtures",
            })
    if not result.pipeline.get("completed"):
        stage = result.pipeline["stages"][0]
        result.not_measured.append({
            "path": "backend pipeline (analyze / extract_frames / transcribe)",
            "reason": f"submit returned {stage['status']}",
        })
        result.not_measured.append({
            "path": "provider-chosen key frames and frames.json schema",
            "reason": "no completed job to download frames from",
        })
    if result.transcript is None:
        result.not_measured.append({
            "path": "transcript accuracy and cue timing",
            "reason": (
                "the speech fixture was not run through the backend — pass --poll "
                "to let a submitted job finish"
            ),
        })

    # --- failures -----------------------------------------------------------
    if include_failures:
        result.failures = failure_probes(adapter, video, work_dir / "failures")

    # --- latency ------------------------------------------------------------
    duration = fixture["media"]["duration_seconds"]
    frame_walls = [run.wall_seconds for run in result.frame_runs]
    result.latency = {
        "video_duration_seconds": duration,
        "exact_frame_path_wall_seconds": frame_walls,
        "exact_frame_path_median": (
            round(sorted(frame_walls)[len(frame_walls) // 2], 3) if frame_walls else None
        ),
        "frames_requested": result.fixture["probe_count"],
        "realtime_factor": (
            round(sorted(frame_walls)[len(frame_walls) // 2] / duration, 3)
            if frame_walls and duration else None
        ),
        "mcp_calls": sum(len(run.judgements) > 0 for run in result.frame_runs)
        + len(result.failures) + len(result.pipeline.get("stages", [])),
        "note": (
            "One MCP subprocess per call, so every call includes process start-up. "
            "The exact-frame path runs ffmpeg locally once per requested timestamp."
        ),
    }
    # Filled in below from the provider's own quota readings once the
    # head-to-head stage has taken them. It was previously hardcoded to zero
    # with the note "no job reached the backend", which was true of an early
    # unauthenticated run and false of every run since — the report kept
    # printing it regardless of what the provider had actually billed.
    result.usage = {
        "measured": None,
        "provider_reported": None,
        "documented_pricing": None,
        "inferred": None,
    }

    # --- real footage -------------------------------------------------------
    for path in real_media or []:
        label = path.stem
        try:
            result.real_media.append(run_real_media(
                adapter, label=label, reference=path, submit_source=path,
                is_url=False, work_dir=work_dir, probe_count=real_media_probes,
            ))
        except Exception as exc:  # noqa: BLE001 — a failed sample is a result
            result.real_media.append({
                "label": label, "source_kind": "local file",
                "error": f"{type(exc).__name__}: {exc}"[:300],
            })

    for url in real_media_urls or []:
        # A URL submission makes the provider fetch its own copy, so a local
        # reference obtained the same way has to be supplied alongside it —
        # and it has to be the reference for *this* URL. Pairing by stem is
        # what makes passing two videos and one URL unambiguous; guessing
        # would silently localize one video's frames against another's.
        reference = next(
            (path for path in (real_media or []) if path.stem and path.stem in url),
            None,
        )
        if reference is None:
            result.not_measured.append({
                "path": f"URL acquisition for {url}",
                "reason": "no --real-media reference whose name appears in the URL, "
                          "so returned frames could not be localized",
            })
            continue
        try:
            result.real_media.append(run_real_media(
                adapter, label=f"url_{reference.stem}", reference=reference,
                submit_source=url, is_url=True, work_dir=work_dir,
                probe_count=max(6, real_media_probes // 5),
            ))
        except Exception as exc:  # noqa: BLE001
            result.real_media.append({
                "label": f"url_{reference.stem}", "source_kind": "url",
                "error": f"{type(exc).__name__}: {exc}"[:300],
            })

    # --- head to head -------------------------------------------------------
    # Everything the report compares side by side is measured here, so every
    # number in it is reproducible from this command rather than from a script
    # somebody ran once.
    from watch_skill.bench.video_backends import comparison as vb_comparison

    speech_fixture = manifest["fixtures"].get("speech_events")
    if speech_fixture is not None:
        speech_video = (fixtures_dir / speech_fixture["file"]).resolve()
        if speech_video.is_file():
            result.head_to_head["transcript"] = vb_comparison.watch_skill_transcript(
                speech_video, speech_fixture["cues"], work_dir / "ws_transcript"
            )

    analyses: list[dict[str, Any]] = []
    for source, document in (analysis_documents or {}).items():
        video_id = _indexed_id(source)
        analyses.append(vb_comparison.compare_written_analysis(
            provider_document=Path(document) if document else None,
            watch_skill_video_id=video_id,
            label=Path(source).name,
        ))
    if analyses:
        result.head_to_head["written_analysis"] = analyses

    if quota_before is not None:
        after = adapter.quota()
        usage = vb_comparison.reconcile_usage(quota_before, after.detail)
        result.head_to_head["usage"] = usage
        # The cost table reads from here. Every figure is the provider's own —
        # its quota readings and its own job registry — so "measured" means
        # measured, and the three speculative columns stay empty unless
        # something real fills them.
        result.usage["measured"] = {
            "provider_billed_minutes_this_run": usage.get("this_run_billed_minutes"),
            "provider_billed_minutes_lifetime": usage.get("lifetime_billed_minutes"),
            "source_minutes_submitted_lifetime": usage.get(
                "lifetime_submitted_minutes"
            ),
            "per_job_rounding_minutes": usage.get("rounding_overhead_minutes"),
            "jobs_in_provider_registry": usage.get("jobs_in_registry"),
            "remaining_minutes": usage.get("remaining_after"),
        }
        result.usage["provider_reported"] = (
            "quota endpoint: "
            f"{usage.get('lifetime_billed_minutes')} minutes used, "
            f"{usage.get('remaining_after')} remaining"
        )

    # --- baseline -----------------------------------------------------------
    if include_baseline:
        try:
            result.baseline = run_watch_skill_baseline(video, fixture, work_dir)
        except Exception as exc:  # noqa: BLE001 — a missing baseline is a result
            result.baseline = {"error": f"{type(exc).__name__}: {exc}"[:300]}

    result.comparison = [
        axis.to_dict() for axis in vb_comparison.build_axes(result.to_dict())
    ]
    result.finished_at = datetime.now(UTC).isoformat(timespec="seconds")
    return result


def _digests_match(runs: list[FrameProbeRun]) -> bool | None:
    """Whether every run produced byte-identical images for the same probe."""
    populated = [run for run in runs if run.file_digests]
    if len(populated) < 2:
        return None
    first = populated[0].file_digests
    return all(run.file_digests == first for run in populated[1:])


def write_raw(result: BenchmarkResult, destination: Path) -> Path:
    """Write the sanitized machine-readable record every number comes from."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = sanitize(result.to_dict())
    destination.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return destination
