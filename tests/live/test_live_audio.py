"""Live audio: real PCM through the production path, then real events.

Two layers, kept distinct on purpose:

* **Transport** — that audio bytes flow from ffmpeg through chunking,
  assembly and timestamping. Proved here with real generated audio on every
  run, no optional model needed.
* **Recognition** — that speech becomes text. Proved with the deterministic
  fixture backend for the plumbing, and with local whisper only when the
  optional model is actually installed. A fixture backend recognising nothing
  is never presented as recognition working.
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

from watch_skill.live import db
from watch_skill.live import session as live_session
from watch_skill.live.asr import DeterministicASR, TranscriptPiece
from watch_skill.live.audio import (
    BYTES_PER_SECOND,
    SAMPLE_RATE,
    AudioChunk,
    UtteranceAssembler,
    is_probably_silent,
    source_has_audio,
)
from watch_skill.live.types import LiveEventType, LiveState

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


def _wait_for(predicate, timeout: float, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def _speech(pcm_seconds: float = 1.0, amplitude: int = 8000) -> bytes:
    """Loud PCM that the silence gate will let through."""
    import math
    import struct

    samples = int(SAMPLE_RATE * pcm_seconds)
    return b"".join(
        struct.pack("<h", int(amplitude * math.sin(i * 0.05)))
        for i in range(samples)
    )


# --- chunk contracts ----------------------------------------------------------


def test_a_chunk_computes_its_own_duration_and_end() -> None:
    chunk = AudioChunk(session_id="s", seq=1, pcm=_speech(0.5), media_ts=2.0,
                       wall_ts=time.time())
    assert chunk.sample_count == SAMPLE_RATE // 2
    assert chunk.duration == pytest.approx(0.5, abs=0.01)
    assert chunk.end_media_ts == pytest.approx(2.5, abs=0.01)


def test_public_chunk_metadata_never_contains_samples() -> None:
    """Audio bytes in a tool result are a privacy problem and a context one."""
    chunk = AudioChunk(session_id="s", seq=1, pcm=_speech(), media_ts=0.0,
                       wall_ts=time.time())
    payload = chunk.to_public()
    assert "pcm" not in payload
    for value in payload.values():
        assert not isinstance(value, bytes)


def test_silence_is_gated_before_it_reaches_a_model() -> None:
    assert is_probably_silent(b"\x00\x00" * SAMPLE_RATE) is True
    assert is_probably_silent(_speech()) is False
    assert is_probably_silent(b"") is True


# --- utterance assembly -------------------------------------------------------


def test_utterances_carry_overlap_so_boundary_words_survive() -> None:
    """Adjacent blocks reliably lose the word sitting on the seam."""
    assembler = UtteranceAssembler(session_id="s", utterance_seconds=2.0,
                                   overlap_seconds=0.5)
    produced = []
    for i in range(6):
        chunk = AudioChunk(session_id="s", seq=i, pcm=_speech(1.0),
                           media_ts=float(i), wall_ts=time.time())
        utterance = assembler.add(chunk)
        if utterance is not None:
            produced.append(utterance)

    assert len(produced) >= 2
    first, second = produced[0], produced[1]
    assert second.media_ts < first.end_media_ts, "no overlap between utterances"
    assert second.media_ts == pytest.approx(first.end_media_ts - 0.5, abs=0.05)


def test_flush_emits_the_trailing_audio() -> None:
    """The last utterance is usually why someone hit stop."""
    assembler = UtteranceAssembler(session_id="s", utterance_seconds=10.0)
    assembler.add(AudioChunk(session_id="s", seq=1, pcm=_speech(1.0),
                             media_ts=0.0, wall_ts=time.time()))
    tail = assembler.flush()
    assert tail is not None
    assert tail.duration == pytest.approx(1.0, abs=0.05)


def test_flush_ignores_a_sliver_too_short_to_transcribe() -> None:
    assembler = UtteranceAssembler(session_id="s")
    assembler.add(AudioChunk(session_id="s", seq=1, pcm=_speech(0.1),
                             media_ts=0.0, wall_ts=time.time()))
    assert assembler.flush(min_seconds=0.4) is None


def test_an_utterance_writes_a_readable_wav(tmp_path: Path) -> None:
    import wave

    assembler = UtteranceAssembler(session_id="s", utterance_seconds=1.0)
    utterance = assembler.add(AudioChunk(
        session_id="s", seq=1, pcm=_speech(1.5), media_ts=0.0, wall_ts=time.time()
    ))
    assert utterance is not None
    path = utterance.write_wav(tmp_path / "u.wav")
    with wave.open(str(path)) as handle:
        assert handle.getframerate() == SAMPLE_RATE
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getnframes() > 0


# --- the real ffmpeg audio path ----------------------------------------------


def test_a_silent_video_reports_no_audio_track(state_change_clip: Path) -> None:
    """Better than an ASR backend that mysteriously never speaks."""
    assert source_has_audio(state_change_clip) is False


def test_the_audiovisual_fixture_really_has_audio(audiovisual_clip: Path) -> None:
    assert source_has_audio(audiovisual_clip) is True


def test_real_pcm_flows_through_the_production_ffmpeg_path(
    audiovisual_clip: Path,
) -> None:
    """Transport, end to end: ffmpeg -> normalized PCM -> timestamped chunks.

    No model involved. If this fails, nothing downstream can be trusted.
    """
    from watch_skill.live.audio import file_replay_audio

    source = file_replay_audio(str(audiovisual_clip))
    chunks = []
    try:
        for chunk in source.chunks("live_test"):
            chunks.append(chunk)
            if len(chunks) >= 4:
                break
    finally:
        source.stop()

    assert len(chunks) == 4, f"only got {len(chunks)} chunks"
    for chunk in chunks:
        assert chunk.sample_rate == SAMPLE_RATE
        assert chunk.channels == 1
        assert len(chunk.pcm) > 0
        assert chunk.pcm != b"\x00" * len(chunk.pcm), "captured pure silence"
    # Timestamps advance monotonically and contiguously.
    for earlier, later in zip(chunks, chunks[1:], strict=False):
        assert later.media_ts == pytest.approx(earlier.end_media_ts, abs=0.05)
    assert chunks[0].media_ts == pytest.approx(0.0, abs=0.01)


def test_file_replay_audio_is_paced_at_real_time(audiovisual_clip: Path) -> None:
    """`-re` is what makes a replayed file a live source rather than a read."""
    from watch_skill.live.audio import file_replay_audio

    source = file_replay_audio(str(audiovisual_clip))
    started = time.monotonic()
    captured = 0.0
    try:
        for chunk in source.chunks("live_test"):
            captured = chunk.end_media_ts
            if captured >= 3.0:
                break
    finally:
        source.stop()
    elapsed = time.monotonic() - started
    assert elapsed >= 2.0, (
        f"3s of audio arrived in {elapsed:.1f}s — the source is not paced"
    )


# --- recognition transport (deterministic backend) ----------------------------


def test_the_deterministic_backend_is_labelled_as_a_fixture() -> None:
    """It must never be mistakable for recognition in an event payload."""
    backend = DeterministicASR([{"start": 0.0, "end": 5.0, "text": "hello"}])
    assembler = UtteranceAssembler(session_id="s", utterance_seconds=1.0)
    utterance = assembler.add(AudioChunk(
        session_id="s", seq=1, pcm=_speech(1.5), media_ts=0.0, wall_ts=time.time()
    ))
    assert utterance is not None
    piece = backend.transcribe(utterance)
    assert piece is not None
    assert piece.backend == "deterministic-fixture"
    assert piece.text == "hello"


def test_the_deterministic_backend_respects_time_windows() -> None:
    backend = DeterministicASR([{"start": 10.0, "end": 12.0, "text": "later"}])
    assembler = UtteranceAssembler(session_id="s", utterance_seconds=1.0)
    utterance = assembler.add(AudioChunk(
        session_id="s", seq=1, pcm=_speech(1.5), media_ts=0.0, wall_ts=time.time()
    ))
    assert utterance is not None
    assert backend.transcribe(utterance) is None


# --- the audiovisual end-to-end proof -----------------------------------------


def test_live_audio_end_to_end(
    audiovisual_clip: Path, tmp_path: Path, isolated_settings: Path
) -> None:
    """Hear and see the same session, live, then remember both.

    Uses the deterministic ASR backend so this runs everywhere. That proves
    the transport, the clock, the event shape and the finalisation — not
    recognition quality, which is what test_local_whisper_transcribes covers
    when the model is present.
    """
    cues = [
        {"start": 0.0, "end": 6.0, "text": "the system is ready"},
        {"start": 7.0, "end": 14.0, "text": "we are seeing error five oh two"},
    ]
    session = live_session.start_live(
        str(audiovisual_clip), kind="file_replay", fps=2.0,
        asr_backend=DeterministicASR(cues),
    )

    # --- a speech event before the stream ends ---------------------------
    seen: dict[str, object] = {}

    def speech_seen():
        batch = live_session.observe(session.session_id, limit=200)
        hits = [e for e in batch["events"]
                if e["type"] == LiveEventType.SPEECH.value]
        if not hits:
            return None
        # Record the state at the FIRST speech sighting and never again. The
        # assertion below is that speech arrived before the stream ended, and
        # overwriting this on every poll measured something else: whether the
        # source was still running when the *second* cue landed. That cue ends
        # at 14 s, so on a slow runner the replay finished first and the test
        # failed while the property it names held perfectly.
        if "source_running" not in seen:
            runner = live_session.running_session(session.session_id)
            seen["source_running"] = bool(
                runner and runner._source and runner._source.running
            )
            seen["first_at"] = min(e["media_ts"] for e in hits)
        # Wait for the SECOND cue specifically. Stopping at the first speech
        # event would end the session at ~4s and the later utterance would
        # never be spoken — which is exactly how an earlier version of this
        # test "proved" a transcript it had cut off before recording.
        return hits if any(e["media_ts"] >= 6.0 for e in hits) else None

    speech = _wait_for(speech_seen, timeout=40.0, interval=0.05)
    assert speech, (
        "no speech event was produced; audio status="
        f"{live_session.status(session.session_id).get('detectors', {}).get('asr')}"
    )
    assert seen["source_running"], "speech only surfaced after the source ended"

    # --- both modalities present and on the same clock -------------------
    visual = _wait_for(
        lambda: [
            e for e in live_session.observe(session.session_id, limit=200)["events"]
            if e["type"] in (LiveEventType.SCENE_CHANGE.value,
                             LiveEventType.VISIBLE_TEXT_CHANGE.value)
        ] or None,
        timeout=25.0,
    )
    assert visual, "no visual event alongside the audio"
    assert all(e["media_ts"] >= 0 for e in speech)

    status = live_session.status(session.session_id)
    assert status["detectors"]["asr"]["status"] in ("ready", "initializing")
    assert status["audio"]["chunks_captured"] > 0
    assert status["audio"]["seconds_captured"] > 0

    # --- ask what was said, and get timestamps back ----------------------
    from watch_skill.live import ask as live_ask

    answer = live_ask.ask_live(session.session_id, "what did they say about errors?",
                               scope="session")
    assert answer["evidence"], "the live answer cited nothing"

    # --- stop, finalize, and read it back from a new process -------------
    live_session.stop_live(session.session_id)
    from watch_skill.live.finalize import finalize_session

    video_id = finalize_session(session.session_id)
    assert video_id

    # Release models the parent no longer needs; the child needs the memory.
    from watch_skill.models import get_registry

    get_registry().release_all()

    probe = tmp_path / "probe.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.index.store import get_video
        from watch_skill.index.retrieval import ask_video
        row = get_video({video_id!r})
        ctx = ask_video({video_id!r}, "error five oh two")
        text = " ".join(h.get("text", "") for h in ctx["hits"]).lower()
        print(json.dumps({{
            "found": row is not None,
            "hits": len(ctx["hits"]),
            "has_speech": "error" in text,
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["found"], "the finalized session is not indexed"
    assert payload["hits"] > 0
    assert payload["has_speech"], "the transcript did not survive finalisation"


def test_a_session_without_an_audio_track_says_so(state_change_clip: Path) -> None:
    """Silence with no explanation is the failure this prevents."""
    session = live_session.start_live(str(state_change_clip), fps=2.0)
    try:
        status = live_session.status(session.session_id)
        assert status["detectors"]["asr"]["status"] == "degraded"
        assert status["detectors"]["asr"]["reason"] == "no_audio_track_in_source"
        assert status["detectors"]["scene_change"]["status"] == "ready", (
            "a missing audio track must not degrade the visual detectors"
        )
    finally:
        live_session.stop_live(session.session_id)


def test_audio_disabled_by_the_spec_is_reported_as_such(
    audiovisual_clip: Path,
) -> None:
    session = live_session.start_live(str(audiovisual_clip), fps=2.0, audio=False)
    try:
        detectors = live_session.status(session.session_id)["detectors"]
        assert detectors["asr"]["reason"] == "audio_disabled_for_this_session"
    finally:
        live_session.stop_live(session.session_id)


def test_a_failing_asr_backend_degrades_to_visual_only(
    audiovisual_clip: Path,
) -> None:
    """ASR breaking must cost speech events, not the whole session."""

    class ExplodingASR:
        name = "exploding"

        def transcribe(self, utterance):
            raise RuntimeError("model died")

        def close(self):
            return

    session = live_session.start_live(
        str(audiovisual_clip), fps=2.0, asr_backend=ExplodingASR(),
    )
    try:
        visual = _wait_for(
            lambda: [
                e for e in live_session.observe(session.session_id, limit=100)["events"]
                if e["type"] == LiveEventType.SCENE_CHANGE.value
            ] or None,
            timeout=25.0,
        )
        assert visual, "visual events stopped when ASR failed"
        status = live_session.status(session.session_id)
        assert status["state"] == LiveState.RUNNING.value
    finally:
        live_session.stop_live(session.session_id)


@pytest.mark.skipif(
    not os.environ.get("WATCHSKILL_TEST_LOCAL_ASR"),
    reason="real local-ASR recognition; set WATCHSKILL_TEST_LOCAL_ASR=1 with "
    "faster-whisper installed to run it",
)
def test_local_whisper_transcribes_real_speech(tmp_path: Path) -> None:
    """The recognition test the deterministic backend does NOT replace."""
    pytest.importorskip("faster_whisper")
    from watch_skill.live.asr import LocalWhisperASR
    from watch_skill.live.audio import Utterance

    speech_wav = tmp_path / "speech.wav"
    # espeak-style synthesis is not guaranteed present; skip rather than fake.
    if not Path(os.environ.get("WATCHSKILL_TEST_SPEECH_WAV", "")).is_file():
        pytest.skip("set WATCHSKILL_TEST_SPEECH_WAV to a real speech wav file")
    speech_wav = Path(os.environ["WATCHSKILL_TEST_SPEECH_WAV"])

    import wave

    with wave.open(str(speech_wav)) as handle:
        pcm = handle.readframes(handle.getnframes())
    piece = LocalWhisperASR().transcribe(
        Utterance(session_id="s", index=1, pcm=pcm, media_ts=0.0)
    )
    assert piece is not None and piece.text.strip()
    assert piece.backend == "faster-whisper"


def test_speech_events_are_persisted_with_transcript_evidence(
    audiovisual_clip: Path,
) -> None:
    session = live_session.start_live(
        str(audiovisual_clip), fps=2.0,
        asr_backend=DeterministicASR([{"start": 0.0, "end": 14.0, "text": "hello"}]),
    )
    try:
        _wait_for(
            lambda: [
                e for e in db.read_events(session.session_id, limit=100)
                if e.type is LiveEventType.SPEECH
            ] or None,
            timeout=30.0,
        )
        events = [e for e in db.read_events(session.session_id, limit=100)
                  if e.type is LiveEventType.SPEECH]
        assert events, "no speech event was persisted"
        event = events[0]
        assert event.evidence and event.evidence[0].kind == "transcript"
        assert event.evidence[0].end_media_ts is not None
        assert event.detector == "deterministic-fixture"
    finally:
        live_session.stop_live(session.session_id)


def test_transcript_piece_public_shape() -> None:
    piece = TranscriptPiece(text="x", media_ts=1.0, end_media_ts=2.0,
                            confidence=0.5, backend="b")
    payload = piece.to_public()
    assert payload["final"] is True
    assert payload["media_ts"] == 1.0
    assert payload["backend"] == "b"


def test_bytes_per_second_matches_the_declared_format() -> None:
    """The one constant everything else derives its timestamps from."""
    assert BYTES_PER_SECOND == SAMPLE_RATE * 1 * 2
