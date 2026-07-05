"""Adaptive profiles: lesson statistics become per-content-type overrides.

Profiles are data, not code — JSON rows in lessons.db, inspectable with
``watch-skill profiles show`` and resettable. The answer engine applies them
automatically (e.g. screencast videos with missed-OCR history get OCR-first
escalation and denser re-sampling).
"""
from __future__ import annotations

import json
from typing import Any

from watch_skill.lessons import store

# error-class share (within one content-type) that triggers an override
_TRIGGER_SHARE = 0.34
_MIN_SAMPLES = 2


def _derive_overrides(class_counts: dict[str, int]) -> dict[str, Any]:
    total = sum(class_counts.values())
    if total < _MIN_SAMPLES:
        return {}
    overrides: dict[str, Any] = {}
    if class_counts.get("missed-ocr", 0) / total >= _TRIGGER_SHARE:
        overrides["ocr_first"] = True          # run zoom-crop re-OCR before resample
        overrides["resample_resolution_mult"] = 1.5
    if class_counts.get("sampling-miss", 0) / total >= _TRIGGER_SHARE:
        overrides["resample_width_mult"] = 1.5  # wider dense window
    if class_counts.get("wrong-timestamp", 0) / total >= _TRIGGER_SHARE:
        overrides["confidence_target_bump"] = 0.1  # verify harder before citing
    if class_counts.get("hallucination", 0) / total >= _TRIGGER_SHARE:
        overrides["confidence_floor_bump"] = 0.1   # refuse earlier
    return overrides


def update_profiles() -> None:
    """Recompute every content-type profile from current lesson stats."""
    conn = store.connect()
    try:
        rows = conn.execute(
            "SELECT content_type, error_class, COUNT(*) AS n FROM lessons "
            "GROUP BY content_type, error_class"
        ).fetchall()
        by_type: dict[str, dict[str, int]] = {}
        for row in rows:
            by_type.setdefault(row["content_type"], {})[row["error_class"]] = row["n"]
        with conn:
            conn.execute("DELETE FROM profiles")
            for content_type, class_counts in by_type.items():
                overrides = _derive_overrides(class_counts)
                if overrides:
                    conn.execute(
                        "INSERT INTO profiles (content_type, overrides, sample_count) "
                        "VALUES (?, ?, ?)",
                        (content_type, json.dumps(overrides), sum(class_counts.values())),
                    )
    finally:
        conn.close()


def get_profile(content_type: str) -> dict[str, Any]:
    """Overrides for one content-type ({} when none earned yet)."""
    conn = store.connect()
    try:
        row = conn.execute(
            "SELECT overrides FROM profiles WHERE content_type = ?", (content_type,)
        ).fetchone()
        return json.loads(row["overrides"]) if row else {}
    finally:
        conn.close()


def show_profiles() -> list[dict[str, Any]]:
    conn = store.connect()
    try:
        rows = conn.execute("SELECT * FROM profiles ORDER BY content_type").fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["overrides"] = json.loads(item["overrides"])
            out.append(item)
        return out
    finally:
        conn.close()


def reset_profiles() -> int:
    conn = store.connect()
    try:
        with conn:
            return conn.execute("DELETE FROM profiles").rowcount
    finally:
        conn.close()
