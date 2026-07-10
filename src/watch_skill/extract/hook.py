"""Hook analysis: score the first N seconds of an indexed video.

For content creators: does the opening earn attention? Deterministic metrics
over what the index already stores — speech pacing, an attention trigger in
the first line, visual change rate, on-screen text — each scored and
critiqued, then combined. Same index, same score.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from watch_skill.errors import IndexError_
from watch_skill.index.db import connect
from watch_skill.index.store import get_video

_TRIGGER_RE = re.compile(
    r"\?|^(how|why|what|imagine|stop|wait|listen|did you|have you|this is)\b"
    r"|\b(secret|mistake|never|always|nobody|everyone|free|new|proven|in \d+ (seconds|minutes|days))\b"
    r"|\b\d+([.,]\d+)?(%|x)?\b",
    re.IGNORECASE,
)


@dataclass
class HookMetric:
    """One scored dimension of the hook."""

    name: str
    score: int  # 0-100
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return vars(self)


@dataclass
class HookAnalysis:
    """The hook verdict for the first N seconds."""

    video_id: str
    window_seconds: float
    score: int
    verdict: str  # strong | promising | weak
    metrics: list[HookMetric] = field(default_factory=list)
    first_line: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id,
            "window_seconds": self.window_seconds,
            "score": self.score,
            "verdict": self.verdict,
            "first_line": self.first_line,
            "metrics": [m.to_dict() for m in self.metrics],
        }


def _pacing_metric(segments: list[dict], window: float) -> HookMetric:
    words = sum(len(s["text"].split()) for s in segments)
    speech_span = sum(min(s["end"], window) - s["start"] for s in segments)
    if words == 0:
        return HookMetric("pacing", 25, "No speech in the opening — the visuals must carry it alone.")
    wps = words / max(speech_span, 1e-6)
    if wps >= 3.5:
        return HookMetric("pacing", 90, f"Fast delivery ({wps:.1f} words/s) — urgency reads well.")
    if wps >= 2.2:
        return HookMetric("pacing", 70, f"Conversational pace ({wps:.1f} words/s).")
    return HookMetric("pacing", 40, f"Slow open ({wps:.1f} words/s) — viewers decide in seconds.")


def _trigger_metric(first_line: str) -> HookMetric:
    if not first_line:
        return HookMetric("attention_trigger", 30, "No opening line to hook with.")
    match = _TRIGGER_RE.search(first_line)
    if match:
        return HookMetric(
            "attention_trigger", 85,
            f"Opening line carries a trigger ({match.group(0)!r}): question/number/promise.",
        )
    return HookMetric(
        "attention_trigger", 45,
        "Opening line is declarative — no question, number, or promise to pull viewers in.",
    )


def _visual_metric(scene_count: int, window: float) -> HookMetric:
    rate = scene_count / max(window, 1e-6) * 10  # changes per 10 s
    if rate >= 2:
        return HookMetric("visual_change", 85, f"{scene_count} visual changes in the window — dynamic open.")
    if rate >= 1:
        return HookMetric("visual_change", 60, f"{scene_count} visual change(s) — moderate energy.")
    return HookMetric("visual_change", 35, "Static opening visuals — consider an earlier cut or motion.")


def _text_metric(ocr_texts: list[str]) -> HookMetric:
    joined = " ".join(ocr_texts).strip()
    if not joined:
        return HookMetric("on_screen_text", 45, "No on-screen text — a title card or caption can anchor the topic.")
    return HookMetric(
        "on_screen_text", 75,
        f"On-screen text present ({joined[:60]!r}) — reinforces the topic for muted viewers.",
    )


def analyze_hook(video_id_or_source: str, window_seconds: float = 15.0) -> HookAnalysis:
    """Score + critique the first ``window_seconds`` of an indexed video."""
    video = get_video(video_id_or_source)
    if video is None:
        raise IndexError_(
            f"video not indexed: {video_id_or_source}",
            code="index.video_not_found",
            fix="run watch_video on it first, or list_videos()",
        )
    duration = float(video.get("duration_seconds") or 0.0)
    window = min(window_seconds, duration) if duration > 0 else window_seconds
    conn = connect()
    try:
        segments = [dict(r) for r in conn.execute(
            "SELECT start, end, text FROM segments WHERE video_id = ? AND start < ? ORDER BY start",
            (video["id"], window),
        ).fetchall()]
        scene_count = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ? AND timestamp < ?",
            (video["id"], window),
        ).fetchone()["n"]
        ocr_texts = [
            r["text"] for r in conn.execute(
                "SELECT text FROM ocr_blocks WHERE video_id = ? AND timestamp < ? ORDER BY timestamp",
                (video["id"], window),
            )
        ]
    finally:
        conn.close()

    first_line = segments[0]["text"].strip() if segments else ""
    metrics = [
        _trigger_metric(first_line),
        _pacing_metric(segments, window),
        _visual_metric(scene_count, window),
        _text_metric(ocr_texts),
    ]
    # the trigger is what earns the click; weight it double
    weights = {"attention_trigger": 2, "pacing": 1, "visual_change": 1, "on_screen_text": 1}
    total_weight = sum(weights[m.name] for m in metrics)
    score = round(sum(m.score * weights[m.name] for m in metrics) / total_weight)
    verdict = "strong" if score >= 75 else "promising" if score >= 55 else "weak"
    return HookAnalysis(
        video_id=video["id"], window_seconds=round(window, 2),
        score=score, verdict=verdict, metrics=metrics, first_line=first_line,
    )
