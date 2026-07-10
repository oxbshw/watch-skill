"""B5 — the shareable viewer: self-contained, offline, cites real evidence."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

pytest.importorskip("PIL", reason="perceive extra not installed")

from watch_skill.errors import IndexError_  # noqa: E402
from watch_skill.index.db import connect  # noqa: E402
from watch_skill.viewer import generate_viewer  # noqa: E402


def _seed_analyzed_video(tmp_path: Path) -> str:
    """A video row with frames on disk, transcript, OCR, and one cached answer."""
    from PIL import Image

    frames_dir = tmp_path / "frames dir"
    frames_dir.mkdir()
    frame_paths = []
    for i, color in enumerate([(200, 30, 30), (30, 30, 200)]):
        p = frames_dir / f"frame_{i}.jpg"
        Image.new("RGB", (640, 360), color).save(p)
        frame_paths.append(str(p))

    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, title, duration_seconds) "
                "VALUES ('vw1', 'https://example.com/vid', 'فيديو تجريبي Demo', 20.0)"
            )
            for i, path in enumerate(frame_paths):
                conn.execute(
                    "INSERT INTO scenes (video_id, scene_id, timestamp, frame_path, description) "
                    "VALUES ('vw1', ?, ?, ?, ?)",
                    (i, i * 8.0, path, f"scene {i} description"),
                )
            conn.execute(
                "INSERT INTO segments (video_id, start, end, text) "
                "VALUES ('vw1', 1.0, 4.0, 'welcome to the demo transcript')"
            )
            conn.execute(
                "INSERT INTO ocr_blocks (video_id, timestamp, text) "
                "VALUES ('vw1', 8.5, 'ERROR 502')"
            )
            answer = {
                "text": "The error appears at 00:08.",
                "confidence": 0.82,
                "honest_floor": False,
                "evidence": [{"timestamp": 8.0, "kind": "ocr", "text": "ERROR 502"}],
            }
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES ('vw1', 'when does the error appear?', 'when does the error appear?', ?)",
                (json.dumps(answer),),
            )
    finally:
        conn.close()
    return "vw1"


def test_viewer_is_self_contained_and_complete(tmp_path: Path) -> None:
    vid = _seed_analyzed_video(tmp_path)
    out = tmp_path / "out dir" / "viewer.html"
    path = generate_viewer(vid, out_path=out)
    assert path == out and out.is_file()
    page = out.read_text(encoding="utf-8")

    # complete: title, frames, transcript, OCR, answer + its cited evidence
    assert "فيديو تجريبي Demo" in page
    assert page.count("data:image/jpeg;base64,") == 2
    assert "welcome to the demo transcript" in page
    assert "ERROR 502" in page
    assert "when does the error appear?" in page
    assert "confidence 0.82" in page
    assert "00:08" in page  # evidence timestamp rendered

    # self-contained: nothing fetched from the network — the only external
    # reference is the footer LINK (an <a href>, not a loaded resource)
    fetched = re.findall(r'(?:src|<link[^>]*href)\s*=\s*"(http[^"]+)"', page)
    assert fetched == []
    assert "github.com/oxbshw/watch-skill" in page  # the footer link itself


def test_viewer_marks_honest_floor_answers(tmp_path: Path) -> None:
    _seed_analyzed_video(tmp_path)
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES ('vw1', 'what color is the hat?', 'hat', ?)",
                (json.dumps({"text": "not shown", "honest_floor": True, "evidence": []}),),
            )
    finally:
        conn.close()
    page = generate_viewer("vw1", out_path=tmp_path / "v.html").read_text(encoding="utf-8")
    assert "honest floor" in page


def test_viewer_survives_missing_frame_files(tmp_path: Path) -> None:
    """A pruned frames dir must not kill the page — frames just drop out."""
    vid = _seed_analyzed_video(tmp_path)
    for p in (tmp_path / "frames dir").iterdir():
        p.unlink()
    page = generate_viewer(vid, out_path=tmp_path / "v2.html").read_text(encoding="utf-8")
    assert "data:image/jpeg" not in page
    assert "welcome to the demo transcript" in page  # the rest is intact


def test_viewer_unknown_video_is_structured_error(tmp_path: Path) -> None:
    with pytest.raises(IndexError_):
        generate_viewer("nope", out_path=tmp_path / "x.html")


def test_viewer_escapes_html_in_index_text(tmp_path: Path) -> None:
    """Indexed text is untrusted (OCR of arbitrary screens) — must not inject."""
    _seed_analyzed_video(tmp_path)
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO segments (video_id, start, end, text) "
                "VALUES ('vw1', 5.0, 6.0, '<script>alert(1)</script>')"
            )
    finally:
        conn.close()
    page = generate_viewer("vw1", out_path=tmp_path / "v3.html").read_text(encoding="utf-8")
    assert "<script>alert(1)</script>" not in page
    assert "&lt;script&gt;" in page
