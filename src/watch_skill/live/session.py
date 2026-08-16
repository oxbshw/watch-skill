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
from watch_skill.live.clock import SessionClock, correlate
from watch_skill.live.detect import (
    DetectorState,
    build_event,
    detect_scene_change,
    detect_text_change,
)
from watch_skill.live.pipeline import Overflow, Pipeline
from watch_skill.live.semantic import FrameCandidate as SemanticCandidate
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
    Provenance,
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
        self._audio: Any = None
        self._asr_backend: Any = None
        self._semantic: Any = None
        self._semantic_backend: Any = None
        # One origin for both streams. They come from independent ffmpeg
        # processes whose media clocks drift, so "what was on screen when
        # they said that" needs a shared reference rather than an assumption.
        self.clock = SessionClock(session_id=session.session_id)

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

        if spec.audio:
            self._start_audio()
        self._start_semantic()
        self._start_browser_events()

        # Warm slow models off the critical path, AFTER audio exists so the
        # warm step can see which ASR backend to load. The first OCR or ASR
        # call loads weights and can take tens of seconds; doing it here means
        # those stages are merely behind for a while instead of the session
        # appearing to have no such detector at all.
        threading.Thread(target=self._warm_models, name="ws-live-warm",
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
                discontinuity = self.clock.observe("video", frame.media_ts,
                                                   frame.wall_ts)
                if discontinuity is not None:
                    self._on_discontinuity("video", discontinuity, frame.media_ts)
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
        if self.stop_event.is_set():
            return
        # A source that ended on its own may have ended *badly*. Asking it
        # before declaring a clean stop is what keeps "the browser was killed"
        # from being recorded as "the recording finished" — the two look
        # identical from the capture loop's side, and only one of them means
        # the evidence is complete.
        failure = getattr(self._source, "failure", None)
        if failure is not None:
            self.stop(reason=failure.message, failed=True, error=failure.to_dict())
            return
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
        # Scene change is a primary selection signal and must not depend on
        # OCR: OCR takes tens of seconds to warm, and routing every semantic
        # offer through it meant no interpretation happened until it did.
        if self._semantic is not None:
            self._semantic.consider(SemanticCandidate(
                path=frame.path, media_ts=frame.media_ts,
                scene_changed=detection is not None,
                frame_seq=frame.index, captured_wall_ts=frame.wall_ts,
                capture_kind=self.session.spec.kind.value,
            ))

    def _analyze_ocr(self, frame: CapturedFrame) -> None:
        """Read on-screen text. Slow to start, so it lives on its own thread."""
        started = time.monotonic()
        text = self._ocr(frame.path)
        if text is None:
            return
        detection = detect_text_change(self.state, text, frame.media_ts)
        if detection is not None:
            self._publish(detection, frame, started)
        # Offer the frame for interpretation. The selector decides; this is
        # the only place a model can be reached from the capture path, and it
        # never blocks — a frame arriving while a call is in flight is
        # skipped, because by the time a backlog cleared the answer would
        # describe a screen that has moved on.
        if self._semantic is not None:
            self._semantic.consider(SemanticCandidate(
                path=frame.path, media_ts=frame.media_ts,
                scene_changed=False, text_changed=detection is not None,
                visible_text=text,
                frame_seq=frame.index, captured_wall_ts=frame.wall_ts,
                capture_kind=self.session.spec.kind.value,
            ))

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

    def _start_audio(self) -> None:
        """Bring up the audio half, or record why there is none.

        Failure here never fails the session: a video with no audio track, or
        a machine with no local ASR, is still perfectly watchable. What is not
        acceptable is silence with no explanation, so both paths leave a
        reason in `detectors.asr`.
        """
        from watch_skill.live.audio_pipeline import build_audio_runtime  # noqa: PLC0415

        spec = self.session.spec
        try:
            runtime = build_audio_runtime(
                self.session.session_id, spec.kind.value, spec.target,
                on_speech=self._on_speech, on_gap=self._on_audio_gap,
                backend=self._asr_backend,
            )
        except WatchSkillError as exc:
            self._emit(LiveEventType.PROVIDER_DEGRADED, 0.0,
                       f"live audio unavailable: {exc}", detector="audio")
            return
        if runtime is None:
            return
        self._audio = runtime
        runtime.start()

    def _on_speech(self, piece: Any) -> None:
        """Publish recognised speech as a citable event."""
        self.clock.observe("audio", piece.media_ts)
        self._append(LiveEvent(
            session_id=self.session.session_id, seq=0,
            media_ts=piece.media_ts, wall_ts=time.time(),
            type=LiveEventType.SPEECH,
            final=piece.final,
            confidence=piece.confidence,
            summary=piece.text,
            detector=piece.backend,
            evidence=[EvidenceReference(
                kind="transcript", artifact_id=f"utt_{piece.media_ts:.2f}",
                media_ts=piece.media_ts, end_media_ts=piece.end_media_ts,
            )],
            detail={"language": piece.language,
                    "end_media_ts": round(piece.end_media_ts, 3)},
        ))
        # Speech is worth keeping the picture for: "what was on screen when
        # they said that" is the question this makes answerable later.
        buf.pin_window(self.session.session_id, piece.media_ts, before=2.0, after=2.0)

    def _start_semantic(self) -> None:
        """Bring up semantic interpretation, if anything is configured.

        Off unless asked for. Interpreting frames costs money or GPU on every
        session, and a feature that quietly starts spending is one nobody
        consented to.
        """
        from watch_skill.live.semantic import (  # noqa: PLC0415
            SemanticRuntime,
            build_semantic_backend,
        )

        detail = self.session.spec.detail or {}
        backend = self._semantic_backend
        if backend is None and detail.get("semantic_vlm"):
            # The external real-model worker, when the operator asked for it
            # by name. Never discovered: loading it costs seconds of CPU and
            # over a gigabyte, and a session must not decide that on its own.
            from watch_skill.live.vlm_backend import build_vlm_backend  # noqa: PLC0415

            backend = build_vlm_backend(
                interpreter=detail.get("vlm_interpreter"),
                model=detail.get("vlm_model", ""),
                revision=detail.get("vlm_revision", ""),
            )
        if backend is None:
            backend = build_semantic_backend(
                enabled=bool(detail.get("semantic")),
                provider=detail.get("semantic_provider"),
                model=detail.get("semantic_model"),
            )
        if backend is None:
            return
        self._semantic = SemanticRuntime(
            backend=backend, on_observation=self._on_semantic,
            budget=int(detail.get("semantic_budget", 60)),
            # Freshness is decided when the answer lands, and by then the
            # source may have ended. Reading it live is what separates "too
            # late to act on" from "historical evidence".
            source_running=lambda: bool(
                getattr(self._source, "running", False)),
        )
        # Warm alongside startup, not at the first interesting frame. Loading
        # is seconds of CPU; paying it lazily means the first thing worth
        # interpreting is also the thing that waits for the loader.
        self._semantic.warm()

    def _on_semantic(self, observation: Any, reason: str) -> None:
        """Publish a model reading as an explicitly advisory event.

        `provenance: model_inference` and `advisory: true` travel with it, so
        nothing downstream can mistake a description of a picture for a
        measurement of one.
        """
        summary = observation.scene or observation.ui_state or "(no description)"
        if observation.degraded:
            summary = f"semantic reading unavailable: {observation.degraded_reason}"
        elif observation.freshness != "current_state":
            # The lateness goes in the sentence a human reads, not only in a
            # field they have to go looking for. A minute-old reading
            # presented as plain narration is the whole failure mode this
            # season exists to avoid.
            summary = (f"[{observation.freshness}, "
                       f"{observation.late_by_seconds:.0f}s late] {summary}")
        self._append(LiveEvent(
            session_id=self.session.session_id, seq=0,
            media_ts=observation.media_ts, wall_ts=time.time(),
            type=(LiveEventType.ANOMALY if observation.anomaly
                  else LiveEventType.UI_STATE_CHANGE),
            confidence=observation.confidence,
            provenance=Provenance.INFERENCE,
            summary=summary,
            detector=f"semantic:{observation.model or observation.provider}",
            final=not observation.degraded,
            detail={"semantic": observation.to_public(),
                    "selected_because": reason,
                    "freshness": observation.freshness,
                    "late_by_seconds": round(observation.late_by_seconds, 3),
                    "may_trigger_current_state_action":
                        observation.may_trigger_current_state_action},
        ))

    def _start_browser_events(self) -> None:
        """Drain the source's structured channel into the session event log.

        Its own thread, and a short poll, because the point of the structured
        channel is that it is *fast*: a console error is available the instant
        the page throws, and making it wait for the next screenshot would give
        away the one advantage it has over pixels.
        """
        if not hasattr(self._source, "drain_events"):
            return
        threading.Thread(target=self._browser_event_loop,
                         name="ws-live-browser-events", daemon=True).start()

    def _browser_event_loop(self) -> None:
        source = self._source
        while not self.stop_event.is_set():
            events = source.drain_events()
            for event in events:
                self._publish_safely(event)
            if not events:
                if not getattr(source, "running", False):
                    break
                time.sleep(0.05)
        # One last drain: the events explaining *why* a page stopped are
        # produced during shutdown, and losing them would make every crash
        # look like a clean exit.
        for event in source.drain_events(limit=1024):
            self._publish_safely(event)
        failure = getattr(source, "failure", None)
        if failure is not None and self.session.state is not LiveState.FAILED:
            db.update_session(self.session.session_id, state=LiveState.FAILED,
                              error=failure.to_dict(), stopped_at=time.time())
            self.session.state = LiveState.FAILED

    def _publish_safely(self, event: Any) -> None:
        """Publish one browser event, surviving a bad one.

        The structured channel runs on its own thread, and an exception there
        would kill it outright — leaving a session that still captures pixels
        and silently stops reporting console errors. A dropped event is a
        small loss; a dead channel that nothing announces is a large one, so
        the failure is counted and the loop continues.
        """
        try:
            self._publish_browser_event(event)
        except Exception:  # noqa: BLE001 - one bad event must not end the channel
            with self._lock:
                self.stats.provider_failures += 1

    def _publish_browser_event(self, event: Any) -> None:
        """Turn one structured browser fact into a citable live event.

        Errors keep ``ERROR`` so anything filtering for failures finds them
        without having to know a browser produced them; everything else lands
        as ``BROWSER_EVENT`` with the full structured payload under
        ``detail.browser``. The page-authored flag rides along untouched.
        """
        payload = event.to_public()
        kind = payload["kind"]
        is_error = (
            kind in ("page_error", "request_failed", "navigation_failed",
                     "target_crashed")
            or (kind == "console" and payload["detail"].get("level")
                in ("error", "warning"))
            or (kind == "response" and int(payload["detail"].get("status", 0)) >= 400)
        )
        media_ts = payload["media_ts"]
        self._append(LiveEvent(
            session_id=self.session.session_id, seq=0,
            media_ts=media_ts, wall_ts=payload["wall_ts"],
            type=LiveEventType.ERROR if is_error else LiveEventType.BROWSER_EVENT,
            confidence=1.0,
            # Structured browser evidence is observed, not inferred: the
            # browser reported it happening. What the page *said* in it is
            # another matter, which is what `page_authored` records.
            provenance=Provenance.OBSERVATION,
            summary=payload["summary"],
            detector=f"browser:{kind}",
            detail={"browser": payload},
        ))
        # Anything worth an event is worth the picture around it. Errors get a
        # wider window because the cause is usually visible before the symptom.
        window = 5.0 if is_error else 2.0
        buf.pin_window(self.session.session_id, media_ts,
                       before=window, after=window)

    def _on_discontinuity(self, stream: str, kind: str, media_ts: float) -> None:
        """Report a jump in a stream's timeline.

        A reconnect resets the source's clock, and averaging that into a
        drift figure would report a synchronisation problem that is really a
        new timeline. It gets its own event so a reader can tell them apart.
        """
        self._append(LiveEvent(
            session_id=self.session.session_id, seq=0,
            media_ts=media_ts, wall_ts=time.time(),
            type=LiveEventType.CAPTURE_GAP,
            summary=f"{stream} timeline {kind} at {media_ts:.2f}s",
            detector="clock",
            detail={"stream": stream, "discontinuity": kind},
        ))

    def _on_audio_gap(self, start: float, end: float) -> None:
        self._append(LiveEvent(
            session_id=self.session.session_id, seq=0,
            media_ts=start, wall_ts=time.time(),
            type=LiveEventType.CAPTURE_GAP,
            summary=f"audio gap of {end - start:.2f}s",
            detector="audio",
            detail={"start": round(start, 3), "end": round(end, 3),
                    "stream": "audio"},
        ))

    def _warm_models(self) -> None:
        """Start slow models loading beside the fast detectors, not in front."""
        from watch_skill.models import register_builtin_models  # noqa: PLC0415

        registry = register_builtin_models()
        wanted = ["ocr"] if get_settings().ocr_enabled else []
        # Warm ASR too, and separately. Its weights load on first use, which
        # for a short source means the first utterance is still waiting for
        # the model when the stream ends — the session would then produce no
        # speech at all, for a reason that looks like silence.
        if self._audio is not None and self._audio.backend is not None:
            backend = self._audio.backend
            if hasattr(backend, "_load") and "asr" not in registry.registered():
                registry.register("asr", backend._load, estimated_mb=500)
            if "asr" in registry.registered():
                wanted.append("asr")
        registry.warm(*wanted)

    def detector_status(self) -> dict[str, Any]:
        """Readiness per detector, for live status.

        `scene_change` is always ready because it is arithmetic over pixels —
        there is no model to wait for. Saying so explicitly is the point: an
        operator seeing no text events needs to know whether OCR is warming,
        degraded, or simply looking at a screen with no text on it.
        """
        from watch_skill.models import ModelState, get_registry  # noqa: PLC0415

        status: dict[str, Any] = {"scene_change": {"status": "ready"}}
        registry = get_registry()
        settings = get_settings()

        if not settings.ocr_enabled:
            status["ocr"] = {"status": "degraded", "reason": "disabled_by_config"}
        elif "ocr" in registry.registered():
            status["ocr"] = registry.status("ocr").to_dict()
        else:
            status["ocr"] = {"status": ModelState.UNLOADED.value}

        status["asr"] = self._asr_status()
        status["semantic"] = (
            self._semantic.status() if self._semantic is not None
            else {"status": "degraded", "reason": "no_semantic_backend"}
        )
        return status

    def _asr_status(self) -> dict[str, Any]:
        if not self.session.spec.audio:
            return {"status": "degraded", "reason": "audio_disabled_for_this_session"}
        if self._audio is None:
            return {"status": "degraded", "reason": "no_audio_track_in_source"}
        return self._audio.status()

    def _ocr(self, path: Path) -> str | None:
        """Read a frame, or degrade. Never raise into the pipeline.

        Uses the lifecycle registry so a still-loading model is a wait rather
        than a duplicate load, and a permanently missing one is announced once
        instead of at the frame rate.
        """
        if not get_settings().ocr_enabled:
            return None
        from watch_skill.models import ModelState, get_registry  # noqa: PLC0415

        registry = get_registry()
        if "ocr" not in registry.registered():
            return None
        model = registry.get("ocr")
        if model.status.state in (ModelState.FAILED, ModelState.INITIALIZING):
            # Not an error: the frame is simply skipped while the model is not
            # ready, and the status already says which of the two it is.
            if model.status.state is ModelState.FAILED and model.announce_once("ocr_failed"):
                self._emit(LiveEventType.PROVIDER_DEGRADED, 0.0,
                           f"OCR unavailable: {model.status.reason}",
                           detector="ocr")
            return None
        try:
            from watch_skill.perceive.ocr import ocr_frame  # noqa: PLC0415

            blocks = ocr_frame(path)
        except Exception as exc:  # noqa: BLE001 - OCR is best effort in a live loop
            with self._lock:
                self.stats.provider_failures += 1
            if model.announce_once("ocr_runtime_error"):
                self._emit(LiveEventType.PROVIDER_DEGRADED, 0.0,
                           f"OCR is failing: {str(exc)[:120]}", detector="ocr")
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
            if self._audio is not None:
                audio = self._audio.stats()
                self.stats.audio_chunks = audio["chunks_captured"]
                self.stats.audio_gap_seconds = audio["gap_seconds"]
                self.stats.queue_depths.update(audio["queue_depths"])
        db.update_session(self.session.session_id, stats=self.stats)

    # --- stopping ----------------------------------------------------------

    def stop(self, reason: str = "stopped by request", *, failed: bool = False,
             error: dict[str, Any] | None = None) -> LiveSession:
        if self.stop_event.is_set():
            return self.session
        self.stop_event.set()
        db.update_session(self.session.session_id, state=LiveState.STOPPING)
        if self._source is not None:
            self._source.stop()
        if self._audio is not None:
            # Stopped first so its flush lands before the event log closes —
            # the trailing utterance is usually why someone hit stop.
            self._audio.stop()
        if self._semantic is not None:
            # Stops accepting frames and releases the model process. Stop must
            # not wait tens of seconds for an in-flight interpretation, so the
            # worker is torn down rather than drained — the frames it was
            # holding are already recorded as dropped.
            self._semantic.stop()
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
        final_state = LiveState.FAILED if failed else LiveState.STOPPED
        db.update_session(self.session.session_id, state=final_state,
                          stopped_at=time.time(), stats=self.stats, error=error)
        self.session.state = final_state
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
    asr_backend: Any = None,
    detail: dict[str, Any] | None = None,
    allow_local: bool = False,
    allowed_hosts: list[str] | None = None,
) -> LiveSession:
    """Begin watching something live.

    Fails before creating a session when the source cannot be captured on
    this machine, rather than producing a session that never emits anything —
    an empty live view is indistinguishable from a quiet one.

    ``allow_local`` and ``allowed_hosts`` are the only browser-navigation
    knobs surfaces expose, and they are deliberately narrow. A free-form
    options dict on a public surface would let an agent acting on text it
    read from a webpage widen its own network reach; two named booleans
    cannot be talked into anything.
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
        # A browser has no audio track to capture — the page's sound is not
        # routed anywhere this process can read — so asking for it would only
        # produce a degraded-audio event on every browser session.
        audio=audio and source_kind is not LiveSourceKind.BROWSER,
        detail=_source_detail(detail, allow_local, allowed_hosts),
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
        source = open_source(spec, media_dir, session_id=session.session_id)
        # Sources that own a process launch it here, still before the session
        # row exists, so a missing chromium or a refused URL leaves nothing
        # behind to explain in `live list`.
        if hasattr(source, "start") and source_kind is LiveSourceKind.BROWSER:
            source.start()
    except WatchSkillError:
        buf.cleanup(session.session_id)
        raise

    db.insert_session(session)
    runner = RunningSession(session, source)
    # Injected rather than discovered so CI can prove the audio *transport*
    # without the optional model. The backend names itself in every event it
    # produces, so a fixture transcript is never mistaken for recognition.
    runner._asr_backend = asr_backend
    try:
        runner.start()
    except WatchSkillError as exc:
        # Past this point the session did exist, so its failure is recorded.
        db.update_session(session.session_id, state=LiveState.FAILED,
                          error=exc.to_dict(), stopped_at=time.time())
        raise
    _register(runner)
    return session


def _source_detail(detail: dict[str, Any] | None, allow_local: bool,
                   allowed_hosts: list[str] | None) -> dict[str, Any]:
    """Fold the narrow public knobs into the spec's detail bag.

    The explicit arguments win over anything already in ``detail``, so a
    caller cannot smuggle a wider policy past the named parameters that a
    surface actually validates.
    """
    merged = dict(detail or {})
    if allow_local:
        merged["allow_loopback"] = True
    if allowed_hosts:
        merged["allowed_hosts"] = [str(host).strip().lower()
                                   for host in allowed_hosts if str(host).strip()]
    return merged


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
    if runner is not None:
        payload["detectors"] = runner.detector_status()
        payload["clock"] = runner.clock.to_dict()
        if runner._audio is not None:
            payload["audio"] = runner._audio.stats()
        if hasattr(runner._source, "diagnostics"):
            payload["browser"] = runner._source.diagnostics()
    return payload


def aligned_evidence(
    session_id: str, media_ts: float, window: float = 2.0, limit: int = 8
) -> dict[str, Any]:
    """What every stream observed around one moment.

    The answer to "what was on screen when they said that": one anchor
    timestamp, everything within a window of it from any stream, nearest
    first. Correlation is deterministic — timestamp overlap, nothing learned —
    so an operator can reproduce the result by hand.
    """
    get_session(session_id)  # raises a structured error for an unknown session
    events = db.read_events(session_id, limit=500)
    nearby = correlate(media_ts, events, window=window)[:limit]
    by_stream: dict[str, list[dict[str, Any]]] = {}
    for event in nearby:
        stream = "audio" if event.type is LiveEventType.SPEECH else "video"
        by_stream.setdefault(stream, []).append(event.to_public())
    return {
        "schema_version": 1,
        "session_id": session_id,
        "anchor_media_ts": round(media_ts, 3),
        "window_seconds": window,
        "streams": by_stream,
        "count": len(nearby),
    }


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
