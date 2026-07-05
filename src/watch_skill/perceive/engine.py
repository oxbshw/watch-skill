"""The perception engine: scene-aware, budgeted, deduped frame selection.

Strategy (what the reference does NOT do): detect scenes with PySceneDetect,
spend the frame budget on scene boundaries + midpoints, top up with uniform
fill only when scenes under-produce, then drop perceptual-hash near-duplicates
so every kept frame is distinct visual content.
"""
from __future__ import annotations

import sys
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.errors import PerceptionError
from watch_skill.perceive import budget as budget_mod
from watch_skill.perceive import media, ocr, scenes
from watch_skill.perceive.types import Frame, PerceptionResult, VideoMetadata

_MIN_GAP_SECONDS = 0.5  # do not sample two candidates closer than this


def _scene_candidates(
    scene_spans: list[tuple[float, float]], lo: float, hi: float
) -> list[tuple[float, int, str]]:
    """(timestamp, scene_id, reason) at each in-window scene start + midpoint."""
    out: list[tuple[float, int, str]] = []
    for scene_id, (start, end) in enumerate(scene_spans):
        if end < lo or start > hi:
            continue
        clamped_start = max(start, lo)
        clamped_end = min(end, hi)
        out.append((round(clamped_start, 3), scene_id, "scene-start"))
        midpoint = (clamped_start + clamped_end) / 2
        if midpoint - clamped_start >= _MIN_GAP_SECONDS:
            out.append((round(midpoint, 3), scene_id, "scene-mid"))
    return out


def _uniform_fill(
    existing: list[tuple[float, int, str]],
    target: int,
    lo: float,
    hi: float,
    scene_spans: list[tuple[float, float]],
) -> list[tuple[float, int, str]]:
    """Top up to ``target`` with evenly spaced timestamps that avoid existing ones."""
    needed = target - len(existing)
    if needed <= 0 or hi <= lo:
        return existing
    taken = sorted(ts for ts, _, _ in existing)
    step = (hi - lo) / (needed + 1)
    added: list[tuple[float, int, str]] = []
    for i in range(1, needed + 1):
        ts = round(lo + i * step, 3)
        if any(abs(ts - t) < _MIN_GAP_SECONDS for t in taken):
            continue
        added.append((ts, _scene_for(ts, scene_spans), "uniform"))
        taken.append(ts)
    return sorted([*existing, *added])


def _scene_for(timestamp: float, scene_spans: list[tuple[float, float]]) -> int:
    for scene_id, (start, end) in enumerate(scene_spans):
        if start <= timestamp < end:
            return scene_id
    return 0


def _even_sample(items: list, n: int) -> list:
    """n evenly spaced picks, first and last always kept."""
    if n >= len(items):
        return list(items)
    if n <= 1:
        return items[:1]
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def _extract_and_dedup(
    video_path: Path,
    candidates: list[tuple[float, int, str]],
    out_dir: Path,
    width: int,
    pinned_reasons: frozenset[str] = frozenset({"cue"}),
) -> tuple[list[Frame], int]:
    """Extract JPEGs, phash them, drop near-duplicates (pinned frames survive)."""
    threshold = get_settings().phash_distance
    kept: list[Frame] = []
    kept_hashes: list[str] = []
    dropped = 0
    for ts, scene_id, reason in candidates:
        dest = out_dir / f"frame_{len(kept):04d}.jpg"
        extracted = media.extract_frame_at(video_path, ts, dest, width=width)
        if extracted is None:
            continue
        phash = scenes.compute_phash(extracted)
        is_pinned = reason in pinned_reasons
        if not is_pinned and any(
            scenes.hamming_distance(phash, h) <= threshold for h in kept_hashes
        ):
            extracted.unlink(missing_ok=True)
            dropped += 1
            continue
        kept.append(
            Frame(
                index=len(kept), timestamp_seconds=ts, path=extracted,
                scene_id=scene_id, phash=phash, reason=reason,
            )
        )
        kept_hashes.append(phash)
    return kept, dropped


def _run_ocr(frames: list[Frame], lang: str | None = None) -> None:
    """Attach OCR blocks in place; degrade loudly (not silently) if OCR is unavailable."""
    for i, frame in enumerate(frames):
        try:
            frame.ocr_blocks = ocr.ocr_frame(frame.path, lang=lang)
        except PerceptionError as exc:
            print(f"[watch-skill] OCR unavailable — skipping ({exc.code})", file=sys.stderr)
            return
        except Exception as exc:  # one bad frame must not kill the pass
            print(f"[watch-skill] OCR failed on frame {i}: {exc}", file=sys.stderr)


def perceive(
    video_path: Path,
    out_dir: Path,
    source_label: str | None = None,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    max_frames: int | None = None,
    frame_width: int | None = None,
    cue_timestamps: list[float] | None = None,
    run_ocr: bool | None = None,
    ocr_lang: str | None = None,
    metadata: VideoMetadata | None = None,
) -> PerceptionResult:
    """Run the full perception pass over ``video_path``.

    Focused mode engages when ``start_seconds``/``end_seconds`` are given.
    ``cue_timestamps`` are pinned frames (transcript cues) reserved against
    the cap and never deduped away.
    """
    settings = get_settings()
    width = frame_width if frame_width is not None else settings.frame_width
    cap = max_frames if max_frames is not None else settings.frame_cap
    do_ocr = run_ocr if run_ocr is not None else settings.ocr_enabled

    meta = metadata if metadata is not None else media.probe(video_path)
    lo = start_seconds if start_seconds is not None else 0.0
    hi = end_seconds if end_seconds is not None else meta.duration_seconds
    focused = start_seconds is not None or end_seconds is not None
    if hi <= lo:
        raise PerceptionError(
            f"empty time window: start={lo} end={hi}",
            code="perceive.bad_window",
            fix="end must be greater than start and within the video duration",
        )

    pick = budget_mod.focused_budget if focused else budget_mod.full_budget
    _, target = pick(hi - lo, max_frames=cap)

    cues = sorted({round(t, 3) for t in (cue_timestamps or []) if lo <= t <= hi})
    cues = _even_sample(cues, cap)

    scene_spans = detect_or_empty(
        video_path,
        start_seconds if focused else None,
        end_seconds if focused else None,
    )
    candidates = _scene_candidates(scene_spans, lo, hi)
    engine = "scene" if len(scene_spans) >= 2 else "uniform"
    detail_target = max(0, target - len(cues))
    if len(candidates) > detail_target:
        candidates = _even_sample(sorted(candidates), detail_target)
    else:
        candidates = _uniform_fill(candidates, detail_target, lo, hi, scene_spans)
        if candidates and any(r == "uniform" for _, _, r in candidates) and engine == "scene":
            engine = "mixed"

    merged = sorted(
        [*candidates, *[(t, _scene_for(t, scene_spans), "cue") for t in cues]]
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    frames, dropped = _extract_and_dedup(video_path, merged, out_dir, width)
    if do_ocr and frames:
        _run_ocr(frames, lang=ocr_lang)

    return PerceptionResult(
        source=source_label or str(video_path),
        metadata=meta,
        frames=frames,
        scene_count=len(scene_spans),
        candidate_count=len(merged),
        deduped_count=dropped,
        engine=engine,
        focused=focused,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
    )


def detect_or_empty(
    video_path: Path,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
) -> list[tuple[float, float]]:
    """Scene detection that degrades to uniform sampling instead of failing."""
    try:
        return scenes.detect_scenes(video_path, start_seconds, end_seconds)
    except PerceptionError as exc:
        print(f"[watch-skill] scene detection unavailable ({exc.code}) — uniform sampling", file=sys.stderr)
        return []
