"""The escalation ladder: cheap, model-free steps first; models last.

Each step returns an estimated token cost so the engine can enforce the
per-question budget. Steps augment the index in place — evidence recovered
here is permanent, so the next ask starts smarter.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from watch_skill.answer.types import est_frame_tokens
from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.index.retrieval import Hit
from watch_skill.index.store import augment_video

_MAX_RESAMPLE_WINDOWS = 2
_RESAMPLE_FRAME_BUDGET = 12


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


def dense_resample(video: dict, hits: list[Hit]) -> tuple[int, int]:
    """Step (a): re-sample densely (and at high resolution) around the top
    candidate timestamps, OCR the new frames, and merge into the index.

    Returns (new_items_indexed, estimated_token_cost). Model-free; the token
    cost is OCR/compute only, so it is charged as 0 prompt tokens.
    """
    settings = get_settings()
    try:
        from watch_skill.acquire import acquire  # noqa: PLC0415
        from watch_skill.perceive import perceive  # noqa: PLC0415

        acq = acquire(video["source"], use_cache=True)
    except WatchSkillError as exc:
        print(f"[watch-skill] escalation resample skipped ({exc.code})", file=sys.stderr)
        return 0, 0

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
        return 0, 0

    new_items = 0
    half = width / 2
    for center in centers:
        work = Path(tempfile.mkdtemp(prefix="watch-skill-esc-", dir=_escalation_dir(video["id"])))
        try:
            perception = perceive(
                acq.video_path, work,
                start_seconds=max(0.0, center - half),
                end_seconds=center + half,
                max_frames=_RESAMPLE_FRAME_BUDGET,
                frame_width=resolution,
                run_ocr=True,
            )
        except WatchSkillError as exc:
            print(f"[watch-skill] escalation resample failed ({exc.code})", file=sys.stderr)
            continue
        new_items += augment_video(video["id"], perception)
    return new_items, 0


def zoom_crops_reocr(video: dict, hits: list[Hit]) -> tuple[int, int]:
    """Steps (b)+(c): crop the regions OCR found on the escalation frames,
    upscale, and re-OCR the crops — small on-screen text that the full-frame
    pass mangled often reads cleanly at 2x. Model-free."""
    from watch_skill.answer import crops  # noqa: PLC0415

    frames = _recent_escalation_frames(video["id"], hits)
    if not frames:
        return 0, 0
    new_items = 0
    for timestamp, frame_path in frames:
        try:
            blocks = crops.crop_and_reocr(Path(frame_path))
        except WatchSkillError as exc:
            print(f"[watch-skill] zoom crops skipped ({exc.code})", file=sys.stderr)
            return new_items, 0
        if blocks:
            new_items += _insert_ocr_blocks(video["id"], timestamp, frame_path, blocks)
    return new_items, 0


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
