"""Live media sources: producing frames as they happen, not after they end.

The distinction this module exists to preserve: a source that hands over
frames only once the whole stream has been read is not live, however it is
labelled. ``FileReplaySource`` runs ffmpeg with ``-re`` so a local file is
paced at real time and frames appear while the file is still playing — which
is why the end-to-end tests can assert an event *before* EOF without needing
a camera.
"""
from __future__ import annotations

import platform
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from watch_skill.errors import WatchSkillError
from watch_skill.live.types import LiveSourceKind, LiveSourceSpec


class CaptureError(WatchSkillError):
    """A live source could not be opened or kept open."""

    default_code = "live.capture_failed"


@dataclass
class CapturedFrame:
    """One frame, with the two clocks that matter kept separate."""

    path: Path
    media_ts: float
    wall_ts: float
    index: int


class LiveSource(Protocol):
    """Anything that can produce frames in real time."""

    def frames(self) -> Iterator[CapturedFrame]:
        ...

    def stop(self) -> None:
        ...

    @property
    def running(self) -> bool:
        ...


class FfmpegFrameSource:
    """Frames written by an ffmpeg process, read as they land.

    Numbered files rather than a raw pipe: the pipe would need a demuxer to
    find frame boundaries, while ffmpeg's image sequence gives an unambiguous
    "this file is complete" signal on every platform, including Windows where
    partial-read semantics differ.

    Completeness is decided by the *next* file appearing, not by size — a JPEG
    being written has a plausible size for most of its life, and reading one
    early yields a truncated image that OCR silently misreads.
    """

    def __init__(
        self,
        args: list[str],
        out_dir: Path,
        fps: float,
        *,
        start_media_ts: float = 0.0,
        label: str = "ffmpeg",
    ) -> None:
        self.out_dir = out_dir
        self.fps = fps
        self.label = label
        self.start_media_ts = start_media_ts
        self._args = args
        self._process: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._stderr_tail: list[str] = []

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def start(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._process = subprocess.Popen(
            self._args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        def drain() -> None:
            assert self._process is not None and self._process.stderr is not None
            for line in self._process.stderr:
                self._stderr_tail.append(line.rstrip())
                del self._stderr_tail[:-40]

        threading.Thread(target=drain, name=f"ws-{self.label}-stderr",
                         daemon=True).start()

    def frames(self) -> Iterator[CapturedFrame]:
        if self._process is None:
            self.start()
        seen: set[Path] = set()
        index = 0
        idle_since = time.monotonic()
        while not self._stop.is_set():
            candidates = sorted(self.out_dir.glob("f_*.jpg"))
            # The newest file may still be being written; the one before it
            # cannot be, because ffmpeg has moved on.
            ready = candidates[:-1] if self.running else candidates
            fresh = [p for p in ready if p not in seen]
            if fresh:
                idle_since = time.monotonic()
            for path in fresh:
                seen.add(path)
                index += 1
                yield CapturedFrame(
                    path=path,
                    media_ts=self.start_media_ts + (index - 1) / self.fps,
                    wall_ts=time.time(),
                    index=index,
                )
            if not self.running and not fresh:
                return
            if time.monotonic() - idle_since > 30.0:
                raise CaptureError(
                    f"{self.label} produced no frames for 30s",
                    code="live.capture_stalled",
                    fix="check the source is still producing video; "
                    "`watch-skill capture-capabilities` shows what this "
                    "machine can actually record",
                    details={"stderr": self._stderr_tail[-8:]},
                )
            time.sleep(min(0.05, 1.0 / max(self.fps, 1.0) / 4))

    def stop(self) -> None:
        self._stop.set()
        process = self._process
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - stubborn ffmpeg
            process.kill()


def _ffmpeg() -> str:
    from watch_skill.health.binaries import require_binary

    return str(require_binary("ffmpeg"))


def file_replay_source(spec: LiveSourceSpec, out_dir: Path) -> FfmpegFrameSource:
    """A local file, paced at real time.

    ``-re`` is the whole point: without it ffmpeg decodes as fast as it can
    and every frame exists before the first one is looked at, which would make
    'detected before end of stream' meaningless.
    """
    path = Path(spec.target).expanduser()
    if not path.is_file():
        raise CaptureError(
            f"file not found: {path}",
            code="live.source_not_found",
            fix="check the path; quote paths containing spaces",
            details={"target": spec.target},
        )
    return FfmpegFrameSource(
        [_ffmpeg(), "-hide_banner", "-loglevel", "warning", "-re", "-i", str(path),
         "-vf", f"fps={spec.fps}", "-q:v", "3", str(out_dir / "f_%06d.jpg")],
        out_dir, spec.fps, label="file-replay",
    )


def stream_source(spec: LiveSourceSpec, out_dir: Path) -> FfmpegFrameSource:
    """RTSP / RTMP / HLS / DASH — anything ffmpeg can open directly.

    Already real time by nature, so no ``-re``; adding it would make a live
    stream drift further behind with every second.
    """
    return FfmpegFrameSource(
        [_ffmpeg(), "-hide_banner", "-loglevel", "warning",
         "-rtsp_transport", "tcp", "-i", spec.target,
         "-vf", f"fps={spec.fps}", "-q:v", "3", str(out_dir / "f_%06d.jpg")],
        out_dir, spec.fps, label="stream",
    )



def window_source(spec: LiveSourceSpec, out_dir: Path) -> FfmpegFrameSource:
    """A specific window, captured live by gdigrab.

    The title is matched exactly and passed as ``title=<name>``. There is
    deliberately **no fallback to the whole desktop**: a request to watch one
    window that quietly becomes a recording of everything on screen is a
    privacy failure, not a graceful degradation. If the window is not there,
    this raises.

    Not real time in the ``-re`` sense — a window produces frames as fast as
    it is asked to — so the frame rate is the cap and the source is live by
    nature.
    """
    if platform.system() != "Windows":
        raise CaptureError(
            "live window capture is implemented for Windows (gdigrab) only",
            code="live.source_unsupported",
            fix="capture the browser instead, or run this on Windows; "
            "`watch-skill capture-capabilities` reports what works here",
            details={"platform": platform.system()},
        )
    title = spec.target.split(":", 1)[1] if spec.target.startswith("window:")         else spec.target
    if not title.strip():
        raise CaptureError(
            "no window title was given",
            code="live.source_not_found",
            fix='pass `window:<exact title>`',
        )
    if not window_exists(title):
        raise CaptureError(
            f"no window titled {title!r} is open",
            code="live.source_not_found",
            fix="check the exact title (it is matched exactly, not by "
            "substring); capture never falls back to the whole desktop",
            details={"title": title},
        )
    fps = min(spec.fps, 15.0)
    return FfmpegFrameSource(
        [_ffmpeg(), "-hide_banner", "-loglevel", "warning",
         "-f", "gdigrab", "-framerate", f"{fps:g}",
         "-i", f"title={title}",
         "-vf", f"fps={fps:g}", "-q:v", "3", str(out_dir / "f_%06d.jpg")],
        out_dir, fps, label="window",
    )


def window_exists(title: str) -> bool:
    """Whether a window with this exact title is currently open.

    Checked before a session row is created, so a typo fails immediately
    rather than producing a session that silently never emits anything.
    """
    if platform.system() != "Windows":
        return False
    import ctypes
    from ctypes import wintypes

    found = ctypes.c_bool(False)
    target = title.strip()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _lparam):  # noqa: ANN001
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        if length:
            buffer = ctypes.create_unicode_buffer(length + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buffer, length + 1)
            if buffer.value == target:
                found.value = True
                return False
        return True

    ctypes.windll.user32.EnumWindows(visit, 0)
    return bool(found.value)


def open_source(spec: LiveSourceSpec, out_dir: Path) -> FfmpegFrameSource:
    """Build the source for a spec, or say plainly that it is not supported.

    Unsupported kinds fail here, before a session exists, rather than
    producing a session that never emits anything — an empty live view is
    indistinguishable from a quiet one, and that ambiguity is worse than an
    error.
    """
    from watch_skill.live.capabilities import capability_for

    if spec.kind is LiveSourceKind.FILE_REPLAY:
        return file_replay_source(spec, out_dir)
    if spec.kind is LiveSourceKind.WINDOW:
        capability = capability_for("window")
        if capability.status not in ("available", "degraded"):
            raise CaptureError(
                f"window capture is {capability.status} on this machine",
                code="live.capture_unavailable",
                fix=capability.repair or "run `watch-skill capture-capabilities`",
                details=capability.model_dump(),
            )
        return window_source(spec, out_dir)
    if spec.kind is LiveSourceKind.STREAM:
        capability = capability_for("stream")
        if capability.status != "available":
            raise CaptureError(
                f"stream capture is {capability.status} on this machine",
                code="live.capture_unavailable",
                fix=capability.repair or "run `watch-skill capture-capabilities`",
                details=capability.model_dump(),
            )
        return stream_source(spec, out_dir)

    capability = capability_for(spec.kind.value)
    raise CaptureError(
        f"live capture from {spec.kind.value!r} is not implemented in this build",
        code="live.source_unsupported",
        fix="`watch-skill capture-capabilities` lists what this machine can "
        "record right now; file_replay and stream are the implemented live "
        "sources",
        details={"kind": spec.kind.value, "capability": capability.model_dump()},
    )
