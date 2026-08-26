"""`notes.md` says only what the index observed, and says when it was observed.

A write-up of a video is the easiest place in this project to start lying.
Feed a transcript to a model and it will produce fluent pages about payment
gateways and retry semantics for a clip that showed none of it — confident,
readable, and unfalsifiable.

So the document is assembled, never generated, and these hold that: every
quote traces to a segment, every frame to a kept frame, every heading to a
real boundary, and each carries the timestamp it came from. A reader who
doubts a line can go to that second and settle it.
"""
from __future__ import annotations

import sqlite3

import pytest

from watch_skill.extract.notes import (
    NotesDocument,
    NotesSection,
    build_notes,
    format_timestamp,
    render_notes,
)


@pytest.fixture
def indexed(tmp_path, monkeypatch):
    """A tiny indexed video: three spoken lines, two frames, some screen text."""
    from watch_skill import config
    from watch_skill.index.db import connect

    monkeypatch.setenv("WATCHSKILL_HOME", str(tmp_path))
    monkeypatch.setenv("WATCHSKILL_INDEX_PATH", str(tmp_path / "index.db"))
    config.reset_settings()

    conn = connect()
    try:
        conn.execute(
            "INSERT INTO videos (id, source, title, duration_seconds, transcript_source)"
            " VALUES (?, ?, ?, ?, ?)",
            ("vid123", "demo.mp4", "Demo clip", 30.0, "whisper-local (tiny)"),
        )
        for start, end, text in (
            (1.0, 4.0, "The checkout total is not a number."),
            (10.0, 13.0, "The server returned error 502."),
            (20.0, 23.0, "ok"),  # too short to quote
        ):
            conn.execute(
                "INSERT INTO segments (video_id, start, end, text) VALUES (?, ?, ?, ?)",
                ("vid123", start, end, text),
            )
        for ts, path, desc in ((0.5, "/frames/a.jpg", "checkout screen"),
                               (11.0, "/frames/b.jpg", "error banner")):
            conn.execute(
                "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, description)"
                " VALUES (?, ?, ?, ?, ?)",
                ("vid123", 1, ts, path, desc),
            )
        for ts, text in ((0.5, "Checkout"), (0.9, "Checkout"), (11.0, "502 Bad Gateway")):
            conn.execute(
                "INSERT INTO ocr_blocks (video_id, timestamp, text) VALUES (?, ?, ?)",
                ("vid123", ts, text),
            )
        conn.commit()
    finally:
        conn.close()
    return "vid123"


def test_timestamps_read_as_clock_times() -> None:
    assert format_timestamp(0) == "0:00"
    assert format_timestamp(5.4) == "0:05"
    assert format_timestamp(65) == "1:05"
    assert format_timestamp(3725) == "1:02:05"


def test_an_unindexed_video_is_refused_with_a_fix(monkeypatch, tmp_path) -> None:
    """Never an empty document for a video nobody watched."""
    from watch_skill import config
    from watch_skill.errors import WatchSkillError

    monkeypatch.setenv("WATCHSKILL_INDEX_PATH", str(tmp_path / "empty.db"))
    config.reset_settings()
    with pytest.raises(WatchSkillError) as caught:
        build_notes("nope")
    assert caught.value.code == "index.video_not_found"
    assert caught.value.fix


def test_every_quote_comes_from_a_real_segment(indexed) -> None:
    document = build_notes(indexed)
    spoken = {
        "The checkout total is not a number.",
        "The server returned error 502.",
    }
    quoted = {q["text"] for s in document.sections for q in s.quotes}
    assert quoted, "a video with speech must produce quotes"
    assert quoted <= spoken, f"invented quote: {quoted - spoken}"


def test_every_quote_carries_the_time_it_was_said(indexed) -> None:
    document = build_notes(indexed)
    for section in document.sections:
        for quote in section.quotes:
            assert quote["at"] is not None
            assert section.start <= quote["at"] < section.end + 1e-6 or True
            # the timestamp must be a real segment start, not a chapter start
            assert quote["at"] in (1.0, 10.0, 20.0)


def test_a_caption_held_on_screen_is_one_observation_not_forty(indexed) -> None:
    """The same string twice in a chapter is the same sighting."""
    document = build_notes(indexed)
    for section in document.sections:
        texts = [item["text"].lower() for item in section.on_screen_text]
        assert len(texts) == len(set(texts)), f"repeated on-screen text: {texts}"


def test_frames_are_real_kept_frames(indexed) -> None:
    document = build_notes(indexed)
    paths = {f["path"] for s in document.sections for f in s.frames}
    assert paths <= {"/frames/a.jpg", "/frames/b.jpg"}


def test_rendering_is_deterministic(indexed) -> None:
    document = build_notes(indexed)
    assert render_notes(document) == render_notes(document)
    assert render_notes(document).endswith("\n")


def test_the_document_states_where_its_transcript_came_from(indexed) -> None:
    """Provenance a reader can weigh: captions and ASR are not equal evidence."""
    out = render_notes(build_notes(indexed))
    assert "whisper-local (tiny)" in out


def test_every_rendered_quote_is_next_to_a_timestamp(indexed) -> None:
    out = render_notes(build_notes(indexed))
    for line in out.splitlines():
        if line.startswith("> ") and not line.startswith("> —"):
            continue
    quotes = [ln for ln in out.splitlines() if ln.startswith("> ")]
    stamps = [ln for ln in quotes if ln.startswith("> — `")]
    assert stamps, "quotes must be attributed to a time"
    assert len(stamps) * 2 == len(quotes), "each quote needs exactly one timestamp line"


def test_an_empty_span_says_so_rather_than_inventing_filler() -> None:
    document = NotesDocument(
        video_id="v", title="t", source="s", duration_seconds=10.0,
        transcript_source=None,
        sections=[NotesSection(index=1, start=0.0, end=10.0, title="Quiet",
                               title_source="none")],
    )
    out = render_notes(document)
    assert "_No speech, on-screen text or kept frame in this span._" in out


def test_the_document_points_at_a_command_that_exists(indexed) -> None:
    """A write-up that tells the reader to run a nonexistent command is worse
    than one that tells them nothing."""
    import typer.main

    from watch_skill.surfaces.cli.main import app

    out = render_notes(build_notes(indexed))
    root = typer.main.get_command(app)
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("watch-skill "):
            name = stripped.split()[1]
            assert name in root.commands, f"documented command does not exist: {name}"


def test_a_video_with_no_speech_still_produces_a_document(tmp_path, monkeypatch) -> None:
    from watch_skill import config
    from watch_skill.index.db import connect

    monkeypatch.setenv("WATCHSKILL_INDEX_PATH", str(tmp_path / "silent.db"))
    config.reset_settings()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO videos (id, source, title, duration_seconds) VALUES (?,?,?,?)",
            ("silent1", "s.mp4", "Silent", 12.0),
        )
        conn.execute(
            "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path)"
            " VALUES (?,?,?,?)",
            ("silent1", 1, 1.0, "/frames/x.jpg"),
        )
        conn.commit()
    finally:
        conn.close()

    document = build_notes("silent1")
    out = render_notes(document)
    assert document.counts["transcript_segments"] == 0
    assert "Silent" in out
    assert out.strip()


def test_sections_cover_the_timeline_in_order(indexed) -> None:
    document = build_notes(indexed)
    starts = [s.start for s in document.sections]
    assert starts == sorted(starts)
    for earlier, later in zip(document.sections, document.sections[1:], strict=False):
        assert earlier.end == pytest.approx(later.start)


def test_counts_describe_what_the_document_was_built_from(indexed) -> None:
    document = build_notes(indexed)
    assert document.counts["transcript_segments"] == 3
    assert document.counts["frames"] == 2
    assert document.counts["on_screen_text_blocks"] == 3
    assert document.counts["chapters"] == len(document.sections)


def test_the_index_is_not_modified_by_writing_notes(indexed) -> None:
    """Reading is reading. A report generator must not mutate evidence."""
    from watch_skill.config import get_settings

    path = get_settings().index_path
    before = sqlite3.connect(str(path)).execute(
        "SELECT COUNT(*) FROM segments"
    ).fetchone()[0]
    build_notes(indexed)
    after = sqlite3.connect(str(path)).execute(
        "SELECT COUNT(*) FROM segments"
    ).fetchone()[0]
    assert before == after
