"""Live capture of a controlled window on this Windows machine.

Machine-tested, not probed: a real Tk window is created by this test,
displaying only generated content, and captured through the production
gdigrab path into the live pipeline. Nothing on the operator's actual desktop
is recorded — the capture is scoped to a window this test owns and destroys.

Skipped where there is no interactive display, because a window that cannot be
shown cannot be captured, and pretending otherwise would be the exact
dishonesty `capture-capabilities` exists to prevent.
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")
FIXTURE_TITLE = "WatchSkillCaptureFixture"

pytestmark = pytest.mark.skipif(
    platform.system() != "Windows",
    reason="gdigrab window capture is implemented for Windows only",
)


def _has_display() -> bool:
    try:
        import tkinter  # noqa: PLC0415

        root = tkinter.Tk()
        root.withdraw()
        root.destroy()
    except Exception:  # noqa: BLE001
        return False
    return True


requires_display = pytest.mark.skipif(
    not _has_display(),
    reason="no interactive display; a window that cannot be shown cannot be "
    "captured, and this path must not be reported as tested",
)


class FixtureWindow:
    """A synthetic window in its own process.

    A process, not a thread: Tk is not thread-safe, and driving it from a
    background thread while pytest runs on the main one segfaults the
    interpreter on Windows.
    """

    SCRIPT = Path(__file__).parent / "_fixture_window.py"

    def __init__(self, title: str = FIXTURE_TITLE, seconds: float = 45.0,
                 flip_after: float = 3.0) -> None:
        self.title = title
        self.seconds = seconds
        self.flip_after = flip_after
        self._proc: subprocess.Popen | None = None

    def __enter__(self) -> FixtureWindow:
        self._proc = subprocess.Popen(
            [sys.executable, str(self.SCRIPT), "--title", self.title,
             "--seconds", str(self.seconds), "--flip-after", str(self.flip_after)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        from watch_skill.live.source import window_exists

        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if window_exists(self.title):
                time.sleep(0.6)  # let the compositor settle
                return self
            if self._proc.poll() is not None:
                raise AssertionError(
                    f"the fixture window exited: {self._proc.stderr.read()[-500:]}"
                )
            time.sleep(0.2)
        raise AssertionError("the fixture window never appeared")

    def close(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def __exit__(self, *exc: object) -> None:
        self.close()


# --- identity and refusal -----------------------------------------------------


def test_a_missing_window_fails_before_a_session_exists() -> None:
    """A typo must not create a session that silently emits nothing."""
    from watch_skill.live import session as live_session
    from watch_skill.live.source import CaptureError

    with pytest.raises(CaptureError) as raised:
        live_session.start_live("window:NoSuchWindowAtAll", kind="window")
    assert raised.value.code in ("live.source_not_found", "live.capture_unavailable")
    assert raised.value.fix
    assert live_session.list_live(active_only=True) == []


@requires_display
def test_window_lookup_matches_the_exact_title() -> None:
    """Substring matching would let a request for one window take another."""
    from watch_skill.live.source import window_exists

    with FixtureWindow():
        assert window_exists(FIXTURE_TITLE) is True
        assert window_exists(FIXTURE_TITLE[:-4]) is False, "matched a prefix"
        assert window_exists(FIXTURE_TITLE.lower()) is False, "matched case-insensitively"


@requires_display
def test_capture_never_falls_back_to_the_whole_desktop() -> None:
    """The privacy property.

    A request to watch one window that quietly becomes a recording of
    everything on screen is a failure, not graceful degradation.
    """
    from watch_skill.live.source import CaptureError, window_source
    from watch_skill.live.types import LiveSourceKind, LiveSourceSpec

    spec = LiveSourceSpec(kind=LiveSourceKind.WINDOW, target="window:GoneAlready")
    with pytest.raises(CaptureError):
        window_source(spec, Path("."))


@requires_display
def test_the_ffmpeg_command_targets_one_window(tmp_path: Path) -> None:
    from watch_skill.live.source import window_source
    from watch_skill.live.types import LiveSourceKind, LiveSourceSpec

    with FixtureWindow():
        spec = LiveSourceSpec(kind=LiveSourceKind.WINDOW,
                              target=f"window:{FIXTURE_TITLE}", fps=4.0)
        source = window_source(spec, tmp_path)
        args = " ".join(source._args)
        assert f"title={FIXTURE_TITLE}" in args
        assert "desktop" not in args
        assert "gdigrab" in args


# --- the machine-tested live gate ---------------------------------------------


@requires_display
def test_live_window_capture_emits_evidence_while_the_window_is_open(
    tmp_path: Path, isolated_settings: Path, record_property
) -> None:
    """The receipt: real pixels from a real window, through the real pipeline."""
    from watch_skill.live import session as live_session
    from watch_skill.live.types import LiveEventType, LiveState

    # The window flips READY -> ERROR 502 three seconds in, on its own.
    with FixtureWindow(flip_after=3.0):
        started = time.monotonic()
        session = live_session.start_live(
            f"window:{FIXTURE_TITLE}", kind="window", fps=4.0,
            audio=False, buffer_seconds=60.0,
        )
        try:
            def change_seen():
                batch = live_session.observe(session.session_id, limit=200)
                hits = [e for e in batch["events"]
                        if e["type"] in (LiveEventType.SCENE_CHANGE.value,
                                         LiveEventType.VISIBLE_TEXT_CHANGE.value)]
                return hits or None

            deadline = time.monotonic() + 40
            events = None
            while time.monotonic() < deadline:
                events = change_seen()
                if events and len(events) >= 2:
                    break
                time.sleep(0.2)

            runner = live_session.running_session(session.session_id)
            still_capturing = bool(runner and runner._source
                                   and runner._source.running)
            status = live_session.status(session.session_id)

            record_property("windows_capture_receipt", json.dumps({
                "os": f"{platform.system()} {platform.release()}",
                "backend": "ffmpeg gdigrab",
                "source_kind": "window",
                "window_title": FIXTURE_TITLE,
                "tested_at": time.time(),
                "frames_captured": status["stats"]["frames_captured"],
                "events": len(events or []),
                "seconds_to_first_event": round(time.monotonic() - started, 2),
            }))

            assert events, (
                "no visual event from the window; captured "
                f"{status['stats']['frames_captured']} frames"
            )
            assert status["stats"]["frames_captured"] > 0, "no frames captured"
            assert still_capturing, (
                "events only arrived after capture stopped — not live"
            )
            assert status["state"] == LiveState.RUNNING.value
        finally:
            live_session.stop_live(session.session_id)


@requires_display
def test_stopping_terminates_the_capture_process(tmp_path: Path) -> None:
    """A live capture that outlives its session is a leaked recorder."""
    from watch_skill.live import session as live_session

    with FixtureWindow():
        session = live_session.start_live(
            f"window:{FIXTURE_TITLE}", kind="window", fps=4.0, audio=False,
        )
        runner = live_session.running_session(session.session_id)
        assert runner is not None
        time.sleep(2.0)
        assert runner._source.running, "capture never started"
        live_session.stop_live(session.session_id)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and runner._source.running:
            time.sleep(0.2)
        assert not runner._source.running, "the ffmpeg child outlived the session"


@requires_display
def test_the_window_disappearing_ends_the_session_honestly(
    tmp_path: Path,
) -> None:
    """Closing the window must not leave a session claiming to be running."""
    from watch_skill.live import session as live_session
    from watch_skill.live.types import LiveState

    window = FixtureWindow(seconds=60.0)
    window.__enter__()
    session = live_session.start_live(
        f"window:{FIXTURE_TITLE}", kind="window", fps=4.0, audio=False,
    )
    try:
        time.sleep(2.0)
        window.close()
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            state = live_session.get_session(session.session_id).state
            if state in (LiveState.STOPPED, LiveState.FAILED, LiveState.FINALIZED):
                break
            time.sleep(0.5)
        state = live_session.get_session(session.session_id).state
        assert state in (LiveState.STOPPED, LiveState.FAILED, LiveState.FINALIZED), (
            f"session still reports {state.value} after the window closed"
        )
    finally:
        live_session.stop_live(session.session_id)


@requires_display
def test_evidence_from_a_window_survives_into_another_process(
    tmp_path: Path, isolated_settings: Path
) -> None:
    from watch_skill.live import session as live_session
    from watch_skill.live.finalize import finalize_session
    from watch_skill.live.types import LiveEventType

    with FixtureWindow(flip_after=2.5):
        session = live_session.start_live(
            f"window:{FIXTURE_TITLE}", kind="window", fps=4.0, audio=False,
        )
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            events = live_session.observe(session.session_id, limit=100)["events"]
            if any(e["type"] == LiveEventType.SCENE_CHANGE.value for e in events):
                break
            time.sleep(0.2)
        live_session.stop_live(session.session_id)
        video_id = finalize_session(session.session_id)

    from watch_skill.models import get_registry

    get_registry().release_all()

    probe = tmp_path / "probe.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.index.store import get_video
        row = get_video({video_id!r})
        print(json.dumps({{"found": row is not None}}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-1500:]
    assert json.loads(result.stdout.strip().splitlines()[-1])["found"]
