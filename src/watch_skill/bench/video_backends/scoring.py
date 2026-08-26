"""Deterministic scoring for external video backends.

Every number a report prints comes from this module, and every function here
is pure: ground truth in, metrics out, no clock, no network, no provider. A
result stays reproducible from the raw JSON months later, and a future
direct-API adapter can be graded by the same code without a line changing.

Two conventions run through all of it.

**A frame's identity is measured, not asserted.** The fixtures encode each
visual event as a flat colour band, so "is this the right frame" is answered
by reading pixels, not by trusting a filename or a returned timestamp.

**Resolution is never overstated.** Identifying a frame as ``EVENT_002``
places it inside that occurrence's interval — 2.5 seconds wide — and no
amount of arithmetic turns that into a millisecond. So the error of every
probe is carried as an interval with a stated uncertainty, and the fixture
carries a 25-frame ladder where that uncertainty collapses to half a frame
period. The ladder is where the precise timing numbers come from; everywhere
else the report says how wide the bound was.
"""
from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from watch_skill.bench.video_backends.types import BackendCue, BackendFrame

# Thresholds chosen from the fixture's 20 ms frame period, before any result
# was seen: one frame, two and a half frames, five, twelve and a half, and
# fifty. A threshold invented after the fact to make a number look good is
# not a threshold.
DEFAULT_THRESHOLDS_MS: tuple[int, ...] = (20, 50, 100, 250, 500, 1000)

# Half the smallest gap between two fixture colours that are meant to be
# distinguishable. Above this a frame is called unidentified rather than
# guessed at.
DEFAULT_COLOR_TOLERANCE = 6.0


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile — no interpolation, no numpy, no surprises.

    The p-th percentile is the value at rank ``ceil(p/100 * n)``. Chosen over
    linear interpolation because an interpolated p95 of eleven samples is a
    number that appears in no measurement, and this benchmark is meant to be
    checkable by hand against the raw rows.
    """
    if not values:
        return math.nan
    ordered = sorted(values)
    rank = max(1, math.ceil((pct / 100.0) * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


@dataclass
class TimingStats:
    """The spread of a set of errors, in seconds."""

    count: int
    signed_mean: float
    mean_abs: float
    median_abs: float
    p95_abs: float
    max_abs: float
    min_abs: float

    @classmethod
    def from_signed(cls, errors: list[float]) -> TimingStats:
        if not errors:
            return cls(0, math.nan, math.nan, math.nan, math.nan, math.nan, math.nan)
        absolute = [abs(e) for e in errors]
        return cls(
            count=len(errors),
            signed_mean=round(sum(errors) / len(errors), 6),
            mean_abs=round(sum(absolute) / len(absolute), 6),
            median_abs=round(percentile(absolute, 50), 6),
            p95_abs=round(percentile(absolute, 95), 6),
            max_abs=round(max(absolute), 6),
            min_abs=round(min(absolute), 6),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ThresholdRow:
    """One threshold, answered three ways rather than two.

    A probe whose error is bounded to "somewhere in [0, 2.5) s" is neither
    inside 100 ms nor outside it. Counting it either way would be a guess, so
    it is counted as indeterminate and the report shows that column.
    """

    threshold_ms: int
    within: int
    outside: int
    indeterminate: int

    @property
    def total(self) -> int:
        return self.within + self.outside + self.indeterminate

    @property
    def within_rate(self) -> float:
        return self.within / self.total if self.total else math.nan

    def to_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "total": self.total,
            "within_rate": round(self.within_rate, 4) if self.total else None,
        }


class FrameVerdict(str, Enum):  # noqa: UP042
    """What the returned image turned out to be."""

    CORRECT = "correct"
    """The image is the event that was on screen at the reference time."""

    NEAR_NEIGHBOUR = "near_neighbour"
    """The image is the immediately adjacent occurrence — off by one cut."""

    WRONG_EVENT = "wrong_event"
    """The image is some other event entirely."""

    UNIDENTIFIED = "unidentified"
    """No fixture colour is close enough to call. Never silently 'wrong'."""

    NO_IMAGE = "no_image"
    """The backend named a frame it did not deliver."""


@dataclass
class FrameJudgement:
    """One returned frame, graded."""

    index: int
    requested_seconds: float | None
    reported_seconds: float | None
    expected_event_id: str | None
    actual_event_id: str | None
    verdict: FrameVerdict
    color_drift: float | None
    actual_interval: tuple[float, float] | None
    signed_error_lo: float | None
    signed_error_hi: float | None
    phash_event_id: str | None = None
    phash_distance: int | None = None
    ocr_event_id: str | None = None
    path: str | None = None

    @property
    def signed_estimate(self) -> float | None:
        """Midpoint of the error interval — a point estimate with a stated
        uncertainty, never a number pretending to be exact."""
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round((self.signed_error_lo + self.signed_error_hi) / 2, 6)

    @property
    def uncertainty(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round((self.signed_error_hi - self.signed_error_lo) / 2, 6)

    @property
    def abs_lower_bound(self) -> float | None:
        """The smallest |error| consistent with what was measured."""
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        if self.signed_error_lo <= 0 <= self.signed_error_hi:
            return 0.0
        return round(min(abs(self.signed_error_lo), abs(self.signed_error_hi)), 6)

    @property
    def abs_upper_bound(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round(max(abs(self.signed_error_lo), abs(self.signed_error_hi)), 6)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["verdict"] = self.verdict.value
        data["signed_estimate"] = self.signed_estimate
        data["uncertainty"] = self.uncertainty
        data["abs_lower_bound"] = self.abs_lower_bound
        data["abs_upper_bound"] = self.abs_upper_bound
        return data


# --- ground truth access ----------------------------------------------------


@dataclass
class VisualTruth:
    """The visual fixture's ground truth, in the shape the scorer needs."""

    events: dict[str, dict[str, Any]]
    occurrences: list[dict[str, Any]]
    fps: int
    duration: float

    @classmethod
    def from_manifest(cls, fixture: dict[str, Any]) -> VisualTruth:
        return cls(
            events=fixture["events"],
            occurrences=fixture["occurrences"],
            fps=int(fixture["fps"]),
            duration=float(fixture["media"]["duration_seconds"]),
        )

    @property
    def frame_period(self) -> float:
        return 1.0 / self.fps

    def occurrence_at(self, seconds: float) -> dict[str, Any] | None:
        """The occurrence whose display interval contains `seconds`."""
        for occurrence in self.occurrences:
            if occurrence["start"] <= seconds < occurrence["end"]:
                return occurrence
        return None

    def occurrences_of(self, event_id: str) -> list[dict[str, Any]]:
        return [o for o in self.occurrences if o["event_id"] == event_id]

    def nearest_occurrence_of(
        self, event_id: str, reference: float | None
    ) -> dict[str, Any] | None:
        """Which appearance of a repeated event a frame most likely came from.

        Deliberately charitable: an event that appears twice is attributed to
        whichever occurrence sits closer to the time under test. That can only
        make the measured error smaller, so a bad result under this rule is a
        bad result under any rule.
        """
        candidates = self.occurrences_of(event_id)
        if not candidates:
            return None
        if reference is None or len(candidates) == 1:
            return candidates[0]

        def distance(occurrence: dict[str, Any]) -> float:
            if occurrence["start"] <= reference < occurrence["end"]:
                return 0.0
            return min(
                abs(occurrence["start"] - reference), abs(occurrence["end"] - reference)
            )

        return min(candidates, key=distance)

    def index_of(self, occurrence: dict[str, Any]) -> int:
        return self.occurrences.index(occurrence)


# --- identity measurement ---------------------------------------------------


def identify_by_color(
    measured: tuple[float, float, float],
    events: dict[str, dict[str, Any]],
    tolerance: float = DEFAULT_COLOR_TOLERANCE,
) -> tuple[str | None, float]:
    """Nearest fixture colour, or nothing if none is close enough.

    Returns ``(event_id, max_channel_drift)``. Beyond `tolerance` the answer
    is ``None``: an unidentifiable frame is a finding in its own right and
    must not be rounded into the nearest event.
    """
    best_id: str | None = None
    best_drift = math.inf
    for event_id, event in events.items():
        expected = event["color"]
        drift = max(abs(m - e) for m, e in zip(measured, expected, strict=True))
        if drift < best_drift:
            best_id, best_drift = event_id, drift
    if best_drift > tolerance:
        return None, round(best_drift, 3)
    return best_id, round(best_drift, 3)


def hamming(hash_a: str, hash_b: str) -> int:
    """Bit distance between two hex perceptual hashes of equal width."""
    if len(hash_a) != len(hash_b):
        raise ValueError("perceptual hashes must be the same width")
    return bin(int(hash_a, 16) ^ int(hash_b, 16)).count("1")


def identify_by_phash(
    phash: str, events: dict[str, dict[str, Any]]
) -> tuple[str | None, int]:
    """Nearest fixture card by perceptual hash — the independent cross-check.

    Kept separate from the colour reading on purpose: two methods that agree
    are evidence, and two that disagree are a finding the report should carry
    rather than a tie the scorer quietly breaks.
    """
    best_id: str | None = None
    best_distance = 10**9
    for event_id, event in events.items():
        reference = event.get("phash")
        if not reference:
            continue
        try:
            distance = hamming(phash, reference)
        except ValueError:
            continue
        if distance < best_distance:
            best_id, best_distance = event_id, distance
    return best_id, best_distance


_LABEL_RE = re.compile(r"\b((?:EVENT|LADDER|SPEAKING|SILENCE)[_A-Z0-9]*)\b")


def identify_by_ocr(text: str | None, events: dict[str, dict[str, Any]]) -> str | None:
    """Read the card's printed label, when the provider gave us OCR text.

    A third opinion, never the deciding one. OCR is the identity channel a
    provider is most likely to have altered, resized or dropped, so a result
    that rested on it would be measuring their OCR rather than their frames.
    """
    if not text:
        return None
    labels = {event.get("label"): event_id for event_id, event in events.items()}
    for candidate in _LABEL_RE.findall(text.upper()):
        if candidate in labels:
            return labels[candidate]
    return None


# --- frame grading ----------------------------------------------------------


def judge_frame(
    frame: BackendFrame,
    truth: VisualTruth,
    *,
    measured_color: tuple[float, float, float] | None,
    phash: str | None = None,
    tolerance: float = DEFAULT_COLOR_TOLERANCE,
) -> FrameJudgement:
    """Grade one returned frame against the fixture.

    The reference time is what the caller asked for when there was a request,
    and the provider's own reported timestamp otherwise — because those are
    the two different claims a backend can make, and both have to be checkable.
    """
    reference = (
        frame.requested_seconds
        if frame.requested_seconds is not None
        else frame.timestamp_seconds
    )

    expected = truth.occurrence_at(reference) if reference is not None else None
    expected_event = expected["event_id"] if expected else None

    if measured_color is None:
        return FrameJudgement(
            index=frame.index,
            requested_seconds=frame.requested_seconds,
            reported_seconds=frame.timestamp_seconds,
            expected_event_id=expected_event,
            actual_event_id=None,
            verdict=FrameVerdict.NO_IMAGE,
            color_drift=None,
            actual_interval=None,
            signed_error_lo=None,
            signed_error_hi=None,
            path=str(frame.path) if frame.path else None,
        )

    actual_event, drift = identify_by_color(measured_color, truth.events, tolerance)
    phash_event, phash_distance = (
        identify_by_phash(phash, truth.events) if phash else (None, None)
    )
    ocr_event = identify_by_ocr(frame.ocr_text, truth.events)

    if actual_event is None:
        verdict = FrameVerdict.UNIDENTIFIED
        interval = None
    else:
        occurrence = truth.nearest_occurrence_of(actual_event, reference)
        interval = (occurrence["start"], occurrence["end"]) if occurrence else None
        if expected is not None and actual_event == expected_event:
            verdict = FrameVerdict.CORRECT
        elif expected is not None and occurrence is not None and abs(
            truth.index_of(occurrence) - truth.index_of(expected)
        ) == 1:
            verdict = FrameVerdict.NEAR_NEIGHBOUR
        else:
            verdict = FrameVerdict.WRONG_EVENT

    signed_lo = signed_hi = None
    if interval is not None and reference is not None:
        signed_lo = round(interval[0] - reference, 6)
        # The interval is half-open: the last frame shown starts one period
        # before `end`, so the largest true time is `end - period`.
        signed_hi = round(interval[1] - truth.frame_period - reference, 6)
        if signed_hi < signed_lo:
            signed_hi = signed_lo

    return FrameJudgement(
        index=frame.index,
        requested_seconds=frame.requested_seconds,
        reported_seconds=frame.timestamp_seconds,
        expected_event_id=expected_event,
        actual_event_id=actual_event,
        verdict=verdict,
        color_drift=drift,
        actual_interval=interval,
        signed_error_lo=signed_lo,
        signed_error_hi=signed_hi,
        phash_event_id=phash_event,
        phash_distance=phash_distance,
        ocr_event_id=ocr_event,
        path=str(frame.path) if frame.path else None,
    )


def threshold_report(
    judgements: list[FrameJudgement],
    thresholds_ms: tuple[int, ...] = DEFAULT_THRESHOLDS_MS,
) -> list[ThresholdRow]:
    """How many probes are provably inside, provably outside, or unresolved."""
    rows: list[ThresholdRow] = []
    for threshold in thresholds_ms:
        limit = threshold / 1000.0
        within = outside = indeterminate = 0
        for judgement in judgements:
            lower, upper = judgement.abs_lower_bound, judgement.abs_upper_bound
            if lower is None or upper is None:
                indeterminate += 1
            elif upper <= limit:
                within += 1
            elif lower > limit:
                outside += 1
            else:
                indeterminate += 1
        rows.append(ThresholdRow(threshold, within, outside, indeterminate))
    return rows


@dataclass
class FrameIdentityReport:
    """Phase 6: is the picture the right picture, not just the right time."""

    total: int
    correct: int
    near_neighbour: int
    wrong_event: int
    unidentified: int
    no_image: int
    missing_expected: list[str] = field(default_factory=list)
    duplicate_identities: dict[str, list[int]] = field(default_factory=dict)
    exact_duplicate_files: dict[str, list[int]] = field(default_factory=dict)
    # Byte-identical images whose frames were graded as *different* events.
    # This is the duplicate that would be a defect: the same picture handed
    # back for two moments that do not look alike. Plain byte-identity is not,
    # because a fixture that holds one static card for two seconds genuinely
    # has identical frames throughout it.
    cross_event_duplicate_files: dict[str, list[int]] = field(default_factory=dict)
    unexpected: list[int] = field(default_factory=list)
    channel_agreement: dict[str, int] = field(default_factory=dict)

    @property
    def correct_rate(self) -> float:
        return self.correct / self.total if self.total else math.nan

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "correct_rate": round(self.correct_rate, 4)
                if self.total else None}


def frame_identity_report(
    judgements: list[FrameJudgement],
    *,
    expected_event_ids: list[str] | None = None,
    file_digests: dict[int, str] | None = None,
) -> FrameIdentityReport:
    """Aggregate the per-frame verdicts, including what never came back."""
    counts = dict.fromkeys(FrameVerdict, 0)
    for judgement in judgements:
        counts[judgement.verdict] += 1

    seen: dict[str, list[int]] = {}
    for judgement in judgements:
        if judgement.actual_event_id is not None:
            seen.setdefault(judgement.actual_event_id, []).append(judgement.index)
    duplicates = {k: v for k, v in seen.items() if len(v) > 1}

    exact: dict[str, list[int]] = {}
    for index, digest in (file_digests or {}).items():
        exact.setdefault(digest, []).append(index)
    exact_duplicates = {k: sorted(v) for k, v in exact.items() if len(v) > 1}

    event_of = {j.index: j.actual_event_id for j in judgements}
    cross_event = {
        digest: indexes
        for digest, indexes in exact_duplicates.items()
        if len({event_of.get(i) for i in indexes}) > 1
    }

    missing = [
        event_id for event_id in (expected_event_ids or []) if event_id not in seen
    ]

    agreement = {"colour_and_phash_agree": 0, "colour_and_phash_differ": 0,
                 "phash_unavailable": 0, "ocr_agrees": 0, "ocr_differs": 0,
                 "ocr_unavailable": 0}
    for judgement in judgements:
        if judgement.phash_event_id is None:
            agreement["phash_unavailable"] += 1
        elif judgement.phash_event_id == judgement.actual_event_id:
            agreement["colour_and_phash_agree"] += 1
        else:
            agreement["colour_and_phash_differ"] += 1
        if judgement.ocr_event_id is None:
            agreement["ocr_unavailable"] += 1
        elif judgement.ocr_event_id == judgement.actual_event_id:
            agreement["ocr_agrees"] += 1
        else:
            agreement["ocr_differs"] += 1

    return FrameIdentityReport(
        total=len(judgements),
        correct=counts[FrameVerdict.CORRECT],
        near_neighbour=counts[FrameVerdict.NEAR_NEIGHBOUR],
        wrong_event=counts[FrameVerdict.WRONG_EVENT],
        unidentified=counts[FrameVerdict.UNIDENTIFIED],
        no_image=counts[FrameVerdict.NO_IMAGE],
        missing_expected=missing,
        duplicate_identities=duplicates,
        exact_duplicate_files=exact_duplicates,
        cross_event_duplicate_files=cross_event,
        channel_agreement=agreement,
    )


# --- ordering ---------------------------------------------------------------


@dataclass
class OrderingReport:
    """Phase 7: does the sequence mean anything."""

    frames: int
    timestamps_present: int
    monotonic: bool
    inversions: list[dict[str, Any]] = field(default_factory=list)
    duplicate_timestamps: dict[str, int] = field(default_factory=dict)
    largest_gap_seconds: float | None = None
    gap_after_index: int | None = None
    identity_order_matches_time_order: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def ordering_report(
    frames: list[BackendFrame],
    judgements: list[FrameJudgement] | None = None,
) -> OrderingReport:
    """Check the returned order against media time, and against identity.

    Two different failures hide here. A list whose timestamps go backwards is
    obviously broken. A list whose timestamps rise but whose *pictures* do not
    is the one that matters more, because it survives every check that only
    reads metadata — and it is the failure asynchronous completion order
    produces when it leaks into output order.
    """
    timed = [f for f in frames if f.timestamp_seconds is not None]
    inversions = [
        {
            "index_a": a.index, "index_b": b.index,
            "timestamp_a": a.timestamp_seconds, "timestamp_b": b.timestamp_seconds,
        }
        for a, b in zip(timed, timed[1:], strict=False)
        if b.timestamp_seconds < a.timestamp_seconds  # type: ignore[operator]
    ]

    counts: dict[str, int] = {}
    for frame in timed:
        key = f"{frame.timestamp_seconds:.6f}"
        counts[key] = counts.get(key, 0) + 1
    duplicates = {k: v for k, v in counts.items() if v > 1}

    largest_gap = None
    gap_after = None
    for a, b in zip(timed, timed[1:], strict=False):
        gap = b.timestamp_seconds - a.timestamp_seconds  # type: ignore[operator]
        if largest_gap is None or gap > largest_gap:
            largest_gap, gap_after = round(gap, 6), a.index

    identity_matches = None
    if judgements:
        starts = [
            j.actual_interval[0]
            for j in sorted(judgements, key=lambda j: j.index)
            if j.actual_interval is not None
        ]
        identity_matches = all(
            a <= b for a, b in zip(starts, starts[1:], strict=False)
        )

    return OrderingReport(
        frames=len(frames),
        timestamps_present=len(timed),
        monotonic=not inversions,
        inversions=inversions,
        duplicate_timestamps=duplicates,
        largest_gap_seconds=largest_gap,
        gap_after_index=gap_after,
        identity_order_matches_time_order=identity_matches,
    )


# --- transcript -------------------------------------------------------------

# The normalization rules are the ones stated in benchmarks/asr_accuracy.py,
# applied identically here so the two numbers stay comparable. A test asserts
# the two implementations agree rather than trusting this comment.
_DIGIT_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")

NORMALIZATION = (
    "lowercase; punctuation dropped; digits spelled out digit by digit; "
    "applied identically to reference and hypothesis"
)


def normalize_words(text: str) -> list[str]:
    """Lowercase, drop punctuation, spell digits out one at a time."""
    text = _PUNCT.sub(" ", text.lower())
    out: list[str] = []
    for token in _SPACES.split(text.strip()):
        if not token:
            continue
        # `str.isdigit()` is true for far more than 0-9 — "①", "٣", "²" all
        # pass it — and the spelling table only holds ASCII. Real OCR output
        # from a real video is exactly where that lands: a circled digit off a
        # slide crashed this function before the ASCII guard was added.
        if token.isascii() and token.isdigit():
            out.extend(_DIGIT_WORDS[d] for d in token)
        else:
            out.append(token)
    return out


def word_edit_counts(reference: list[str], hypothesis: list[str]) -> dict[str, int]:
    """Levenshtein over words, keeping the operations apart.

    Substitutions, insertions and deletions are reported separately because
    they mean different things: a backend that drops words fails very
    differently from one that invents them, and a single WER hides which.
    """
    rows, cols = len(reference) + 1, len(hypothesis) + 1
    dist = [[0] * cols for _ in range(rows)]
    back = [[""] * cols for _ in range(rows)]
    for i in range(rows):
        dist[i][0], back[i][0] = i, "D"
    for j in range(cols):
        dist[0][j], back[0][j] = j, "I"
    back[0][0] = ""

    for i in range(1, rows):
        for j in range(1, cols):
            if reference[i - 1] == hypothesis[j - 1]:
                dist[i][j], back[i][j] = dist[i - 1][j - 1], "="
                continue
            dist[i][j], back[i][j] = min(
                (dist[i - 1][j - 1] + 1, "S"),
                (dist[i][j - 1] + 1, "I"),
                (dist[i - 1][j] + 1, "D"),
            )

    counts = {"substitutions": 0, "insertions": 0, "deletions": 0, "hits": 0}
    i, j = len(reference), len(hypothesis)
    while i > 0 or j > 0:
        op = back[i][j]
        if op == "=":
            counts["hits"] += 1
            i, j = i - 1, j - 1
        elif op == "S":
            counts["substitutions"] += 1
            i, j = i - 1, j - 1
        elif op == "I":
            counts["insertions"] += 1
            j -= 1
        else:
            counts["deletions"] += 1
            i -= 1
    return counts


def interval_overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Intersection over union of two closed intervals; 0.0 when disjoint."""
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    intersection = max(0.0, hi - lo)
    union = (a[1] - a[0]) + (b[1] - b[0]) - intersection
    return round(intersection / union, 6) if union > 0 else 0.0


@dataclass
class CueAlignment:
    """One ground-truth cue matched against what came back."""

    cue_id: str
    reference_start: float
    reference_end: float
    matched_index: int | None
    hypothesis_start: float | None
    hypothesis_end: float | None
    start_error: float | None
    end_error: float | None
    midpoint_error: float | None
    overlap: float
    text_wer: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TranscriptReport:
    """Phase 8: what the transcript said, and when it said it happened."""

    reference_words: int
    hypothesis_words: int
    wer: float
    counts: dict[str, int]
    normalization: str
    cue_count_reference: int
    cue_count_hypothesis: int
    dropped_cues: list[str] = field(default_factory=list)
    duplicate_cue_texts: dict[str, int] = field(default_factory=dict)
    out_of_order_cues: int = 0
    alignments: list[CueAlignment] = field(default_factory=list)
    start_stats: TimingStats | None = None
    end_stats: TimingStats | None = None
    midpoint_stats: TimingStats | None = None
    mean_overlap: float | None = None
    transcript_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "reference_words": self.reference_words,
            "hypothesis_words": self.hypothesis_words,
            "wer": self.wer,
            "counts": self.counts,
            "normalization": self.normalization,
            "cue_count_reference": self.cue_count_reference,
            "cue_count_hypothesis": self.cue_count_hypothesis,
            "dropped_cues": self.dropped_cues,
            "duplicate_cue_texts": self.duplicate_cue_texts,
            "out_of_order_cues": self.out_of_order_cues,
            "alignments": [a.to_dict() for a in self.alignments],
            "start_stats": self.start_stats.to_dict() if self.start_stats else None,
            "end_stats": self.end_stats.to_dict() if self.end_stats else None,
            "midpoint_stats": self.midpoint_stats.to_dict() if self.midpoint_stats else None,
            "mean_overlap": self.mean_overlap,
            "transcript_source": self.transcript_source,
        }


def transcript_report(
    reference_cues: list[dict[str, Any]],
    hypothesis: list[BackendCue],
    *,
    transcript_source: str | None = None,
) -> TranscriptReport:
    """Score text and timing separately, and never let one rescue the other.

    Text is normalized before it is compared, because a model writing "502"
    for "five zero two" is right. Timing is scored on the raw numbers, because
    normalizing a timestamp would be scoring our own arithmetic.
    """
    reference_text = " ".join(str(cue["text"]) for cue in reference_cues)
    hypothesis_text = " ".join(cue.text for cue in hypothesis)
    reference_words = normalize_words(reference_text)
    hypothesis_words = normalize_words(hypothesis_text)
    counts = word_edit_counts(reference_words, hypothesis_words)
    errors = counts["substitutions"] + counts["insertions"] + counts["deletions"]
    wer = round(errors / len(reference_words), 6) if reference_words else math.nan

    timed = [c for c in hypothesis if c.start is not None]
    used: set[int] = set()
    alignments: list[CueAlignment] = []
    for cue in reference_cues:
        span = (float(cue["start"]), float(cue["end"]))
        best_index: int | None = None
        best_overlap = 0.0
        for position, candidate in enumerate(timed):
            if position in used or candidate.start is None:
                continue
            end = candidate.end if candidate.end is not None else candidate.start
            score = interval_overlap(span, (candidate.start, end))
            if score > best_overlap:
                best_index, best_overlap = position, score
        matched = timed[best_index] if best_index is not None else None
        if best_index is not None:
            used.add(best_index)

        start_error = end_error = midpoint_error = None
        text_wer = None
        if matched is not None and matched.start is not None:
            start_error = round(matched.start - span[0], 6)
            if matched.end is not None:
                end_error = round(matched.end - span[1], 6)
                midpoint_error = round(
                    ((matched.start + matched.end) / 2) - ((span[0] + span[1]) / 2), 6
                )
            reference_tokens = normalize_words(str(cue["text"]))
            hypothesis_tokens = normalize_words(matched.text)
            cue_counts = word_edit_counts(reference_tokens, hypothesis_tokens)
            cue_errors = (
                cue_counts["substitutions"] + cue_counts["insertions"]
                + cue_counts["deletions"]
            )
            text_wer = (
                round(cue_errors / len(reference_tokens), 6)
                if reference_tokens else None
            )

        alignments.append(CueAlignment(
            cue_id=str(cue.get("cue_id", "")),
            reference_start=span[0],
            reference_end=span[1],
            matched_index=matched.index if matched is not None else None,
            hypothesis_start=matched.start if matched is not None else None,
            hypothesis_end=matched.end if matched is not None else None,
            start_error=start_error,
            end_error=end_error,
            midpoint_error=midpoint_error,
            overlap=round(best_overlap, 6),
            text_wer=text_wer,
        ))

    text_seen: dict[str, int] = {}
    for cue in hypothesis:
        key = " ".join(normalize_words(cue.text))
        if key:
            text_seen[key] = text_seen.get(key, 0) + 1

    starts = [c.start for c in timed]
    out_of_order = sum(
        1 for a, b in zip(starts, starts[1:], strict=False) if b < a  # type: ignore[operator]
    )

    def stats(values: list[float | None]) -> TimingStats | None:
        present = [v for v in values if v is not None]
        return TimingStats.from_signed(present) if present else None

    overlaps = [a.overlap for a in alignments]
    return TranscriptReport(
        reference_words=len(reference_words),
        hypothesis_words=len(hypothesis_words),
        wer=wer,
        counts=counts,
        normalization=NORMALIZATION,
        cue_count_reference=len(reference_cues),
        cue_count_hypothesis=len(hypothesis),
        dropped_cues=[a.cue_id for a in alignments if a.matched_index is None],
        duplicate_cue_texts={k: v for k, v in text_seen.items() if v > 1},
        out_of_order_cues=out_of_order,
        alignments=alignments,
        start_stats=stats([a.start_error for a in alignments]),
        end_stats=stats([a.end_error for a in alignments]),
        midpoint_stats=stats([a.midpoint_error for a in alignments]),
        mean_overlap=round(sum(overlaps) / len(overlaps), 6) if overlaps else None,
        transcript_source=transcript_source,
    )


# --- written analysis -------------------------------------------------------

# Words a document needs to be a document. They are not claims about the
# video, so counting them either way would measure prose style rather than
# groundedness.
_SCAFFOLD = frozenset(normalize_words(
    "the a an of to in on and or is are was were be been being for with that "
    "this it as at by from its into their there here which when where how "
    "what not but can could may might if then than so such these those we "
    "you they he she i chapter chapters section frame frames timestamp "
    "timestamps built check checked answer answers comes came back below "
    "above every line drawn index carries second seconds source transcript "
    "screen text blocks kept recurring subjects statements made about any "
    "your question evidence same document nothing generated prose because "
    "observed watch skill ask run bash md json"
))


@dataclass
class AnalysisGroundedness:
    """How much of a written write-up can be traced back to the video.

    A fluent page about a video is easy to produce and hard to check. This
    measures the part that matters for evidence: whether the document's
    substantive vocabulary appears anywhere in what was actually observed —
    the transcript, the on-screen text, the labels — and how often it points
    at a timestamp a reader could jump to.

    It is a coarse instrument and says so. A document can use a synonym the
    source never used and still be true. What it catches reliably is the
    opposite failure: pages of confident technical narrative about a subject
    the video never touched.
    """

    content_words: int
    distinct_terms: int
    terms_in_source: int
    timestamps_cited: int
    ungrounded_examples: list[str] = field(default_factory=list)

    @property
    def grounded_rate(self) -> float:
        return self.terms_in_source / self.distinct_terms if self.distinct_terms else math.nan

    @property
    def citations_per_100_words(self) -> float:
        return (
            self.timestamps_cited / self.content_words * 100
            if self.content_words else math.nan
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "grounded_rate": (
                round(self.grounded_rate, 4) if self.distinct_terms else None
            ),
            "citations_per_100_words": (
                round(self.citations_per_100_words, 2) if self.content_words else None
            ),
        }


_TIMESTAMP_IN_TEXT = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
_FENCED = re.compile(r"```.*?```", re.S)


def analysis_groundedness(
    document: str, source_texts: list[str]
) -> AnalysisGroundedness:
    """Score one written analysis against everything observed in the video.

    Fenced code blocks are stripped first: a reproduction command is not a
    claim about the footage, and leaving it in would credit or penalise a
    document for its own instructions.
    """
    body = _FENCED.sub(" ", document or "")
    source = set()
    for text in source_texts:
        source.update(normalize_words(text))

    words = [
        word for word in normalize_words(body)
        if word not in _SCAFFOLD and len(word) > 2 and not word.isdigit()
    ]
    distinct = sorted(set(words))
    grounded = [word for word in distinct if word in source]
    ungrounded = [word for word in distinct if word not in source]

    return AnalysisGroundedness(
        content_words=len(words),
        distinct_terms=len(distinct),
        terms_in_source=len(grounded),
        timestamps_cited=len(_TIMESTAMP_IN_TEXT.findall(body)),
        ungrounded_examples=ungrounded[:15],
    )


# --- repeatability ----------------------------------------------------------


@dataclass
class RepeatabilityReport:
    """Phase 9: what changed between identical runs, and what only looked like it."""

    runs: int
    frame_counts: list[int]
    frame_counts_stable: bool
    timestamps_stable: bool
    identities_stable: bool
    ordering_stable: bool
    transcript_texts_stable: bool
    cue_counts: list[int] = field(default_factory=list)
    volatile_fields: list[str] = field(default_factory=list)
    differing_fields: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def repeatability_report(
    runs: list[dict[str, Any]], volatile_fields: list[str] | None = None
) -> RepeatabilityReport:
    """Compare identical runs, separating per-run identifiers from evidence.

    A request id that differs every run is not nondeterminism — it is a
    correlation handle doing its job. A *timestamp* that differs every run is.
    Anything named in `volatile_fields` is excluded from the evidence
    comparison and reported by name, so the exclusion is visible rather than
    convenient.
    """
    volatile = list(volatile_fields or [])
    frame_counts = [len(run.get("frames", [])) for run in runs]
    cue_counts = [len(run.get("cues", [])) for run in runs]

    def timestamps(run: dict[str, Any]) -> list[float | None]:
        return [f.get("timestamp_seconds") for f in run.get("frames", [])]

    def identities(run: dict[str, Any]) -> list[str | None]:
        return [f.get("actual_event_id") for f in run.get("frames", [])]

    def texts(run: dict[str, Any]) -> list[str]:
        return [" ".join(normalize_words(c.get("text", ""))) for c in run.get("cues", [])]

    first = runs[0] if runs else {}
    differing: list[str] = []
    timestamps_stable = all(timestamps(r) == timestamps(first) for r in runs)
    identities_stable = all(identities(r) == identities(first) for r in runs)
    texts_stable = all(texts(r) == texts(first) for r in runs)
    counts_stable = len(set(frame_counts)) <= 1
    ordering_stable = all(
        [f.get("index") for f in r.get("frames", [])]
        == [f.get("index") for f in first.get("frames", [])]
        for r in runs
    )
    for name, stable in (
        ("frame_count", counts_stable), ("frame_timestamps", timestamps_stable),
        ("frame_identities", identities_stable), ("frame_order", ordering_stable),
        ("transcript_text", texts_stable),
    ):
        if not stable:
            differing.append(name)

    return RepeatabilityReport(
        runs=len(runs),
        frame_counts=frame_counts,
        frame_counts_stable=counts_stable,
        timestamps_stable=timestamps_stable,
        identities_stable=identities_stable,
        ordering_stable=ordering_stable,
        transcript_texts_stable=texts_stable,
        cue_counts=cue_counts,
        volatile_fields=volatile,
        differing_fields=differing,
    )


# --- image measurement helper ----------------------------------------------


def measure_image(
    path: Path, band: dict[str, float] | None = None
) -> tuple[tuple[float, float, float], str] | None:
    """Read a returned frame's identity band and perceptual hash.

    Returns ``None`` when the file is missing or unreadable, which the caller
    turns into ``NO_IMAGE`` rather than into a zero score.
    """
    if not path.is_file():
        return None
    try:
        import imagehash
        import numpy as np
        from PIL import Image
    except ImportError:  # pragma: no cover - the extras are declared
        return None

    region = band or {"top": 0.03, "bottom": 0.13, "left": 0.05, "right": 0.95}
    try:
        with Image.open(path) as handle:
            rgb = handle.convert("RGB")
            phash = str(imagehash.phash(rgb))
            array = np.asarray(rgb, dtype=np.float64)
    except OSError:
        return None

    height, width = array.shape[:2]
    patch = array[
        int(height * region["top"]) : int(height * region["bottom"]),
        int(width * region["left"]) : int(width * region["right"]),
    ]
    if patch.size == 0:
        return None
    mean = patch.reshape(-1, 3).mean(axis=0)
    return (float(mean[0]), float(mean[1]), float(mean[2])), phash
