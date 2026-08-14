"""The live session: capture, analyse, emit, retain, finalize.

Structure, in one paragraph: a capture thread pulls frames from the source as
fast as they arrive and hands each to two independent bounded stages. The
*perception* stage takes only the latest frame — it is allowed to skip, and
counts what it skipped. The *persistence* stage does not skip; it records
every frame into the rolling buffer so evidence exists for moments nobody has
decided are interesting yet. Detectors turn frames into events, events are
appended with an atomically allocated sequence, and consumers read by cursor.
"""
from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.live import buffer as buf
from watch_skill.live import db
from watch_skill.live.detect import (
    DetectorState,
    build_event,
    detect_scene_change,
    detect_text_change,
)
from watch_skill.live.pipeline import Overflow, Pipeline
from watch_skill.live.source import CapturedFrame, open_source
from watch_skill.live.types import (
    EvidenceReference,
    LiveEvent,
    LiveEventType,
    LiveProfile,
    LiveSession,
    LiveSourceKind,
    LiveSourceSpec,
    LiveState,
    LiveStats,
)


class LiveError(WatchSkillError):
    """A live session could not be started, found, or driven."""

    default_code = "live.failed"


_PROFILE_CAPACITY = {
    LiveProfile.LOCAL_LITE: 4,
    LiveProfile.LOCAL_REALTIME: 8,
    # Forensic keeps everything, so its perception stage blocks rather than
    # dropping — a slower session is the price of a complete one.
    LiveProfile.FORENSIC: 64,
}


class RunningSession:
    """One live session executing in this process."""

    def __init__(self, session: LiveSession, source: Any) -> None:
        self.session = session
        self.state = DetectorState()
        self.pipeline = Pipeline()
        self.stop_event = threading.Event()
        # Opened by the caller, before the session row exists — see start_live.
        self._source: Any = source
        self._threads: list[threading.Thread] = []
        self._last_sweep = 0.0
        self._start_wall = time.time()
        self._lock = threading.Lock()
        self.stats = session.stats

    # --- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        spec = self.session.spec
        capacity = _PROFILE_CAPACITY[spec.profile]
        overflow = (Overflow.BLOCK if spec.profile is LiveProfile.FORENSIC
                    else Overflow.DROP_OLDEST)
        # Three independent stages, because they have wildly different costs.
        # Perceptual hashing is sub-millisecond; the first OCR call loads
        # models and can take tens of seconds. Sharing one stage meant no
        # scene change was reported until OCR had finished warming up — the
        # live view was blind for exactly as long as its slowest detector took
        # to start. They are separated so a slow detector degrades only itself.
        fast_stage = self.pipeline.stage("fast_vision", capacity, overflow)
        ocr_stage = self.pipeline.stage("ocr", capacity, overflow)
        # Persistence never drops: a frame that is not written cannot become
        # evidence later, and 'later' is when most evidence is wanted.
        persist_stage = self.pipeline.stage("persist", 256, Overflow.BLOCK)

        self.pipeline.consume(fast_stage, self._analyze_fast, latest_only=True,
                              name="ws-live-fast")
        self.pipeline.consume(ocr_stage, self._analyze_ocr, latest_only=True,
                              name="ws-live-ocr")
        self.pipeline.consume(persist_stage, self._persist, name="ws-live-persist")

        capture = threading.Thread(
            target=self._capture_loop,
            args=([fast_stage, ocr_stage], persist_stage),
            name="ws-live-capture", daemon=True,
        )
        capture.start()
        self._threads.append(capture)

        # Warm the OCR model off the critical path. The first call loads
        # weights and can take tens of seconds; doing it here means the OCR
        # stage is merely behind for a while instead of the session appearing
        # to have no text detector at all.
        threading.Thread(target=self._warm_ocr, name="ws-live-warm-ocr",
                         daemon=True).start()

        db.update_session(self.session.session_id, state=LiveState.RUNNING)
        self.session.state = LiveState.RUNNING
        # The target is deliberately NOT in the summary. Event payloads are
        # public tool output, and a local path there hands whatever reads it a
        # piece of the filesystem layout for free.
        self._emit(LiveEventType.SESSION_STARTED, 0.0,
                   f"live session started ({spec.kind.value}, "
                   f"{spec.profile.value}, {spec.fps:g} fps)",
                   detector="session")

    def _capture_loop(self, analysis_stages: list[Any], persist_stage: Any) -> None:
        deadline = time.time() + self.session.spec.max_duration_seconds
        try:
            for frame in self._source.frames():
                if self.stop_event.is_set() or time.time() > deadline:
                    break
                with self._lock:
                    self.stats.frames_captured += 1
                    elapsed = max(1e-6, time.time() - self._start_wall)
                    self.stats.capture_fps = round(
                        self.stats.frames_captured / elapsed, 2
                    )
                persist_stage.put(frame)
                for stage in analysis_stages:
                    stage.put(frame)
                if self.stats.frames_captured >= self.session.budget.max_frames_analyzed:
                    break
        except Exception as exc:  # noqa: BLE001 - a dead source ends the session
            db.update_session(
                self.session.session_id, state=LiveState.FAILED,
                error={"error": getattr(exc, "code", "live.capture_failed"),
                       "message": str(exc),
                       "fix": getattr(exc, "fix", None)
                       or "run `watch-skill capture-capabilities`"},
                stopped_at=time.time(),
            )
            self.session.state = LiveState.FAILED
            return
        finally:
            self._flush_stats()
        if not self.stop_event.is_set():
            self.stop(reason="source ended")

    # --- stages ------------------------------------------------------------

    def _persist(self, frame: CapturedFrame) -> None:
        """Record every captured frame in the rolling buffer."""
        buf.record(self.session.session_id, "frame", frame.path, frame.media_ts)
        self._last_sweep = buf.sweep_if_needed(
            self.session.session_id, self.session.spec.buffer_seconds,
            frame.media_ts, self._last_sweep,
        )

    def _analyze_fast(self, frame: CapturedFrame) -> None:
        """Sub-millisecond perception: scene change by perceptual hash."""
        started = time.monotonic()
        detection = detect_scene_change(self.state, frame.path, frame.media_ts)
        with self._lock:
            self.stats.frames_analyzed += 1
            elapsed = max(1e-6, time.time() - self._start_wall)
            self.stats.analyzed_fps = round(self.stats.frames_analyzed / elapsed, 2)
            self.stats.frames_dropped = sum(self.pipeline.dropped().values())
            self.stats.queue_depths = self.pipeline.depths()
        if detection is not None:
            self._publish(detection, frame, started)

    def _analyze_ocr(self, frame: CapturedFrame) -> None:
        """Read on-screen text. Slow to start, so it lives on its own thread."""
        started = time.monotonic()
        text = self._ocr(frame.path)
        if text is None:
            return
        detection = detect_text_change(self.state, text, frame.media_ts)
        if detection is not None:
            self._publish(detection, frame, started)

    def _publish(self, detection: Any, frame: CapturedFrame, started: float) -> None:
        """Pin the media around a detection and append the event."""
        # Anything worth an event is worth keeping the media around it.
        buf.pin_window(self.session.session_id, frame.media_ts, before=3.0, after=3.0)
        segment = buf.record(self.session.session_id, "frame", frame.path,
                             frame.media_ts, pinned=True)
        self._append(build_event(
            self.session.session_id, detection, frame.media_ts, frame.wall_ts,
            evidence=[EvidenceReference(
                kind="frame", artifact_id=segment.artifact_id,
                media_ts=frame.media_ts,
            )],
        ))
        with self._lock:
            self.stats.last_event_latency_ms = round(
                (time.monotonic() - started) * 1000, 1
            )

    def _warm_ocr(self) -> None:
        if not get_settings().ocr_enabled:
            return
        try:
            from watch_skill.perceive.ocr import _get_engine  # noqa: PLC0415

            _get_engine()
        except Exception:  # noqa: BLE001 - warming is best effort
            return

    def _ocr(self, path: Path) -> str | None:
        if not get_settings().ocr_enabled:
            return None
        try:
            from watch_skill.perceive.ocr import ocr_frame  # noqa: PLC0415

            blocks = ocr_frame(path)
        except Exception:  # noqa: BLE001 - OCR is best effort in a live loop
            with self._lock:
                self.stats.provider_failures += 1
            return None
        return "\n".join(block.text for block in blocks)

    # --- events ------------------------------------------------------------

    def _append(self, event: LiveEvent) -> int:
        seq = db.append_event(event)
        with self._lock:
            self.stats.events_emitted += 1
            self.session.last_seq = max(self.session.last_seq, seq)
        return seq

    def _emit(self, kind: LiveEventType, media_ts: float, summary: str,
              detector: str = "") -> int:
        return self._append(LiveEvent(
            session_id=self.session.session_id, seq=0, media_ts=media_ts,
            wall_ts=time.time(), type=kind, summary=summary, detector=detector,
        ))

    def _flush_stats(self) -> None:
        with self._lock:
            self.stats.frames_dropped = sum(self.pipeline.dropped().values())
            self.stats.queue_depths = self.pipeline.depths()
        db.update_session(self.session.session_id, stats=self.stats)

    # --- stopping ----------------------------------------------------------

    def stop(self, reason: str = "stopped by request") -> LiveSession:
        if self.stop_event.is_set():
            return self.session
        self.stop_event.set()
        db.update_session(self.session.session_id, state=LiveState.STOPPING)
        if self._source is not None:
            self._source.stop()
        # Drain before tearing down: frames already captured deserve to be
        # persisted, and a stop that discards them loses evidence for the
        # moment the operator most likely stopped to look at.
        time.sleep(0.3)
        self.pipeline.stop(timeout=5.0)
        last_ts = max(
            (e.media_ts for e in db.read_events(self.session.session_id, limit=500)),
            default=0.0,
        )
        self._emit(LiveEventType.SESSION_STOPPED, last_ts, reason, detector="session")
        self._flush_stats()
        db.update_session(self.session.session_id, state=LiveState.STOPPED,
                          stopped_at=time.time(), stats=self.stats)
        self.session.state = LiveState.STOPPED
        return self.session


_running: dict[str, RunningSession] = {}
_registry_lock = threading.Lock()


def _register(session: RunningSession) -> None:
    with _registry_lock:
        _running[session.session.session_id] = session


def running_session(session_id: str) -> RunningSession | None:
    with _registry_lock:
        return _running.get(session_id)


# --- public API -------------------------------------------------------------


def start_live(
    target: str,
    kind: str = "file_replay",
    profile: str = "local-lite",
    fps: float = 2.0,
    buffer_seconds: float = 120.0,
    max_duration_seconds: float = 3600.0,
    audio: bool = True,
) -> LiveSession:
    """Begin watching something live.

    Fails before creating a session when the source cannot be captured on
    this machine, rather than producing a session that never emits anything —
    an empty live view is indistinguishable from a quiet one.
    """
    from watch_skill.policy import get_policy

    try:
        source_kind = LiveSourceKind(kind)
        live_profile = LiveProfile(profile)
    except ValueError as exc:
        raise LiveError(
            f"unknown live source kind or profile: {exc}",
            code="live.bad_spec",
            fix=f"kind: {', '.join(k.value for k in LiveSourceKind)}; "
            f"profile: {', '.join(p.value for p in LiveProfile)}",
        ) from exc

    spec = LiveSourceSpec(
        kind=source_kind, target=target, profile=live_profile, fps=fps,
        buffer_seconds=buffer_seconds, max_duration_seconds=max_duration_seconds,
        audio=audio,
    )
    session = LiveSession(
        session_id=f"live_{uuid.uuid4().hex[:12]}",
        spec=spec,
        policy_snapshot=get_policy().to_dict(),
    )

    # Open the source BEFORE the session row exists. A typo'd path or an
    # unsupported capture kind should leave nothing behind — a `failed`
    # session that never started is noise in `live list`, and it accumulates.
    media_dir = buf.session_dir(session.session_id) / "frames"
    media_dir.mkdir(parents=True, exist_ok=True)
    try:
        source = open_source(spec, media_dir)
    except WatchSkillError:
        buf.cleanup(session.session_id)
        raise

    db.insert_session(session)
    runner = RunningSession(session, source)
    try:
        runner.start()
    except WatchSkillError as exc:
        # Past this point the session did exist, so its failure is recorded.
        db.update_session(session.session_id, state=LiveState.FAILED,
                          error=exc.to_dict(), stopped_at=time.time())
        raise
    _register(runner)
    return session


def observe(
    session_id: str,
    cursor: str | None = None,
    limit: int = 50,
    timeout_seconds: float = 0.0,
    types: list[str] | None = None,
) -> dict[str, Any]:
    """Read events after a cursor. Repeating a cursor is idempotent.

    ``timeout_seconds`` long-polls: it waits for something to happen rather
    than returning an empty batch immediately, so a caller does not have to
    choose between a tight loop and missing an event by seconds.
    """
    from watch_skill.live.types import LiveCursor

    session = get_session(session_id)
    position = LiveCursor.decode(cursor or "", session_id)
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        events = db.read_events(session_id, after_seq=position.seq, limit=limit,
                                types=types)
        if events or time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    next_seq = events[-1].seq if events else position.seq
    return {
        "schema_version": 1,
        "session_id": session_id,
        "state": get_session(session_id).state.value,
        "events": [event.to_public() for event in events],
        "count": len(events),
        "cursor": position.encode(),
        "next_cursor": LiveCursor(session_id=session_id, seq=next_seq).encode(),
        "has_more": len(events) == limit,
        "stats": session.stats.model_dump(),
    }


def get_session(session_id: str) -> LiveSession:
    session = db.get_session(session_id)
    if session is None:
        raise LiveError(
            f"unknown live session: {session_id}",
            code="live.session_not_found",
            fix="`watch-skill live list` shows sessions on this machine",
            details={"session_id": session_id},
        )
    runner = running_session(session_id)
    if runner is not None:
        session.stats = runner.stats
    return session


def status(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    payload = session.to_public()
    payload["events_total"] = db.count_events(session_id)
    payload["buffer_bytes"] = buf.buffer_bytes(session_id)
    runner = running_session(session_id)
    payload["queue_depths"] = runner.pipeline.depths() if runner else {}
    payload["dropped"] = runner.pipeline.dropped() if runner else {}
    payload["in_this_process"] = runner is not None
    return payload


def stop_live(session_id: str, reason: str = "stopped by request") -> dict[str, Any]:
    """Stop a session. Idempotent, and honest about a session it does not own."""
    session = get_session(session_id)
    runner = running_session(session_id)
    if runner is not None:
        runner.stop(reason=reason)
    elif session.active:
        # Another process owns the capture. Mark it stopping; that process's
        # heartbeat lapse turns it into stopped, and orphan recovery cleans up.
        db.update_session(session_id, state=LiveState.STOPPED,
                          stopped_at=time.time())
    return status(session_id)


def list_live(active_only: bool = False) -> list[dict[str, Any]]:
    db.recover_orphaned_sessions()
    return [session.to_public() for session in db.list_sessions(active_only)]


def stop_all() -> None:
    """Stop everything this process owns. Used at shutdown and by tests."""
    with _registry_lock:
        runners = list(_running.values())
        _running.clear()
    for runner in runners:
        try:
            runner.stop(reason="process shutting down")
        except Exception:  # noqa: BLE001
            continue


def frame_for(session_id: str, artifact_id: str) -> Path | None:
    """Resolve a public artifact id to a real path, for surfaces only."""
    segment = buf.resolve(session_id, artifact_id)
    if segment is None or segment.expired or not segment.path.is_file():
        return None
    return segment.path


__all__ = [
    "LiveError",
    "LiveStats",
    "RunningSession",
    "frame_for",
    "get_session",
    "list_live",
    "observe",
    "running_session",
    "start_live",
    "status",
    "stop_all",
    "stop_live",
]
