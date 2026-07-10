"""B3 — structured extraction: chapters, bug report, hook analysis.

All offline and deterministic: rows are inserted straight into the isolated
index; the extractors read exactly what watch+index would have stored.
"""
from __future__ import annotations

import pytest

from watch_skill.errors import IndexError_
from watch_skill.extract import analyze_hook, extract_bug_report, extract_chapters
from watch_skill.index.db import connect


def _seed(
    video_id: str = "vid1",
    duration: float = 120.0,
    scenes: list[tuple[float, str]] = (),
    segments: list[tuple[float, float, str]] = (),
    ocr: list[tuple[float, str]] = (),
) -> str:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, title, duration_seconds) VALUES (?, ?, ?, ?)",
                (video_id, f"src-{video_id}", f"video {video_id}", duration),
            )
            for i, (ts, description) in enumerate(scenes):
                conn.execute(
                    "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, description) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (video_id, i, ts, f"frames/{video_id}_{i}.jpg", description),
                )
            for start, end, text in segments:
                conn.execute(
                    "INSERT INTO segments (video_id, start, end, text) VALUES (?, ?, ?, ?)",
                    (video_id, start, end, text),
                )
            for ts, text in ocr:
                conn.execute(
                    "INSERT INTO ocr_blocks (video_id, timestamp, text) VALUES (?, ?, ?)",
                    (video_id, ts, text),
                )
    finally:
        conn.close()
    return video_id


# --- chapters ------------------------------------------------------------------

def test_chapters_from_scenes_and_transcript_gaps() -> None:
    vid = _seed(
        duration=120.0,
        scenes=[(0.0, "title card"), (40.0, "code editor view"), (80.0, "browser demo")],
        segments=[
            (1.0, 12.0, "welcome to the deep dive on caching"),
            (41.0, 55.0, "let's implement the cache layer"),
            (81.0, 100.0, "now watch it work in the browser"),
        ],
    )
    chapters = extract_chapters(vid)
    assert [c.index for c in chapters] == [1, 2, 3]
    assert [round(c.start) for c in chapters] == [0, 40, 80]
    assert chapters[-1].end == 120.0
    assert chapters[0].title.startswith("welcome to the deep dive")
    assert chapters[0].title_source == "transcript"
    # spans tile the video: each chapter ends where the next begins
    for a, b in zip(chapters, chapters[1:], strict=False):
        assert a.end == b.start


def test_chapters_min_length_merges_micro_scenes() -> None:
    vid = _seed(
        video_id="vid2",
        duration=60.0,
        scenes=[(0.0, "intro"), (1.0, "flash"), (2.0, "flash 2"), (30.0, "part two")],
    )
    chapters = extract_chapters(vid)
    starts = [c.start for c in chapters]
    assert 1.0 not in starts and 2.0 not in starts  # micro-cuts merged away
    assert 30.0 in starts


def test_chapters_title_falls_back_to_scene_then_placeholder() -> None:
    vid = _seed(video_id="vid3", duration=30.0, scenes=[(0.0, "a red dashboard")])
    chapters = extract_chapters(vid)
    assert chapters[0].title == "a red dashboard"
    assert chapters[0].title_source == "scene"

    vid_bare = _seed(video_id="vid4", duration=30.0, scenes=[(0.0, None)])
    bare = extract_chapters(vid_bare)
    assert bare[0].title_source == "none"


def test_chapters_unknown_video_is_structured_error() -> None:
    with pytest.raises(IndexError_):
        extract_chapters("nope")


# --- bug report -----------------------------------------------------------------

def test_bug_report_finds_earliest_strong_error() -> None:
    vid = _seed(
        video_id="bug1",
        duration=60.0,
        scenes=[(0.0, "app dashboard"), (20.0, "error dialog visible")],
        segments=[
            (1.0, 6.0, "let me click the deploy button"),
            (7.0, 12.0, "now we submit the form"),
        ],
        ocr=[
            (5.0, "Deploy"),
            (20.5, "ERROR 502: Bad Gateway"),
            (21.0, "at gateway.js:14"),
            (40.0, "TypeError: undefined is not a function"),
        ],
    )
    report = extract_bug_report(vid)
    assert report.found is True
    # the vision-described error dialog at 20.0 is the earliest signal;
    # the same-moment OCR window (±0.75 s) pulls in the exact 502 text
    assert report.timestamp == 20.0
    assert "502" in report.error_text
    assert report.frame_path  # a frame was located
    assert report.repro_steps and "submit the form" in report.repro_steps[-1]
    assert "20" in report.summary or "00:20" in report.summary


def test_bug_report_ignores_weak_signals_below_min_severity() -> None:
    vid = _seed(video_id="bug2", duration=30.0, ocr=[(3.0, "no errors were found today")])
    report = extract_bug_report(vid, min_severity=4)
    assert report.found is False
    assert "No on-screen error signal" in report.summary


def test_bug_report_reads_scene_descriptions_too() -> None:
    """A vision-described crash counts even when OCR saw nothing."""
    vid = _seed(
        video_id="bug3", duration=30.0,
        scenes=[(9.0, "terminal showing a python traceback and stack trace")],
    )
    report = extract_bug_report(vid)
    assert report.found is True and report.timestamp == 9.0
    assert report.severity == 5


# --- hook analysis ----------------------------------------------------------------

def test_hook_strong_open_scores_high() -> None:
    vid = _seed(
        video_id="hook1",
        duration=300.0,
        scenes=[(0.0, "creator closeup"), (4.0, "b-roll"), (9.0, "screen demo"), (14.0, "chart")],
        segments=[(0.2, 3.4, "Did you know 90% of caches are misconfigured? Here's the fix")],
        ocr=[(1.0, "90% WRONG")],
    )
    analysis = analyze_hook(vid, window_seconds=15.0)
    assert analysis.verdict == "strong"
    assert analysis.score >= 75
    assert {m.name for m in analysis.metrics} == {
        "attention_trigger", "pacing", "visual_change", "on_screen_text",
    }
    trigger = next(m for m in analysis.metrics if m.name == "attention_trigger")
    assert trigger.score >= 80  # question + number both present


def test_hook_weak_open_scores_low_with_actionable_critique() -> None:
    vid = _seed(
        video_id="hook2",
        duration=300.0,
        scenes=[(0.0, "static slide")],
        segments=[(0.5, 14.5, "hello and welcome to my channel")],
    )
    analysis = analyze_hook(vid, window_seconds=15.0)
    assert analysis.verdict in ("weak", "promising")
    visual = next(m for m in analysis.metrics if m.name == "visual_change")
    assert "Static" in visual.detail  # critique says WHAT to change


def test_hook_window_clamps_to_short_videos() -> None:
    vid = _seed(video_id="hook3", duration=8.0, scenes=[(0.0, "card")])
    analysis = analyze_hook(vid, window_seconds=15.0)
    assert analysis.window_seconds == 8.0
