"""The live audio pipeline: capture → assemble → transcribe → event.

Runs beside the video pipeline and shares nothing with it except the session
clock and the event log. That separation is the point — a vision stage that
falls behind sheds frames, while audio keeps every sample it captured.

Stages, each on its own thread with a bounded queue between:

``capture``
    Reads normalized PCM from ffmpeg and stamps it with both clocks. Bounded
    and *blocking*, because dropping audio to relieve pressure would lose
    speech. If this queue ever fills, the right answer is a recorded gap, not
    a silent discard.
``assemble``
    Accumulates chunks into overlapping utterances and gates out silence
    arithmetically, so the transcription model is never woken for a room
    where nobody is talking.
``transcribe``
    Hands each utterance to the ASR backend and emits a speech event.
"""
from __future__ import annotations

import threading
from typing import Any

from watch_skill.live.asr import ASRBackend
from watch_skill.live.audio import (
    AudioChunk,
    FfmpegAudioSource,
    UtteranceAssembler,
    is_probably_silent,
)
from watch_skill.live.pipeline import Overflow, Pipeline


class AudioRuntime:
    """Owns the audio half of a live session."""

    def __init__(
        self,
        session_id: str,
        source: FfmpegAudioSource,
        backend: ASRBackend | None,
        on_speech: Any,
        on_gap: Any = None,
    ) -> None:
        self.session_id = session_id
        self.source = source
        self.backend = backend
        self.on_speech = on_speech
        self.on_gap = on_gap
        self.pipeline = Pipeline()
        self.stop_event = threading.Event()
        self._lock = threading.Lock()
        self._assembler = UtteranceAssembler(session_id=session_id)
        self._degraded_reason = "" if backend else "no_local_asr_backend"
        self._announced: set[str] = set()

        self.chunks_captured = 0
        self.samples_captured = 0
        self.utterances = 0
        self.transcribed = 0
        self.silent_skipped = 0
        self.gap_seconds = 0.0
        self.last_media_ts = 0.0
        self._expected_next_ts = 0.0

    # --- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        # Blocking, not drop-oldest: speech is unrepeatable, and a queue that
        # sheds audio to keep up is a queue that loses words.
        assemble_stage = self.pipeline.stage("audio_assemble", 64, Overflow.BLOCK)
        transcribe_stage = self.pipeline.stage("audio_transcribe", 32, Overflow.BLOCK)

        self.pipeline.consume(assemble_stage, self._assemble, name="ws-live-audio-assemble")
        self.pipeline.consume(transcribe_stage, self._transcribe,
                              name="ws-live-audio-transcribe")
        self._transcribe_stage = transcribe_stage

        thread = threading.Thread(
            target=self._capture_loop, args=(assemble_stage,),
            name="ws-live-audio-capture", daemon=True,
        )
        thread.start()
        self._capture_thread = thread

    def stop(self) -> None:
        if self.stop_event.is_set():
            return
        self.stop_event.set()
        self.source.stop()
        # Flush before tearing down: the last utterance is often the one the
        # operator stopped the session to hear.
        tail = self._assembler.flush()
        if tail is not None and not is_probably_silent(tail.pcm):
            try:
                self._transcribe(tail)
            except Exception:  # noqa: BLE001
                pass
        self.pipeline.stop(timeout=5.0)
        if self.backend is not None:
            try:
                self.backend.close()
            except Exception:  # noqa: BLE001
                pass

    # --- stages ------------------------------------------------------------

    def _capture_loop(self, assemble_stage: Any) -> None:
        try:
            for chunk in self.source.chunks(self.session_id):
                if self.stop_event.is_set():
                    break
                self._note_gap(chunk)
                with self._lock:
                    self.chunks_captured += 1
                    self.samples_captured += chunk.sample_count
                    self.last_media_ts = chunk.end_media_ts
                assemble_stage.put(chunk)
        except Exception as exc:  # noqa: BLE001 - a dead mic ends audio, not the session
            self._degrade(f"audio capture stopped: {exc}")

    def _note_gap(self, chunk: AudioChunk) -> None:
        """Record time the capture skipped over.

        A transcript with an unmarked hole invites the reader to conclude
        nobody spoke, which is a different claim from "we were not listening".
        """
        expected = self._expected_next_ts
        if expected and chunk.media_ts > expected + 0.25:
            gap = chunk.media_ts - expected
            chunk.gap_before_seconds = gap
            with self._lock:
                self.gap_seconds += gap
            if self.on_gap is not None:
                self.on_gap(expected, chunk.media_ts)
        self._expected_next_ts = chunk.end_media_ts

    def _assemble(self, chunk: AudioChunk) -> None:
        utterance = self._assembler.add(chunk)
        if utterance is None:
            return
        with self._lock:
            self.utterances += 1
        if is_probably_silent(utterance.pcm):
            with self._lock:
                self.silent_skipped += 1
            return
        self._transcribe_stage.put(utterance)

    def _transcribe(self, utterance: Any) -> None:
        if self.backend is None:
            return
        try:
            piece = self.backend.transcribe(utterance)
        except Exception as exc:  # noqa: BLE001 - ASR failing degrades to visual-only
            self._degrade(f"transcription failed: {str(exc)[:160]}")
            return
        if piece is None or not piece.text.strip():
            return
        with self._lock:
            self.transcribed += 1
        self.on_speech(piece)

    # --- diagnostics -------------------------------------------------------

    def _degrade(self, reason: str) -> None:
        """Record a degradation and report it once, not per chunk."""
        with self._lock:
            self._degraded_reason = reason
            first = reason.split(":")[0] not in self._announced
            self._announced.add(reason.split(":")[0])
        if first and self.on_gap is not None:
            pass  # the status carries it; no event storm

    def status(self) -> dict[str, Any]:
        with self._lock:
            if self.backend is None:
                return {"status": "degraded",
                        "reason": self._degraded_reason or "model_unavailable"}
            if self._degraded_reason:
                return {"status": "degraded", "reason": self._degraded_reason}
        from watch_skill.models import get_registry  # noqa: PLC0415

        registry = get_registry()
        if "asr" in registry.registered():
            payload = registry.status("asr").to_dict()
            payload.setdefault("backend", self.backend.name)
            return payload
        return {"status": "ready", "backend": self.backend.name}

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "chunks_captured": self.chunks_captured,
                "seconds_captured": round(
                    self.samples_captured / 16_000.0, 2
                ),
                "utterances": self.utterances,
                "transcribed": self.transcribed,
                "silent_skipped": self.silent_skipped,
                "gap_seconds": round(self.gap_seconds, 3),
                "last_media_ts": round(self.last_media_ts, 3),
                "queue_depths": self.pipeline.depths(),
                "backend": self.backend.name if self.backend else None,
            }


def build_audio_runtime(
    session_id: str,
    kind: str,
    target: str,
    on_speech: Any,
    on_gap: Any = None,
    backend: ASRBackend | None = None,
) -> AudioRuntime | None:
    """Construct the audio half of a session, or None when there is none.

    None is a real answer with a real reason: a silent video, a source kind
    with no audio path, or no local ASR installed. The session reports which
    through `detectors.asr` rather than simply never producing speech.
    """
    from pathlib import Path

    from watch_skill.live.asr import build_asr_backend
    from watch_skill.live.audio import file_replay_audio, source_has_audio, stream_audio

    if kind == "file_replay":
        if not source_has_audio(Path(target)):
            return None
        source = file_replay_audio(target)
    elif kind == "stream":
        source = stream_audio(target)
    else:
        return None

    return AudioRuntime(
        session_id=session_id,
        source=source,
        backend=backend if backend is not None else build_asr_backend(),
        on_speech=on_speech,
        on_gap=on_gap,
    )

