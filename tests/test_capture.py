"""Real capture-layer tests: Playwright against a local HTML file (offline)
and file adoption. Screen capture (gdigrab) is exercised only when a desktop
session is available."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("playwright", reason="loop extra not installed")

from watch_skill.loop.capture import capture, capture_file  # noqa: E402

_HTML = """<!doctype html>
<html><head><style>
  body { font-family: sans-serif; background: #202030; color: white; }
  .box { width: 300px; height: 120px; background: #4caf50; margin: 40px; }
</style></head>
<body><h1>Watch Skill capture test page</h1><div class="box"></div>
<p style="margin-top:900px">bottom of the page</p></body></html>
"""


@pytest.fixture()
def local_page(tmp_path: Path) -> str:
    page = tmp_path / "page dir with spaces" / "test page.html"
    page.parent.mkdir(parents=True)
    page.write_text(_HTML, encoding="utf-8")
    return page.resolve().as_uri()  # file:///F:/... with %20 escapes


@pytest.mark.timeout(180)
def test_capture_local_page_records_video(local_page: str, tmp_path: Path) -> None:
    result = capture(local_page, tmp_path / "cap out", duration_seconds=3.0)
    assert result.kind == "url"
    assert result.video_path.is_file()
    assert result.video_path.stat().st_size > 5000


@pytest.mark.timeout(180)
def test_capture_with_interaction_script(local_page: str, tmp_path: Path) -> None:
    script = [
        {"action": "wait", "seconds": 0.5},
        {"action": "scroll", "dy": 700},
        {"action": "wait", "seconds": 0.5},
    ]
    result = capture(local_page, tmp_path / "cap scripted", script=script, duration_seconds=3.0)
    assert result.meta["scripted"] is True
    assert result.video_path.is_file()


def test_capture_file_adoption(sample_video: Path, tmp_path: Path) -> None:
    result = capture_file(sample_video, tmp_path / "adopt dir")
    assert result.kind == "file"
    assert result.video_path.is_file()
    assert result.video_path.parent == tmp_path / "adopt dir"
