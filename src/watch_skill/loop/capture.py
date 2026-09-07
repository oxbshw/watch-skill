"""Capture layer: record a URL session (Playwright), the screen, or a window.

Windows-native: screen/window capture uses ffmpeg gdigrab (no extra deps).
URL capture prefers the system Edge/Chrome (Playwright channels) so a clean
machine does not need the ~350 MB bundled Chromium download.
"""
from __future__ import annotations

import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import LoopError
from watch_skill.health.binaries import require_binary
from watch_skill.perceive.cues import (
    Cue,
    clear_sidecar,
    measure_offset,
    to_media_timeline,
    write_sidecar,
)

DEFAULT_VIEWPORT = {"width": 1280, "height": 720}
MOBILE_VIEWPORT = {"width": 390, "height": 844}
_BROWSER_CHANNELS = ("msedge", "chrome", None)  # None = bundled chromium

#: How a step's effect is observed before its moment is written down.
#:
#: Bounded on purpose, in both directions. A page with a clock or a spinner on
#: it never stops changing, and a click that does nothing never starts -- so
#: each phase has its own ceiling and a step costs at most two seconds of
#: watching whatever the page does.
_SETTLE_POLL_MS = 100
_SETTLE_CHANGE_POLLS = 10
_SETTLE_STABLE_POLLS = 2


@dataclass
class CaptureResult:
    """One recording produced by the capture layer."""

    video_path: Path
    kind: str  # url | screen | window | file
    target: str
    meta: dict[str, Any] = field(default_factory=dict)


def _run_script_step(page: Any, step: dict[str, Any]) -> None:
    """Execute one interaction-script step on a Playwright page.

    Supported: {"action": "goto"|"click"|"fill"|"scroll"|"wait"|"press", ...}.
    """
    action = step.get("action")
    if action == "goto":
        page.goto(step["url"], wait_until="load")
    elif action == "click":
        page.click(step["selector"], timeout=step.get("timeout_ms", 10_000))
    elif action == "fill":
        page.fill(step["selector"], step["value"])
    elif action == "press":
        page.keyboard.press(step["key"])
    elif action == "scroll":
        page.mouse.wheel(0, step.get("dy", 600))
    elif action == "wait":
        page.wait_for_timeout(int(step.get("seconds", 1) * 1000))
    else:
        raise LoopError(
            f"unknown script action: {action!r}",
            code="loop.bad_script",
            fix="use actions: goto, click, fill, press, scroll, wait",
        )


def _rendered_text(page: Any) -> str | None:
    """What the page currently says, or None if it is mid-navigation."""
    try:
        return str(page.evaluate(
            "() => document.body ? document.body.innerText : ''"))
    except Exception:  # a navigation swapped the document out from under us
        return None


def _observe(page: Any, before: str | None, origin: float) -> tuple[float, float]:
    """Watch until the page has changed and then stopped changing again.

    A moment recorded the instant ``page.fill`` returns names when the *input*
    changed, not when the page finished changing because of it. A total that a
    listener recomputes on a later tick is still the old total in that frame,
    so the cue would pin the state before the interaction rather than after it.

    Waiting for stability alone is not enough either, and the difference is not
    academic: a page that repaints 350 ms after the edit is perfectly stable
    for the 200 ms in between, so a settle that only asks "has it stopped
    moving" returns before anything happened. So this waits for the change
    first, and for it to stop second.

    Returns the window, in seconds from ``origin``, over which the new state
    was actually observed on the page -- first seen, and last seen unchanged.
    Pinning inside an observed window rather than at its edge is what absorbs
    the residual error in mapping onto the recording's own timeline.
    """
    appeared: float | None = None
    for _ in range(_SETTLE_CHANGE_POLLS):
        current = _rendered_text(page)
        if current is None:
            break
        if before is None or current != before:
            appeared = time.monotonic() - origin
            before = current
            break
        page.wait_for_timeout(_SETTLE_POLL_MS)
    if appeared is None:
        # Nothing this step did was visible -- a scroll on a short page, a
        # click on a dead control. There is no transition to sit inside.
        now = time.monotonic() - origin
        return now, now

    previous = before
    stable = 0
    for _ in range(_SETTLE_CHANGE_POLLS):
        page.wait_for_timeout(_SETTLE_POLL_MS)
        current = _rendered_text(page)
        now = time.monotonic() - origin
        if current is None:
            return appeared, now
        if current == previous:
            stable += 1
            if stable >= _SETTLE_STABLE_POLLS:
                return appeared, now
        else:
            appeared = now  # still moving; the state that lasts is a later one
            stable = 0
            previous = current
    return appeared, time.monotonic() - origin


def _step_label(step: dict[str, Any]) -> str:
    """What a cue is a cue for, in the words of the script that caused it."""
    action = str(step.get("action", "?"))
    subject = step.get("selector") or step.get("key") or step.get("url")
    return f"{action} {subject}" if subject else action


def _launch_browser(playwright: Any):
    last_error: Exception | None = None
    for channel in _BROWSER_CHANNELS:
        try:
            kwargs = {"headless": True}
            if channel:
                kwargs["channel"] = channel
            return playwright.chromium.launch(**kwargs)
        except Exception as exc:  # playwright raises its own Error type
            last_error = exc
    raise LoopError(
        f"no usable browser: {last_error}",
        code="loop.no_browser",
        fix="run `playwright install chromium` or install Edge/Chrome",
    )


def capture_url(
    url: str,
    out_dir: Path,
    script: list[dict[str, Any]] | None = None,
    duration_seconds: float = 8.0,
    viewport: dict[str, int] | None = None,
) -> CaptureResult:
    """Record a browsing session of ``url`` to a video file.

    ``script`` is an optional list of interaction steps executed in order;
    without one, the page is loaded, settled, and scrolled once.
    """
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError as exc:
        raise LoopError(
            "playwright is not installed",
            code="loop.missing_dependency",
            fix='install the loop extra: `pip install "watch-skill[loop]"` '
            '(from a checkout: `uv sync --extra loop`)',
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    size = viewport or DEFAULT_VIEWPORT
    marks: list[tuple[float, str]] = []
    first_change: float | None = None
    with sync_playwright() as p:
        browser = _launch_browser(p)
        context = browser.new_context(
            viewport=size, record_video_dir=str(out_dir), record_video_size=size
        )
        page = context.new_page()
        # The recording starts with the page, not with the first navigation.
        # `page.goto` takes as long as the site takes -- seconds against a cold
        # server -- and a clock started after it names every later moment that
        # much too early, which points frame selection at the blank page the
        # app had not rendered into yet.
        origin = time.monotonic()
        try:
            page.goto(url, wait_until="load")
            if script:
                for step in script:
                    # An interaction is the moment the page became something
                    # new, and the frames either side of it are perceptually
                    # near-identical -- a checkout page where three numbers
                    # change hashes inside the near-duplicate threshold. The
                    # one that shows the result is the one worth keeping, so
                    # the capture writes down when that state was on screen.
                    watching = step.get("action") != "wait"
                    began = time.monotonic() - origin
                    before = _rendered_text(page) if watching else None
                    _run_script_step(page, step)
                    if watching:
                        appeared, settled = _observe(page, before, origin)
                        # The first time this session saw the page change is
                        # the one event both clocks witnessed; it is what the
                        # recording is aligned against afterwards.
                        if first_change is None and settled > appeared:
                            first_change = appeared
                    else:
                        # A wait produces no new state. What it shows is
                        # whatever was already there, for the whole of its
                        # duration -- and its far edge is the instant the next
                        # step runs, which is the one moment in that window
                        # that may catch a half-applied interaction.
                        appeared, settled = began, time.monotonic() - origin
                    marks.append(((appeared + settled) / 2, _step_label(step)))
            else:
                page.wait_for_timeout(int(duration_seconds * 500))
                page.mouse.wheel(0, 800)
                page.wait_for_timeout(int(duration_seconds * 500))
        finally:
            wall_span = time.monotonic() - origin
            video = page.video
            context.close()  # flushes the recording
            raw_path = Path(video.path()) if video else None
            browser.close()
    if raw_path is None or not raw_path.is_file():
        raise LoopError(
            "Playwright produced no recording",
            code="loop.capture_failed",
            fix="re-run once; persistent: `playwright install chromium` to "
            "refresh the browser build",
        )
    dest = out_dir / "capture.webm"
    raw_path.replace(dest)
    # Whatever an earlier recording into this directory left behind describes
    # a file that no longer exists.
    clear_sidecar(dest)

    cue_seconds: list[float] = []
    if marks:
        from watch_skill.perceive import probe  # noqa: PLC0415 — heavy import

        media_duration = probe(dest).duration_seconds
        # Where this session's clock sits relative to the recording's, measured
        # against the recording rather than guessed from its length. The two
        # differ by a fraction of a second that the durations do not reveal:
        # a screencast starts a little after the page does, and then holds its
        # last frame past the end of the session, so a file with a leading gap
        # comes out *longer* than the session that produced it.
        offset = 0.0
        if first_change is not None:
            measured = measure_offset(
                dest,
                changed_at=first_change - (_SETTLE_POLL_MS / 2000),
                media_duration=media_duration,
            )
            if measured is not None:
                offset = measured
        cue_seconds = to_media_timeline(
            [moment for moment, _label in marks],
            offset=offset,
            media_duration=media_duration,
        )
        # A sidecar, because `watch-skill watch <file>` is a separate
        # invocation that is handed only a path. Without it the interaction
        # moments are lost between the two commands and frame selection has
        # nothing to pin.
        write_sidecar(
            dest,
            [Cue(seconds=t, label=label)
             for t, (_moment, label) in zip(cue_seconds, marks, strict=True)],
            timeline={
                "wall_span": wall_span,
                "media_duration": media_duration,
                "offset": offset,
            },
        )
    return CaptureResult(
        video_path=dest, kind="url", target=url,
        meta={"viewport": size, "scripted": bool(script), "cues": cue_seconds},
    )


def capture_screen(
    out_dir: Path,
    duration_seconds: float = 10.0,
    region: tuple[int, int, int, int] | None = None,
    window_title: str | None = None,
    framerate: int = 15,
) -> CaptureResult:
    """Record the desktop (or one window / region) via ffmpeg gdigrab."""
    if sys.platform != "win32":
        raise LoopError(
            "gdigrab screen capture is Windows-only in this build",
            code="loop.unsupported_platform",
            fix="use capture_url or capture_file on this platform",
        )
    ffmpeg = require_binary("ffmpeg")
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / "capture.mp4"
    grab_input = f"title={window_title}" if window_title else "desktop"
    cmd: list[str] = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "gdigrab", "-framerate", str(framerate),
    ]
    if region and not window_title:
        x, y, width, height = region
        cmd += ["-offset_x", str(x), "-offset_y", str(y), "-video_size", f"{width}x{height}"]
    cmd += [
        "-t", f"{duration_seconds:.3f}", "-i", grab_input,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(dest),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=duration_seconds + 120,
    )
    if result.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        raise LoopError(
            "screen capture failed",
            code="loop.capture_failed",
            fix="check the window title exists (exact match) and the session is not locked",
            details={"stderr": result.stderr[-800:], "input": grab_input},
        )
    clear_sidecar(dest)  # a scripted URL capture may have written here first
    return CaptureResult(
        video_path=dest, kind="window" if window_title else "screen",
        target=window_title or "desktop",
        meta={"duration": duration_seconds, "framerate": framerate},
    )


def capture_file(path: str | Path, out_dir: Path) -> CaptureResult:
    """Adopt an existing rendered/generated video as a capture."""
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise LoopError(
            f"file not found: {source}",
            code="loop.file_not_found",
            fix="check the path; quote paths containing spaces",
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"capture{source.suffix.lower()}"
    import shutil

    shutil.copy2(source, dest)
    clear_sidecar(dest)  # a scripted URL capture may have written here first
    return CaptureResult(video_path=dest, kind="file", target=str(source), meta={})


def capture(
    target: str,
    out_dir: Path,
    script: list[dict[str, Any]] | None = None,
    duration_seconds: float = 10.0,
    viewport: dict[str, int] | None = None,
) -> CaptureResult:
    """Dispatch on target: http(s) URL / `screen:` / `window:<title>` / file path."""
    lowered = target.strip().lower()
    if lowered.startswith(("http://", "https://")):
        return capture_url(target, out_dir, script=script,
                           duration_seconds=duration_seconds, viewport=viewport)
    if lowered.startswith("screen:"):
        return capture_screen(out_dir, duration_seconds=duration_seconds)
    if lowered.startswith("window:"):
        return capture_screen(
            out_dir, duration_seconds=duration_seconds, window_title=target.split(":", 1)[1]
        )
    if lowered.startswith("file://"):
        # local page rendered in the browser (the M3 demo path)
        return capture_url(target, out_dir, script=script,
                           duration_seconds=duration_seconds, viewport=viewport)
    return capture_file(target, out_dir)


def wait_briefly(seconds: float) -> None:
    """Tiny helper kept separate so tests can monkeypatch waits away."""
    time.sleep(seconds)
