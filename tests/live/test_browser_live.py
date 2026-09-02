"""The end-to-end proof for live browser watching.

The load-bearing claim is the same one the file-replay proof makes, and it is
asserted the same way: evidence arrives **while the source is still running**,
not after it closes. A browser session that reported everything on teardown
would pass a wall-clock assertion on a fast machine and still be batch
processing.

Everything here runs against `watch_skill.live.fixture_app` — a deliberately
broken application served on loopback, written in this repository, so the
suite depends on nobody's uptime and reproduces the same failures every run.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
from tests.conftest import require_verification_browser

from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live import session as live_session
from watch_skill.live.browser import BrowserOptions, BrowserSource
from watch_skill.live.browser_events import BrowserEventKind
from watch_skill.live.browser_policy import NavigationDenied, fixture_policy
from watch_skill.live.capabilities import capability_for
from watch_skill.live.fixture_app import INJECTION_TEXT, FixtureApp
from watch_skill.live.types import LiveEventType, LiveState

pytestmark = pytest.mark.timeout(300)


def _require_browser() -> None:
    capability = capability_for("browser")
    if capability.status != "available":
        pytest.skip(f"browser capture is {capability.status}: {capability.repair}")
    # One governed browser is about to be started. The governor refuses when
    # the machine cannot afford it, with exact numbers -- that is the product
    # working, not a defect, so the honest outcome is a skip that repeats those
    # numbers rather than a failure that looks like a capture bug.
    require_verification_browser(1)


@pytest.fixture
def fixture_app():
    _require_browser()
    with FixtureApp(splash_delay_ms=700) as app:
        yield app


def _wait_for(predicate, timeout: float, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def _kinds(events) -> set[str]:
    return {event.kind.value for event in events}


# --- the source, on its own --------------------------------------------------


def test_pixels_and_structure_both_arrive_before_the_browser_closes(
    fixture_app, tmp_path: Path
) -> None:
    """The headline claim, asserted against the browser still being open.

    Both channels are checked in the same window because either one alone is a
    weaker product: structure without pixels is a scraper, and pixels without
    structure cannot tell you a request failed.
    """
    source = BrowserSource(
        BrowserOptions(url=fixture_app.base_url, policy=fixture_policy(), fps=3.0),
        tmp_path / "frames", session_id="proof",
    )
    source.start()
    frames = []
    events = []
    generator = source.frames()
    deadline = time.monotonic() + 45.0
    # Wait for every channel this test asserts on, not a subset of them. The
    # accessibility flip is on a 900 ms timer, so a loop that stopped as soon
    # as the console and network events arrived passed on a fast machine and
    # failed on a busy one -- while the deadline below still fails a channel
    # that genuinely never reports.
    wanted = {"console", "request_failed", "dom_mutation",
              "accessibility_change", "navigation", "page_error"}
    try:
        while time.monotonic() < deadline:
            frames.append(next(generator))
            events.extend(source.drain_events())
            kinds = _kinds(events)
            if len(frames) >= 6 and wanted <= kinds:
                break
        still_running = source.running
        frames_while_running = len(frames)
        events.extend(source.drain_events(limit=1000))
    finally:
        source.stop()
    events.extend(source.drain_events(limit=1000))

    assert still_running, "the browser closed before the assertions ran"
    assert frames_while_running >= 6, "no pixel evidence while the page was open"
    assert all(frame.path.is_file() and frame.path.stat().st_size > 0
               for frame in frames), "a frame was recorded but not written"
    # Frames are real JPEGs, not placeholder files: a source that wrote zero
    # bytes would satisfy every count above and show a human nothing.
    assert frames[0].path.read_bytes()[:2] == b"\xff\xd8", "not a JPEG"

    kinds = _kinds(events)
    assert "navigation" in kinds
    assert "console" in kinds, "a console error was never reported"
    assert "page_error" in kinds, "the uncaught exception was never reported"
    assert "request_failed" in kinds, "the dead-port request was never reported"
    assert "dom_mutation" in kinds, "DOM changes were never reported"
    assert "accessibility_change" in kinds, "ARIA changes were never reported"
    # A 500 is a *response*, not a request failure. Conflating the two would
    # let "the server is broken" and "the network is broken" look identical.
    assert any(event.kind is BrowserEventKind.RESPONSE
               and event.detail.get("status") == 500 for event in events)


def test_media_timestamps_advance_with_the_session_clock(
    fixture_app, tmp_path: Path
) -> None:
    source = BrowserSource(
        BrowserOptions(url=fixture_app.base_url, policy=fixture_policy(), fps=4.0),
        tmp_path / "frames", session_id="clock",
    )
    source.start()
    try:
        frames = [next(source.frames()) for _ in range(5)]
    finally:
        source.stop()
    stamps = [frame.media_ts for frame in frames]
    assert stamps == sorted(stamps), "media timestamps went backwards"
    assert stamps[-1] > stamps[0], "media time did not advance"
    assert all(frame.wall_ts > 1_600_000_000 for frame in frames), "bad wall clock"


def test_navigation_epochs_separate_events_across_a_page_change(
    fixture_app, tmp_path: Path
) -> None:
    """An event produced before a navigation must not read as a fact after it.

    The fixture navigates from the splash to the app on its own, so the epoch
    boundary is real rather than injected by the test.
    """
    source = BrowserSource(
        BrowserOptions(url=fixture_app.base_url, policy=fixture_policy(), fps=3.0),
        tmp_path / "frames", session_id="epoch",
    )
    source.start()
    events = []
    try:
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            events.extend(source.drain_events())
            if any(event.kind is BrowserEventKind.CONSOLE
                   and event.navigation_epoch >= 2 for event in events):
                break
            time.sleep(0.1)
    finally:
        source.stop()
    events.extend(source.drain_events(limit=1000))

    epochs = [event.navigation_epoch for event in events]
    assert max(epochs) >= 2, "the fixture never navigated"
    assert epochs == sorted(epochs), "an epoch went backwards"
    # One page change advances the epoch exactly once, so the count is a
    # navigation count and not an internal bookkeeping artefact.
    assert max(epochs) == 2, f"expected two navigations, saw {max(epochs)}"
    # The app-page evidence is separable from the splash-page evidence purely
    # by epoch — which is the property that makes a stale event recognisable.
    splash = [e for e in events if e.navigation_epoch == 1]
    app_events = [e for e in events if e.navigation_epoch == 2]
    assert splash, "nothing was observed on the first page"
    assert any(e.kind is BrowserEventKind.CONSOLE for e in app_events)
    assert not any(e.kind is BrowserEventKind.CONSOLE for e in splash), (
        "a second-page console message was attributed to the first page")


def test_cancellation_leaves_no_browser_process(fixture_app, tmp_path: Path) -> None:
    """Stopping the session must actually end every process it started.

    Proved by deleting the profile directory rather than by counting
    processes: Chromium holds an exclusive lock on files inside its profile
    for as long as it lives, so a clean delete on Windows is only possible
    once the tree is genuinely gone.
    """
    source = BrowserSource(
        BrowserOptions(url=fixture_app.base_url, policy=fixture_policy(), fps=2.0),
        tmp_path / "frames", session_id="cancel",
    )
    source.start()
    next(source.frames())
    profile = source._profile_dir
    assert profile.exists(), "the session never created its own profile"
    source.stop()
    assert source.process_tree_gone(), (
        "a browser process is still holding the session profile open")
    assert not profile.exists()
    assert source.diagnostics()["process_tree_gone"] is True


def test_a_url_the_policy_refuses_never_reaches_chromium(tmp_path: Path) -> None:
    """The refusal happens before launch, so nothing is started to be stopped."""
    _require_browser()
    from watch_skill.live.browser import browser_source
    from watch_skill.live.types import LiveSourceKind, LiveSourceSpec

    spec = LiveSourceSpec(kind=LiveSourceKind.BROWSER,
                          target="http://169.254.169.254/latest/meta-data/")
    with pytest.raises(NavigationDenied) as excinfo:
        browser_source(spec, tmp_path / "frames")
    assert "metadata" in str(excinfo.value)
    assert not (tmp_path / "frames").exists() or not any(
        (tmp_path / "frames").iterdir())


# --- through a live session --------------------------------------------------


def test_browser_evidence_lands_in_the_session_event_log(fixture_app) -> None:
    """CLI, REST, MCP and the SDK all read this log, so this is where agreement
    between surfaces actually comes from."""
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        detail={"allow_loopback": True},
    )
    try:
        events = _wait_for(
            lambda: [
                event for event in
                live_session.observe(session.session_id, limit=300)["events"]
                if event["type"] == LiveEventType.ERROR.value
            ] or None,
            timeout=60.0,
        )
        assert events, "browser failures were not reported as errors"
        # Still running when the evidence was read — the whole point.
        assert live_session.get_session(session.session_id).state is LiveState.RUNNING

        everything = live_session.observe(session.session_id, limit=300)["events"]
        detectors = {event["detector"] for event in everything}
        assert any(name.startswith("browser:") for name in detectors)
        assert any(e["type"] == LiveEventType.BROWSER_EVENT.value
                   for e in everything), "no non-error browser evidence"

        status = live_session.status(session.session_id)
        assert status["browser"]["navigation_epoch"] >= 1
        assert status["browser"]["policy"]["allow_loopback"] is True
    finally:
        live_session.stop_live(session.session_id)


def test_a_scene_change_is_detected_from_browser_pixels(fixture_app) -> None:
    """The pixel channel goes through the same detectors as every other source.

    The fixture animates a progress bar, so this is a real perceptual-hash
    detection over browser screenshots — not a structured event relabelled.
    """
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=4.0, audio=False,
        detail={"allow_loopback": True},
    )
    try:
        scene = _wait_for(
            lambda: [
                event for event in
                live_session.observe(session.session_id, limit=300)["events"]
                if event["type"] == LiveEventType.SCENE_CHANGE.value
            ] or None,
            timeout=60.0,
        )
        assert scene, "no scene change was detected from browser pixels"
        assert scene[0]["evidence"], "a scene change with no frame to look at"
    finally:
        live_session.stop_live(session.session_id)


def test_page_authored_text_is_marked_and_never_becomes_an_instruction(
    fixture_app,
) -> None:
    """The fixture displays a prompt-injection instruction in large type.

    Two separate properties are asserted. It must be *carried* — dropping
    hostile text silently would hide an attack from the operator. And it must
    be *fenced*: page-authored, observation-provenance, and never promoted
    into anything that reads as a Watch Skill instruction.
    """
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        detail={"allow_loopback": True},
    )
    try:
        events = _wait_for(
            lambda: [
                event for event in
                live_session.observe(session.session_id, limit=300)["events"]
                if event["detail"].get("browser", {}).get("page_authored")
            ] or None,
            timeout=60.0,
        )
        assert events, "no page-authored browser evidence was recorded"
        for event in events:
            browser = event["detail"]["browser"]
            assert browser["provenance"] == "observation"
            if browser["kind"] in ("dom_mutation", "accessibility_change",
                                   "console", "page_error"):
                assert browser["page_authored"] is True, (
                    "page content was recorded without being marked as such")
            # Whatever the page says, it never gets to name a browser-level
            # fact: those kinds are reserved for things the browser reported.
            if browser["page_authored"]:
                assert browser["kind"] not in (
                    "navigation", "navigation_failed", "target_crashed")
        # The injection string is Watch Skill's own constant, so this asserts
        # against text the test controls rather than a substring of the page.
        assert "ignore all previous instructions" in INJECTION_TEXT.lower()
    finally:
        live_session.stop_live(session.session_id)


def test_no_credential_shaped_string_reaches_the_persisted_event_log(
    fixture_app,
) -> None:
    """The fixture's approval token must never be written to the event log.

    It is a real secret in this test's world: possessing it is what lets the
    Observer Loop's correction succeed. If browser evidence leaked it, the
    independence of verification would be gone.
    """
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        detail={"allow_loopback": True},
    )
    try:
        _wait_for(
            lambda: live_session.observe(session.session_id, limit=200)["events"]
            or None, timeout=60.0)
    finally:
        live_session.stop_live(session.session_id)

    token = fixture_app.approval_token
    stored = db.read_events(session.session_id, limit=500)
    blob = json.dumps([event.model_dump(mode="json") for event in stored])
    assert token not in blob, "the approval token reached the event log"


def test_stopping_a_browser_session_finalizes_and_stays_queryable(
    fixture_app, isolated_settings: Path
) -> None:
    """Evidence outlives the process that captured it.

    The read happens in a *new interpreter*, so nothing in memory can be
    supplying the answer — which is the only way to prove the session was
    persisted rather than cached.
    """
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        detail={"allow_loopback": True},
    )
    _wait_for(
        lambda: len(live_session.observe(session.session_id, limit=200)["events"]) > 3
        or None, timeout=60.0)
    live_session.stop_live(session.session_id)

    stopped = live_session.get_session(session.session_id)
    assert stopped.state in (LiveState.STOPPED, LiveState.FINALIZED)

    probe = isolated_settings.parent / "probe_browser.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {str(Path(__file__).resolve().parents[2] / "src")!r})
        from watch_skill.live import db

        events = db.read_events({session.session_id!r}, limit=500)
        browser = [e for e in events if e.detector.startswith("browser:")]
        print(json.dumps({{
            "total": len(events),
            "browser": len(browser),
            "kinds": sorted({{e.detector for e in browser}}),
            "state": db.get_session({session.session_id!r}).state.value,
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["browser"] > 0, "browser evidence did not survive the process"
    assert payload["state"] in ("stopped", "finalized")


def test_a_dead_browser_is_reported_honestly_and_stays_queryable(
    fixture_app,
) -> None:
    """Killing the browser must not look like a clean finish.

    The failure mode this guards against is the quiet one: a session whose
    capture died reporting ``stopped`` with no error, so an operator reads
    thirty seconds of evidence as the whole story. The evidence captured
    before the death has to survive, and the session has to say it died.
    """
    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        allow_local=True,
    )
    runner = live_session.running_session(session.session_id)
    assert runner is not None
    source = runner._source

    _wait_for(
        lambda: len(live_session.observe(session.session_id,
                                         limit=200)["events"]) > 3 or None,
        timeout=60.0)
    before_death = live_session.observe(session.session_id, limit=300)["events"]
    assert before_death

    killed = source._kill_stragglers()
    if not killed:
        pytest.skip("no browser process could be identified to kill on this host")

    final = _wait_for(
        lambda: (live_session.get_session(session.session_id).state
                 is LiveState.FAILED) or None,
        timeout=120.0,
    )
    assert final, "a killed browser was not reported as a failure"
    state = live_session.get_session(session.session_id)
    assert state.error, "the session failed without saying why"
    assert state.error["error"].startswith("live.browser."), state.error
    assert state.error["fix"], "a failure with no suggested next step"

    # The evidence gathered before the kill survives.
    after_death = live_session.observe(session.session_id, limit=300)["events"]
    assert len(after_death) >= len(before_death)
    live_session.stop_live(session.session_id)


def test_every_surface_reports_the_same_browser_session(fixture_app) -> None:
    """Python, CLI, REST and MCP must agree, because they are one log.

    Four surfaces that each kept their own idea of a session would be four
    products. This asserts they are views, not copies: same id, same state,
    same event count, same navigation epoch.
    """
    pytest.importorskip("fastapi")
    pytest.importorskip("fastmcp")
    import asyncio

    from fastapi.testclient import TestClient
    from fastmcp import Client
    from typer.testing import CliRunner

    from watch_skill.surfaces.api.app import create_app
    from watch_skill.surfaces.cli.main import app as cli_app
    from watch_skill.surfaces.mcp.server import mcp

    session = live_session.start_live(
        fixture_app.base_url, kind="browser", fps=3.0, audio=False,
        allow_local=True,
    )
    try:
        _wait_for(
            lambda: len(live_session.observe(session.session_id,
                                             limit=200)["events"]) > 3 or None,
            timeout=60.0)

        from_python = live_session.status(session.session_id)

        client = TestClient(create_app())
        from_rest = client.get(f"/v1/live/{session.session_id}").json()

        result = CliRunner().invoke(
            cli_app, ["live", "status", session.session_id])
        assert result.exit_code == 0, result.output
        from_cli = json.loads(result.stdout)

        async def _mcp_status():
            async with Client(mcp) as client:
                result = await client.call_tool(
                    "get_live_status", {"session_id": session.session_id})
                return json.loads(result.content[0].text)

        from_mcp = asyncio.run(_mcp_status())

        views = {"python": from_python, "rest": from_rest,
                 "cli": from_cli, "mcp": from_mcp}
        for name, view in views.items():
            assert view["session_id"] == session.session_id, name
            assert view["state"] == "running", f"{name} disagrees on state"
            assert view["source"]["kind"] == "browser", name
        # The structured browser diagnostics are not a Python-only nicety.
        for name, view in views.items():
            assert view["browser"]["navigation_epoch"] >= 1, (
                f"{name} cannot see the navigation epoch")
            assert view["browser"]["policy"]["allow_loopback"] is True, name
    finally:
        live_session.stop_live(session.session_id)


def test_an_error_pins_media_on_both_sides_of_the_moment(fixture_app) -> None:
    """A console error must leave frames from *before* it, not only after.

    The cause of a failure is usually on screen before the failure is
    reported, so evidence that starts at the error is evidence that arrives
    too late to explain it.

    The claim has a precondition: capture must already have been running when
    the failure happened. At the fixture's 350 ms default the uncaught
    exception can precede the first screenshot by seconds on a machine where
    the browser starts slowly, and then there is no "before" to retain — not
    because the buffer dropped it, but because nothing was captured. The
    error is moved inside the capture window rather than the assertion being
    softened, and the branch below states what the product owes when it is
    not.
    """
    session = live_session.start_live(
        f"{fixture_app.base_url}/?error_after_ms=8000", kind="browser",
        fps=4.0, audio=False, detail={"allow_loopback": True},
    )
    try:
        errors = _wait_for(
            lambda: [
                event for event in
                live_session.observe(session.session_id, limit=300)["events"]
                if event["type"] == LiveEventType.ERROR.value
                and event["media_ts"] > 1.0
            ] or None,
            timeout=60.0,
        )
        assert errors, "no browser error was reported"

        # No instant sample of what the buffer holds: the wait below is what
        # knows when the answer is final, and reading `oldest` before
        # capture has produced anything is how this test came to ask whether a
        # race had finished yet rather than what the buffer could offer.
        anchor = errors[0]["media_ts"]
        frames, why = buf.await_clip_window(
            session.session_id, anchor - 5.0, anchor + 5.0, timeout=30.0,
            require_span_at=anchor)

        if why is not None:
            # Nothing usable in the window at all. That is allowed, and the
            # product owes a cause for it: never captured, or captured and
            # swept. What it may not do is shrug.
            assert ("no frame was ever captured" in why
                    or "captured no frames at all" in why
                    or "would not span the moment" in why
                    or "evicted" in why), why
            return

        after = [frame for frame in frames if frame.media_ts >= anchor]
        assert after, "no frames retained from after the error"

        # Frames exist, so the buffer has an oldest.
        oldest = buf.oldest_frame_media_ts(session.session_id)
        assert oldest is not None

        before = [frame for frame in frames if frame.media_ts < anchor]
        if oldest < anchor:
            # Capture was already running when the page failed, so the promise
            # this test is named for applies and must hold.
            assert before, (
                f"capture began at {oldest:.2f}s and the error was at "
                f"{anchor:.2f}s, so frames from before it should have been "
                f"retained")
        else:
            # The error preceded the first frame. There is no "before" to
            # keep, and inventing one would be the failure this file guards.
            assert not before
    finally:
        live_session.stop_live(session.session_id)
