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

DEFAULT_VIEWPORT = {"width": 1280, "height": 720}
MOBILE_VIEWPORT = {"width": 390, "height": 844}
_BROWSER_CHANNELS = ("msedge", "chrome", None)  # None = bundled chromium


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
            fix='install the loop extra: `uv sync --extra loop`',
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    size = viewport or DEFAULT_VIEWPORT
    with sync_playwright() as p:
        browser = _launch_browser(p)
        context = browser.new_context(
            viewport=size, record_video_dir=str(out_dir), record_video_size=size
        )
        page = context.new_page()
        try:
            page.goto(url, wait_until="load")
            if script:
                for step in script:
                    _run_script_step(page, step)
            else:
                page.wait_for_timeout(int(duration_seconds * 500))
                page.mouse.wheel(0, 800)
                page.wait_for_timeout(int(duration_seconds * 500))
        finally:
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
    return CaptureResult(
        video_path=dest, kind="url", target=url,
        meta={"viewport": size, "scripted": bool(script)},
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
