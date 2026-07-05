"""VTT parsing, rolling dedupe, range filtering, chunk planning with overlap."""
from __future__ import annotations

from pathlib import Path

from watch_skill.transcribe.audio import CHUNK_OVERLAP_SECONDS, plan_chunks
from watch_skill.transcribe.cloud import merge_overlapping
from watch_skill.transcribe.types import Segment, Transcript
from watch_skill.transcribe.vtt import parse_vtt

SAMPLE_VTT = """WEBVTT

00:00:00.000 --> 00:00:02.000
hello world

00:00:02.000 --> 00:00:04.000
hello world

00:00:04.000 --> 00:00:06.000
hello world and more

00:00:06.000 --> 00:00:08.000
<c.color>tagged</c> text
"""


def _write_vtt(tmp_path: Path) -> Path:
    path = tmp_path / "subs dir with spaces" / "sample.en.vtt"
    path.parent.mkdir(parents=True)
    path.write_text(SAMPLE_VTT, encoding="utf-8")
    return path


def test_parse_vtt_collapses_rolling_duplicates(tmp_path: Path) -> None:
    transcript = parse_vtt(_write_vtt(tmp_path))
    texts = [s.text for s in transcript.segments]
    # "hello world" x2 collapse to one; the extension merges into it
    assert texts == ["hello world and more", "tagged text"]
    assert transcript.segments[0].start == 0.0
    assert transcript.segments[0].end == 6.0
    assert transcript.source == "captions"


def test_filter_range_keeps_overlapping_segments() -> None:
    transcript = Transcript(
        segments=[Segment(0, 5, "a"), Segment(5, 10, "b"), Segment(10, 15, "c")],
        source="captions",
    )
    filtered = transcript.filter_range(6, 11)
    assert [s.text for s in filtered.segments] == ["b", "c"]
    assert filtered.source == "captions"


def test_formatted_timestamps() -> None:
    transcript = Transcript(segments=[Segment(65, 70, "line one")])
    assert transcript.formatted() == "[01:05] line one"


def test_plan_chunks_single_when_small() -> None:
    assert plan_chunks(60.0, 1000) == [(0.0, 60.0)]


def test_plan_chunks_overlap() -> None:
    max_bytes = 1000
    plan = plan_chunks(100.0, 2500, max_bytes=max_bytes)
    assert len(plan) == 3
    # chunk n>0 starts CHUNK_OVERLAP_SECONDS before the previous chunk's end
    first_end = plan[0][0] + plan[0][1]
    assert abs(plan[1][0] - (first_end - CHUNK_OVERLAP_SECONDS)) < 0.01
    # full coverage: last chunk reaches the end
    assert abs((plan[-1][0] + plan[-1][1]) - 100.0) < 0.01


def test_merge_overlapping_drops_echoes() -> None:
    chunk_a = [Segment(0, 10, "first"), Segment(10, 20, "boundary words")]
    chunk_b = [Segment(18.5, 20, "boundary words"), Segment(20, 30, "second")]
    merged = merge_overlapping([chunk_a, chunk_b])
    assert [s.text for s in merged] == ["first", "boundary words", "second"]


def test_merge_overlapping_keeps_distinct_text_at_boundary() -> None:
    chunk_a = [Segment(0, 20, "first")]
    chunk_b = [Segment(19.5, 30, "different words")]
    merged = merge_overlapping([chunk_a, chunk_b])
    assert len(merged) == 2


def test_extract_audio_windowed(sample_video, tmp_path) -> None:
    """Regression: a focused watch (end=60s) transcribed the WHOLE audio —
    tens of wasted CPU-minutes on long videos. The window must be cut at
    extraction time."""
    from watch_skill.transcribe.audio import audio_duration, extract_audio

    full = extract_audio(sample_video, tmp_path / "full.mp3")
    windowed = extract_audio(
        sample_video, tmp_path / "win.mp3", start_seconds=2.0, end_seconds=6.0
    )
    assert audio_duration(full) > 10
    assert 3.0 <= audio_duration(windowed) <= 5.0  # ~4s window


def test_transcript_offset_shifts_timestamps() -> None:
    from watch_skill.transcribe.types import Segment, Transcript

    t = Transcript(segments=[Segment(0.0, 2.0, "hello"), Segment(3.0, 5.0, "world")])
    shifted = t.offset(120.0)
    assert shifted.segments[0].start == 120.0
    assert shifted.segments[1].end == 125.0
    assert t.segments[0].start == 0.0  # original untouched
    assert t.offset(0.0) is t
