"""Diff engine: align two recordings by phash, track issues across iterations."""
from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher

from agentvision.loop.critic import Issue
from agentvision.perceive.scenes import hamming_distance
from agentvision.perceive.types import PerceptionResult

_SIMILAR_ISSUE_RATIO = 0.55
_ALIGN_MAX_DISTANCE = 22  # phash bits; beyond this frames are "different content"


@dataclass
class FramePair:
    """One aligned frame pair between two recordings."""

    a_timestamp: float
    b_timestamp: float
    a_path: str
    b_path: str
    distance: int

    @property
    def changed(self) -> bool:
        return self.distance > 6  # same threshold family as perception dedup


@dataclass
class IterationDiff:
    """Comparison of a new critique against the previous one."""

    fixed: list[Issue] = field(default_factory=list)
    unchanged: list[Issue] = field(default_factory=list)
    new: list[Issue] = field(default_factory=list)
    aligned_pairs: list[FramePair] = field(default_factory=list)
    changed_pair_count: int = 0

    def to_dict(self) -> dict:
        return {
            "fixed": [i.model_dump() for i in self.fixed],
            "unchanged": [i.model_dump() for i in self.unchanged],
            "new": [i.model_dump() for i in self.new],
            "changed_pair_count": self.changed_pair_count,
            "aligned_pair_count": len(self.aligned_pairs),
        }


def align_frames(a: PerceptionResult, b: PerceptionResult) -> list[FramePair]:
    """Greedy monotonic phash alignment of two same-script recordings.

    For each frame of A, pick the best-matching not-yet-passed frame of B
    (Hamming distance), never moving backwards — recordings of the same
    interaction script are temporally ordered the same way.
    """
    pairs: list[FramePair] = []
    b_frames = b.frames
    b_start = 0
    for frame_a in a.frames:
        best_idx, best_dist = -1, _ALIGN_MAX_DISTANCE + 1
        for i in range(b_start, len(b_frames)):
            dist = hamming_distance(frame_a.phash, b_frames[i].phash)
            if dist < best_dist:
                best_idx, best_dist = i, dist
        if best_idx < 0:
            continue
        frame_b = b_frames[best_idx]
        pairs.append(
            FramePair(
                a_timestamp=frame_a.timestamp_seconds,
                b_timestamp=frame_b.timestamp_seconds,
                a_path=str(frame_a.path),
                b_path=str(frame_b.path),
                distance=best_dist,
            )
        )
        b_start = best_idx  # monotonic: later A frames match at/after this point
    return pairs


def _issues_match(a: Issue, b: Issue) -> bool:
    """Same problem across iterations: similar description, nearby timestamp."""
    ratio = SequenceMatcher(None, a.description.lower(), b.description.lower()).ratio()
    if ratio < _SIMILAR_ISSUE_RATIO:
        return False
    return abs(a.timestamp - b.timestamp) <= 10.0 or ratio > 0.8


def compare_issues(previous: list[Issue], current: list[Issue]) -> tuple[list[Issue], list[Issue], list[Issue]]:
    """(fixed, unchanged, new) relative to the previous iteration's issues."""
    fixed: list[Issue] = []
    unchanged: list[Issue] = []
    matched_current: set[int] = set()
    for prev in previous:
        match_idx = next(
            (i for i, cur in enumerate(current)
             if i not in matched_current and _issues_match(prev, cur)),
            None,
        )
        if match_idx is None:
            fixed.append(prev)
        else:
            matched_current.add(match_idx)
            unchanged.append(current[match_idx])
    new = [cur for i, cur in enumerate(current) if i not in matched_current]
    return fixed, unchanged, new


def diff_iterations(
    previous_perception: PerceptionResult,
    current_perception: PerceptionResult,
    previous_issues: list[Issue],
    current_issues: list[Issue],
) -> IterationDiff:
    """Full iteration diff: frame alignment + issue lifecycle."""
    pairs = align_frames(previous_perception, current_perception)
    fixed, unchanged, new = compare_issues(previous_issues, current_issues)
    return IterationDiff(
        fixed=fixed,
        unchanged=unchanged,
        new=new,
        aligned_pairs=pairs,
        changed_pair_count=sum(1 for p in pairs if p.changed),
    )
