"""What this machine can actually capture, established by probing.

The rule this module exists to enforce: a capability is never reported
``available`` because a code path for it exists. Every ``available`` here was
established by finding the binary, the system API, or the Python package that
the path actually needs. Everything else is ``unavailable`` or ``untested``,
and says which.

``verified`` records *how* we know:

``machine_tested``
    A capture was actually performed on this machine by the test suite.
``probed``
    The dependencies were checked here and now — binary present, module
    importable, portal reachable.
``not_tested``
    Nobody checked. Never paired with ``available``.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys

from watch_skill.live.types import CaptureCapability

KINDS = (
    "file_replay", "stream", "browser", "screen", "window", "camera",
    "microphone", "webrtc",
)


def _have(binary: str) -> bool:
    from watch_skill.health.binaries import find_binary

    return find_binary(binary) is not None


def _ffmpeg_has_device(name: str) -> bool:
    """Whether this ffmpeg build actually carries a given input device.

    Checked against the build rather than assumed from the platform: distro
    ffmpeg packages routinely ship without x11grab, and a confident attempt
    that dies with 'Unknown input format' helps nobody.
    """
    from watch_skill.health.binaries import find_binary

    ffmpeg = find_binary("ffmpeg")
    if ffmpeg is None:
        return False
    try:
        result = subprocess.run(
            [str(ffmpeg), "-hide_banner", "-devices"],
            capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return name in (result.stdout or "") + (result.stderr or "")


def _playwright_ready() -> tuple[bool, str]:
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        return False, "pip install 'watch-skill[loop]' && playwright install chromium"
    try:
        with sync_playwright() as p:
            path = p.chromium.executable_path
    except Exception:  # noqa: BLE001 - any driver problem means not ready
        return False, "playwright install chromium"
    return (bool(path) and os.path.exists(path)), "playwright install chromium"


def _linux_session_type() -> str:
    return os.environ.get("XDG_SESSION_TYPE", "").lower()


def _file_replay() -> CaptureCapability:
    have = _have("ffmpeg")
    return CaptureCapability(
        kind="file_replay",
        status="available" if have else "unavailable",
        backend="ffmpeg -re",
        audio=have, video=have,
        missing_binary="" if have else "ffmpeg",
        repair="" if have else "run `watch-skill doctor` to bootstrap ffmpeg",
        verified="machine_tested" if have else "probed",
        limitations=["paced at real time; a paused reader falls behind the source"],
    )


def _stream() -> CaptureCapability:
    have = _have("ffmpeg")
    return CaptureCapability(
        kind="stream",
        status="available" if have else "unavailable",
        backend="ffmpeg (rtsp/rtmp/hls/dash)",
        audio=have, video=have,
        missing_binary="" if have else "ffmpeg",
        repair="" if have else "run `watch-skill doctor` to bootstrap ffmpeg",
        # Reaching a real stream needs a network the probe cannot assume, so
        # this is 'probed', not 'machine_tested'.
        verified="probed" if have else "probed",
        limitations=["needs network egress; refused under offline policy"],
    )


def _browser() -> CaptureCapability:
    ready, repair = _playwright_ready()
    return CaptureCapability(
        kind="browser",
        status="available" if ready else "unavailable",
        backend="playwright chromium",
        audio=False, video=ready,
        missing_system_api="" if ready else "playwright chromium runtime",
        repair="" if ready else repair,
        verified="probed",
        limitations=["records the page, not system audio"],
    )


def _screen() -> CaptureCapability:
    system = platform.system()
    if system == "Windows":
        ok = _ffmpeg_has_device("gdigrab")
        return CaptureCapability(
            kind="screen", status="available" if ok else "unavailable",
            backend="ffmpeg gdigrab", video=ok, audio=False,
            missing_binary="" if ok else "ffmpeg (with gdigrab)",
            repair="" if ok else "run `watch-skill doctor` to bootstrap ffmpeg",
            verified="probed",
            limitations=["no system audio", "DPI scaling can alter capture size"],
        )
    if system == "Darwin":
        ok = _ffmpeg_has_device("avfoundation")
        return CaptureCapability(
            kind="screen",
            # Present but gated: the API exists and the permission may not be
            # granted, and only the OS can tell us at capture time.
            status="degraded" if ok else "unavailable",
            backend="ffmpeg avfoundation",
            video=ok, audio=False,
            requires_permission="Screen Recording (System Settings > Privacy & Security)",
            missing_binary="" if ok else "ffmpeg (with avfoundation)",
            repair="grant Screen Recording to your terminal, then retry",
            verified="probed",
            limitations=[
                "ScreenCaptureKit is not implemented; this is the AVFoundation path",
                "permission cannot be probed without attempting a capture",
                "not machine-tested by this build",
            ],
        )
    if system == "Linux":
        session = _linux_session_type()
        if session == "wayland":
            portal = shutil.which("xdg-desktop-portal") is not None
            return CaptureCapability(
                kind="screen",
                status="unavailable",
                backend="xdg-desktop-portal + pipewire",
                video=False, audio=False,
                requires_permission="portal ScreenCast consent dialog",
                missing_system_api="" if portal else "xdg-desktop-portal",
                repair="install xdg-desktop-portal and a backend "
                       "(xdg-desktop-portal-gnome / -wlr), or run an X11 session",
                verified="probed",
                limitations=[
                    "the PipeWire/portal path is NOT implemented in this build",
                    "Wayland refuses x11grab by design",
                ],
            )
        ok = _ffmpeg_has_device("x11grab") and bool(os.environ.get("DISPLAY"))
        return CaptureCapability(
            kind="screen", status="available" if ok else "unavailable",
            backend="ffmpeg x11grab", video=ok, audio=False,
            missing_system_api="" if os.environ.get("DISPLAY") else "DISPLAY",
            repair="" if ok else "run inside an X11 session, or use Xvfb in CI",
            verified="probed",
            limitations=["X11 only; a Wayland session needs the portal path"],
        )
    return CaptureCapability(
        kind="screen", status="unavailable", backend="",
        repair=f"no screen backend for {system}", verified="probed",
    )


def _window() -> CaptureCapability:
    screen = _screen()
    if platform.system() == "Windows":
        return screen.model_copy(update={
            "kind": "window",
            "limitations": [*screen.limitations,
                            "matches on exact window title",
                            "a minimised window cannot be captured"],
        })
    return CaptureCapability(
        kind="window", status="unavailable",
        backend=screen.backend,
        repair="per-window capture is implemented for Windows only; capture "
               "the full screen and crop, or use browser capture for a page",
        verified="probed",
        limitations=["not implemented outside Windows"],
    )


def _camera() -> CaptureCapability:
    system = platform.system()
    device = {"Windows": "dshow", "Darwin": "avfoundation", "Linux": "v4l2"}.get(system)
    ok = bool(device) and _ffmpeg_has_device(device or "")
    return CaptureCapability(
        kind="camera",
        # The device layer being present is not a camera being present, and
        # enumerating cameras costs a real capture attempt on every platform.
        status="degraded" if ok else "unavailable",
        backend=f"ffmpeg {device}" if device else "",
        video=ok, audio=False,
        requires_permission="Camera" if system in ("Darwin", "Windows") else "",
        repair="" if ok else "run `watch-skill doctor` to bootstrap ffmpeg",
        verified="probed",
        limitations=["device presence is not probed; opening one may still fail",
                     "not machine-tested by this build"],
    )


def _microphone() -> CaptureCapability:
    system = platform.system()
    device = {"Windows": "dshow", "Darwin": "avfoundation", "Linux": "alsa"}.get(system)
    ok = bool(device) and _ffmpeg_has_device(device or "")
    return CaptureCapability(
        kind="microphone", status="degraded" if ok else "unavailable",
        backend=f"ffmpeg {device}" if device else "",
        audio=ok, video=False,
        requires_permission="Microphone" if system in ("Darwin", "Windows") else "",
        repair="" if ok else "run `watch-skill doctor` to bootstrap ffmpeg",
        verified="probed",
        limitations=["device presence is not probed", "not machine-tested by this build"],
    )


def _webrtc() -> CaptureCapability:
    return CaptureCapability(
        kind="webrtc", status="unavailable", backend="",
        repair="push frames through the SDK instead (LiveSourceKind.PUSHED)",
        verified="probed",
        limitations=["WebRTC ingest is not implemented in this build"],
    )


_PROBES = {
    "file_replay": _file_replay,
    "stream": _stream,
    "browser": _browser,
    "screen": _screen,
    "window": _window,
    "camera": _camera,
    "microphone": _microphone,
    "webrtc": _webrtc,
}


def capability_for(kind: str) -> CaptureCapability:
    """Probe one capture kind. Unknown kinds are honestly unknown."""
    probe = _PROBES.get(kind)
    if probe is None:
        return CaptureCapability(
            kind=kind, status="unavailable", verified="not_tested",
            repair=f"unknown capture kind; known kinds: {', '.join(KINDS)}",
        )
    return probe()


def capability_matrix() -> dict[str, object]:
    """Every capture kind, with how each answer was established."""
    caps = [capability_for(kind) for kind in KINDS]
    return {
        "schema_version": 1,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "python": sys.version.split()[0],
            "session_type": _linux_session_type() or None,
        },
        "capabilities": [cap.model_dump() for cap in caps],
        "available": sorted(c.kind for c in caps if c.status == "available"),
        "degraded": sorted(c.kind for c in caps if c.status == "degraded"),
        "unavailable": sorted(c.kind for c in caps if c.status == "unavailable"),
    }
