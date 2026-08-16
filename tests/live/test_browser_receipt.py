"""The live browser capability receipt.

One session, one artifact, every channel accounted for. This is the test that
turns "the browser source produces DOM mutations" from a claim in a report
into something that fails the build when it stops being true.

The receipt is deliberately built from a *named* list of channels rather than
from whatever events happened to appear. A receipt derived only from what was
observed could never report that something was missing, which is the one thing
it exists to do.
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

from watch_skill.live import buffer as buf
from watch_skill.live import session as live_session
from watch_skill.live.capabilities import capability_for
from watch_skill.live.fixture_app import FixtureApp
from watch_skill.live.receipt import BROWSER_CHANNELS, browser_receipt

pytestmark = pytest.mark.timeout(600)

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


def _require_browser() -> None:
    capability = capability_for("browser")
    if capability.status != "available":
        pytest.skip(f"browser capture is {capability.status}")


def _wait_for(predicate, timeout: float, interval: float = 0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


@pytest.fixture
def app():
    _require_browser()
    with FixtureApp(splash_delay_ms=500) as running:
        yield running


def test_every_declared_browser_channel_produces_evidence(
    app, isolated_settings: Path
) -> None:
    """The capability receipt, end to end, with nothing missing.

    If this fails it names the channel that went quiet, which is the whole
    point: a live source that silently stops reporting one kind of evidence
    is indistinguishable from a page that simply did not do that thing.
    """
    session = live_session.start_live(
        f"{app.base_url}/", kind="browser", fps=3.0, audio=False,
        allow_local=True)
    try:
        # Wait for the slowest channel rather than a fixed sleep: the page
        # error is thrown on a timer, and the accessibility flip is on a
        # 900 ms interval.
        got = _wait_for(
            lambda: _has_all_event_channels(session.session_id), timeout=120.0)
        assert got, browser_receipt(session.session_id).render()

        # Cut a clip so the rolling-buffer channel has something to report.
        events = live_session.observe(session.session_id, limit=400)["events"]
        anchor = min(e["media_ts"] for e in events
                     if e["type"] == "error") if any(
                         e["type"] == "error" for e in events) else 1.0
        assert _wait_for(
            lambda: (buf.newest_frame_media_ts(session.session_id) or 0.0)
            > anchor + 3.5 or None, timeout=60.0)
        assert buf.clip_around(session.session_id, anchor, before=3.0, after=3.0)
    finally:
        live_session.stop_live(session.session_id)

    receipt = browser_receipt(session.session_id)
    assert receipt.complete, (
        f"channels with no evidence: {receipt.missing_channels}\n"
        f"{receipt.render()}")
    assert set(receipt.observed_channels) == set(BROWSER_CHANNELS)
    assert receipt.frames_captured > 0
    assert receipt.navigation_epochs >= 2, (
        "the splash-to-app navigation did not advance the epoch")
    assert receipt.page_authored_events > 0, (
        "no event was marked as page-authored, so nothing is being fenced")

    # Every channel that fired must say when, and the pixels must have
    # arrived — a receipt of empty channels is not a receipt.
    for channel in receipt.channels:
        assert channel.first_media_ts is not None, channel.channel
        assert channel.count > 0, channel.channel

    # And the same receipt, derived by a process that did not run the session.
    probe = isolated_settings.parent / "probe_receipt_channels.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.live.receipt import browser_receipt

        receipt = browser_receipt({session.session_id!r}, cross_process=True)
        print(json.dumps(receipt.to_public()))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr[-2000:]
    remote = json.loads(result.stdout.strip().splitlines()[-1])

    assert remote["complete"] is True, remote["missing"]
    assert remote["cross_process"] is True
    assert sorted(remote["observed"]) == sorted(receipt.observed_channels), (
        "a fresh process derived a different receipt from the same log")
    assert remote["totals"]["frames_captured"] == receipt.frames_captured


def _has_all_event_channels(session_id: str) -> bool:
    """Whether every channel that comes from the event log has fired yet.

    Pixels and clips are excluded: pixels are always present by the time any
    event exists, and the clip is cut deliberately by the test afterwards.
    """
    receipt = browser_receipt(session_id)
    pending = set(receipt.missing_channels) - {"clip"}
    return not pending


def test_a_receipt_reports_a_missing_channel_rather_than_omitting_it(
    tmp_path: Path,
) -> None:
    """A session that produced nothing gets a receipt full of MISSING.

    This is the failure mode the artifact exists for. A receipt that listed
    only what happened would look identical for a healthy quiet session and a
    source whose listeners were never attached.
    """
    from watch_skill.live import db
    from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec

    db.insert_session(LiveSession(
        session_id="live_silent",
        spec=LiveSourceSpec(kind=LiveSourceKind.BROWSER, target="x")))

    receipt = browser_receipt("live_silent")
    assert receipt.complete is False
    assert sorted(receipt.missing_channels) == sorted(BROWSER_CHANNELS)
    assert receipt.observed_channels == []
    assert "MISSING" in receipt.render()
    # Every declared channel still appears, with a description — the reader
    # needs to know what was expected, not just that something is absent.
    assert len(receipt.channels) == len(BROWSER_CHANNELS)
    assert all(c.description for c in receipt.channels)
