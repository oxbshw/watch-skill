"""One loop run as a page: what changed between iterations, and why.

The before/after GIF proves a verdict flipped. It cannot say which issue
went away, whether the fix introduced a new one, or what the critic was
looking at when it decided — and that is the part someone reviewing the run
actually needs.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.errors import LoopError
from watch_skill.loop.viewer import _delta_html, generate_loop_viewer, render_loop_html


def _critique(verdict: str, score: float, summary: str, issues: list[dict]) -> dict:
    return {"verdict": verdict, "score": score, "summary": summary, "issues": issues}


NAN = {
    "timestamp": 9.0,
    "severity": "critical",
    "description": "Total renders as $NaN after clicking Pay",
    "suggested_fix": "Await the price promise",
}
SPINNER = {
    "timestamp": 12.0,
    "severity": "minor",
    "description": "Spinner overlaps the submit button",
    "suggested_fix": "Raise the z-index",
}


@pytest.fixture()
def loop_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    from watch_skill import config
    from watch_skill.loop.runner import LoopState

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    state = LoopState(
        loop_id="run-1",
        target="browser:http://127.0.0.1:3000/checkout",
        pass_criteria="The total is always a valid currency amount",
        script=None,
        max_iterations=3,
        duration_seconds=8.0,
        status="passed",
    )
    empty = {"source": "cap", "engine": "scene", "frames": []}
    state.iterations = [
        {"n": 0, "video": "a.webm", "capture_kind": "browser", "perception": empty,
         "critique": _critique("fail", 0.35, "Total flashes $NaN", [NAN, SPINNER]),
         "diff": None, "artifacts": None},
        {"n": 1, "video": "b.webm", "capture_kind": "browser", "perception": empty,
         "critique": _critique("pass", 0.94, "Total stays valid", [SPINNER]),
         "diff": None, "artifacts": None},
    ]
    state.save()
    return state.loop_id


def test_the_page_says_what_the_fix_changed(loop_run: str) -> None:
    """fixed / introduced / still there — the reason the verdict moved."""
    _, page = render_loop_html(loop_run)
    assert "fixed (1)" in page.lower()
    assert "introduced (0)" in page.lower(), "a fix that broke nothing must say so"
    assert "still there (1)" in page.lower()
    assert "$NaN" in page and "Spinner" in page


def test_both_verdicts_are_on_the_page(loop_run: str) -> None:
    _, page = render_loop_html(loop_run)
    assert page.count("iteration 0") >= 1
    assert page.count("iteration 1") >= 1
    assert "fail" in page and "pass" in page


def test_severity_and_suggested_fix_survive(loop_run: str) -> None:
    """A critique with no fix text is an observation, not something to act on."""
    _, page = render_loop_html(loop_run)
    assert "critical" in page
    assert "Await the price promise" in page


def test_a_loop_with_no_iterations_is_a_structured_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from watch_skill import config
    from watch_skill.loop.runner import LoopState

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()
    LoopState(
        loop_id="empty", target="t", pass_criteria="c", script=None,
        max_iterations=3, duration_seconds=8.0,
    ).save()

    with pytest.raises(LoopError) as exc:
        render_loop_html("empty")
    assert exc.value.code == "loop.empty"
    assert exc.value.fix


def test_an_unknown_loop_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()
    with pytest.raises(LoopError) as exc:
        render_loop_html("never-existed")
    assert exc.value.code == "loop.not_found"


def test_the_page_is_self_contained(loop_run: str, tmp_path: Path) -> None:
    """It gets attached to tickets and opened months later, offline."""
    dest = generate_loop_viewer(loop_run, out_path=tmp_path / "loop.html")
    page = dest.read_text(encoding="utf-8")
    assert dest.is_file()
    external = [
        line for line in page.splitlines()
        if ("src=\"http" in line) or ("<link" in line and "http" in line)
    ]
    assert not external, f"the page reaches out to the network: {external[:2]}"


def test_the_first_iteration_has_nothing_to_compare_against() -> None:
    """No prior critique means no delta, not an empty three-column table."""
    assert _delta_html(None, _critique("fail", 0.1, "x", [NAN])) == ""


def test_a_regression_is_reported_as_introduced() -> None:
    """The loop can make things worse; the page must not hide that."""
    html = _delta_html(_critique("fail", 0.4, "", [NAN]), _critique("fail", 0.3, "", [SPINNER]))
    assert "fixed (1)" in html.lower()
    assert "introduced (1)" in html.lower()
    assert "Spinner" in html
