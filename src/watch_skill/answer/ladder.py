"""The escalation ladder: cheap, model-free steps first; models last.

Each step returns an estimated token cost so the engine can enforce the
per-question budget. Steps augment the index in place — evidence recovered
here is permanent, so the next ask starts smarter.

These rungs are model-free, so they are charged 0 prompt tokens — which
means the token budget provably cannot bound them, and on a caption-rich
video they were measured burning ~100s of CPU for a 0.000 confidence gain
while an interactive MCP client timed out. Hence the second ceiling: every
rung takes a monotonic ``deadline`` and checks it between units of work,
so a rung can be cut short mid-way and still keep what it already indexed
(recovered evidence is permanent, so partial progress is real progress).
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

from watch_skill.answer.types import est_frame_tokens
from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.index.retrieval import Hit
from watch_skill.index.store import augment_video

_MAX_RESAMPLE_WINDOWS = 2
_RESAMPLE_FRAME_BUDGET = 12
# Below this a resample window is not worth the ffmpeg spin-up: too few
# frames to plausibly recover text the full-resolution pass missed.
_MIN_RESAMPLE_FRAMES = 3


# What an escalation window actually costs, learned in-process. The OCR
# engine is a per-process singleton (perceive/ocr.py::_engines), so the first
# window in a fresh server pays a model-load that later windows do not —
# measured at ~40s cold vs ~2.2s/frame warm. Predicting one number for both
# is how a window overran a deadline it had legitimately cleared on entry.
_cost_model: dict[str, float | bool | None] = {"warm": False, "per_frame": None}


def reset_cost_model() -> None:
    """Forget the learned window cost (tests, and after a config change)."""
    _cost_model["warm"] = False
    _cost_model["per_frame"] = None


def _estimated_window_seconds(frames: int) -> float:
    settings = get_settings()
    per_frame = _cost_model["per_frame"] or settings.answer_resample_seconds_per_frame
    warmup = 0.0 if _cost_model["warm"] else settings.answer_escalation_warmup_seconds
    return warmup + frames * float(per_frame)


def _record_window(frames: int, elapsed: float) -> None:
    """Fold one observed window into the model."""
    if frames > 0 and _cost_model["warm"]:
        prior = _cost_model["per_frame"]
        observed = elapsed / frames
        # EWMA: adapt to this machine without letting one slow window (a
        # loaded box, a big frame) dominate the estimate.
        _cost_model["per_frame"] = observed if prior is None else 0.5 * float(prior) + 0.5 * observed
    _cost_model["warm"] = True


def affordable_frames(deadline: float | None, reserve: float, cap: int) -> int:
    """Largest frame budget (<= cap) whose estimated cost fits the deadline."""
    if deadline is None:
        return cap
    remaining = deadline - time.monotonic() - reserve
    for frames in range(cap, 0, -1):
        if _estimated_window_seconds(frames) <= remaining:
            return frames
    return 0


def out_of_time(deadline: float | None, reserve: float = 0.0) -> bool:
    """True when ``deadline`` (a ``time.monotonic()`` stamp) leaves less than
    ``reserve`` seconds. ``None`` means no deadline — batch/offline callers
    keep the old unbounded behaviour by simply not passing one."""
    if deadline is None:
        return False
    return time.monotonic() + reserve >= deadline


def _escalation_dir(video_id: str) -> Path:
    dest = get_settings().data_dir / "frames" / video_id / "escalation"
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def _profile_for(video: dict) -> dict:
    """Adaptive profile overrides for this video's content-type (or {})."""
    settings = get_settings()
    if not settings.lessons_enabled:
        return {}
    try:
        from watch_skill.lessons.classify import classify_content_type  # noqa: PLC0415
        from watch_skill.lessons.profiles import get_profile  # noqa: PLC0415

        return get_profile(classify_content_type(video))
    except Exception:  # profiles must never break an answer
        return {}


def dense_resample(
    video: dict, hits: list[Hit], deadline: float | None = None
) -> tuple[int, int, bool]:
    """Step (a): re-sample densely (and at high resolution) around the top
    candidate timestamps, OCR the new frames, and merge into the index.

    Returns (new_items_indexed, estimated_token_cost). Model-free; the token
    cost is OCR/compute only, so it is charged as 0 prompt tokens — the
    ``deadline`` is what actually bounds it. Checked per resample window, so
    a cut-short pass still indexes the windows it finished.
    """
    settings = get_settings()
    reserve = settings.answer_step_reserve_seconds
    # Checked BEFORE acquire: on a cold media cache this call re-fetches the
    # source, which is the one thing a follow-up ask must never do on an
    # interactive timeline.
    if out_of_time(deadline, reserve):
        return 0, 0, True
    try:
        from watch_skill.acquire import acquire  # noqa: PLC0415
        from watch_skill.perceive import perceive  # noqa: PLC0415

        acq = acquire(video["source"], use_cache=True)
    except WatchSkillError as exc:
        print(f"[watch-skill] escalation resample skipped ({exc.code})", file=sys.stderr)
        return 0, 0, False

    profile = _profile_for(video)
    width = settings.answer_resample_width * float(profile.get("resample_width_mult", 1.0))
    resolution = int(
        settings.answer_resample_resolution * float(profile.get("resample_resolution_mult", 1.0))
    )

    centers: list[float] = []
    for hit in hits:
        if hit.timestamp is None:
            continue
        if all(abs(hit.timestamp - c) > width for c in centers):
            centers.append(hit.timestamp)
        if len(centers) >= _MAX_RESAMPLE_WINDOWS:
            break
    if not centers:
        return 0, 0, False

    new_items = 0
    truncated = False
    half = width / 2
    for center in centers:
        if out_of_time(deadline, reserve):
            print("[watch-skill] escalation resample stopped at the deadline",
                  file=sys.stderr)
            truncated = True
            break
        # Size the window to the time actually left. Checking only *between*
        # windows let one window run far past a deadline it had legitimately
        # cleared on entry; frames are the unit that costs, so the frame
        # count is what has to shrink — and on a cold OCR engine the honest
        # answer is that no window fits at all.
        frame_budget = affordable_frames(deadline, reserve, _RESAMPLE_FRAME_BUDGET)
        if frame_budget < _MIN_RESAMPLE_FRAMES:
            print("[watch-skill] escalation resample stopped at the deadline",
                  file=sys.stderr)
            truncated = True
            break
        work = Path(tempfile.mkdtemp(prefix="watch-skill-esc-", dir=_escalation_dir(video["id"])))
        window_started = time.monotonic()
        try:
            perception = perceive(
                acq.video_path, work,
                start_seconds=max(0.0, center - half),
                end_seconds=center + half,
                max_frames=frame_budget,
                frame_width=resolution,
                # An explicit OCR opt-out also applies to escalation. Do not
                # surprise a private/offline workflow with a model download.
                run_ocr=settings.ocr_enabled,
            )
        except WatchSkillError as exc:
            print(f"[watch-skill] escalation resample failed ({exc.code})", file=sys.stderr)
            _record_window(frame_budget, time.monotonic() - window_started)
            continue
        new_items += augment_video(video["id"], perception)
        # Indexing the recovered evidence is part of what a window costs, so
        # it is measured with it — otherwise the model under-predicts and the
        # next window overruns by exactly the embedding time.
        _record_window(frame_budget, time.monotonic() - window_started)
    return new_items, 0, truncated


def zoom_crops_reocr(
    video: dict, hits: list[Hit], deadline: float | None = None
) -> tuple[int, int, bool]:
    """Steps (b)+(c): crop the regions OCR found on the escalation frames,
    upscale, and re-OCR the crops — small on-screen text that the full-frame
    pass mangled often reads cleanly at 2x. Model-free, so the ``deadline``
    is its only real ceiling; checked per frame."""
    settings = get_settings()
    if not settings.ocr_enabled:
        return 0, 0, False
    reserve = settings.answer_step_reserve_seconds
    if out_of_time(deadline, reserve):
        return 0, 0, True

    from watch_skill.answer import crops  # noqa: PLC0415

    frames = _recent_escalation_frames(video["id"], hits)
    if not frames:
        return 0, 0, False
    new_items = 0
    truncated = False
    for timestamp, frame_path in frames:
        if out_of_time(deadline, reserve):
            print("[watch-skill] zoom crops stopped at the deadline", file=sys.stderr)
            truncated = True
            break
        try:
            blocks = crops.crop_and_reocr(Path(frame_path))
        except WatchSkillError as exc:
            print(f"[watch-skill] zoom crops skipped ({exc.code})", file=sys.stderr)
            return new_items, 0, truncated
        if blocks:
            new_items += _insert_ocr_blocks(video["id"], timestamp, frame_path, blocks)
    return new_items, 0, truncated


def _recent_escalation_frames(video_id: str, hits: list[Hit]) -> list[tuple[float, str]]:
    """Escalation-pass frames nearest the candidate timestamps."""
    from watch_skill.index.db import connect  # noqa: PLC0415

    conn = connect()
    try:
        out: list[tuple[float, str]] = []
        seen: set[str] = set()
        for hit in hits[:3]:
            if hit.timestamp is None:
                continue
            row = conn.execute(
                """SELECT timestamp, frame_path FROM scenes
                   WHERE video_id = ? AND reason = 'escalation'
                   ORDER BY ABS(timestamp - ?) LIMIT 1""",
                (video_id, hit.timestamp),
            ).fetchone()
            if row and row["frame_path"] not in seen and Path(row["frame_path"]).is_file():
                seen.add(row["frame_path"])
                out.append((row["timestamp"], row["frame_path"]))
        return out
    finally:
        conn.close()


def _insert_ocr_blocks(video_id: str, timestamp: float, frame_path: str, blocks: list) -> int:
    from watch_skill.index.db import connect  # noqa: PLC0415
    from watch_skill.index.store import _index_texts  # noqa: PLC0415

    conn = connect()
    try:
        with conn:
            existing = {
                row["text"]
                for row in conn.execute(
                    "SELECT text FROM ocr_blocks WHERE video_id = ?", (video_id,)
                ).fetchall()
            }
            to_embed: list[tuple] = []
            for block in blocks:
                if block.text in existing:
                    continue
                cur = conn.execute(
                    """INSERT INTO ocr_blocks
                       (video_id, scene_row_id, timestamp, text, x1, y1, x2, y2, confidence)
                       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)""",
                    (video_id, timestamp, block.text, *block.bbox, block.confidence),
                )
                to_embed.append(("ocr", cur.lastrowid, timestamp, block.text))
            _index_texts(conn, video_id, to_embed)
            return len(to_embed)
    finally:
        conn.close()


def estimate_verify_cost(n_frames: int, prompt_text: str, width: int = 512) -> int:
    """Token estimate for a model verify/answer call."""
    from watch_skill.answer.types import est_text_tokens  # noqa: PLC0415

    return est_text_tokens(prompt_text) + n_frames * est_frame_tokens(width, width * 9 // 16)
