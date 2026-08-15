"""Real faster-whisper recognition — the proof a fixture backend cannot give.

Everything here runs an actual model. The regular suite proves *transport*:
that audio bytes flow, that timestamps line up, that events appear before EOF.
None of that says a word was recognised correctly, and reporting it as though
it did would be the exact overstatement this file exists to prevent.

Opt in with ``WATCHSKILL_TEST_REAL_ASR=1``. Skipped otherwise, and skipped
without the model already cached — a test suite that silently downloads half a
gigabyte is not one anybody can trust to be offline.

Setup:

    python scripts/make_speech_fixture.py --out tests/fixtures/speech
    WATCHSKILL_TEST_REAL_ASR=1 pytest tests/integration/test_real_asr.py
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

REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_SRC = str(REPO_ROOT / "src")

pytestmark = [
    pytest.mark.real_model,
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_TEST_REAL_ASR"),
        reason="real-model ASR gate; set WATCHSKILL_TEST_REAL_ASR=1 to run "
        "(see docs/testing.md)",
    ),
]

# Synthetic speech is a *clean* recognition problem. A model that cannot manage
# this is broken; one that manages it is not thereby proven on real recordings.
# The threshold is set to catch breakage, not to certify accuracy.
MAX_WER = 0.20


def _model_is_cached(size: str = "tiny") -> bool:
    """Whether the weights are already on disk. Never triggers a download."""
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    hub = home / "hub" if home.name != "hub" else home
    return (hub / f"models--Systran--faster-whisper-{size}").is_dir()


requires_model = pytest.mark.skipif(
    not _model_is_cached(),
    reason="faster-whisper-tiny is not cached; run "
    "`python -c \"from faster_whisper import WhisperModel; "
    "WhisperModel('tiny')\"` once with network access first",
)


@pytest.fixture(scope="module")
def speech_fixture(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """Synthesize the rights-clear speech fixture with a known transcript."""
    pytest.importorskip("faster_whisper")
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from make_speech_fixture import build  # noqa: PLC0415

    out_dir = tmp_path_factory.mktemp("speech fixture")
    try:
        manifest = build(out_dir)
    except SystemExit as exc:
        pytest.skip(f"no system text-to-speech voice: {exc}")
    manifest["path"] = out_dir / manifest["audio"]
    return manifest


# --- recognition accuracy -----------------------------------------------------


@requires_model
def test_real_whisper_recognises_the_reference_transcript(
    speech_fixture: dict, record_property
) -> None:
    """The headline measurement, recorded so the report can quote it."""
    from benchmarks.asr_accuracy import measure

    result = measure(speech_fixture["path"], speech_fixture["reference_text"])
    payload = result.to_dict()
    record_property("asr_accuracy", json.dumps(payload))
    print("\n" + json.dumps(payload, indent=2))

    assert result.wer <= MAX_WER, (
        f"WER {result.wer:.3f} exceeds {MAX_WER} on clean synthetic speech; "
        f"heard {result.hypothesis!r}"
    )
    assert result.reference_words > 10, "the fixture is too short to be a test"
    assert result.language == "en"


@requires_model
def test_recognition_keeps_up_with_real_time(speech_fixture: dict) -> None:
    """A live transcriber slower than the audio falls behind forever."""
    from benchmarks.asr_accuracy import measure

    result = measure(speech_fixture["path"], speech_fixture["reference_text"])
    assert result.realtime_factor < 1.0, (
        f"transcription ran at {result.realtime_factor:.2f}x realtime — a live "
        "session would fall further behind every second"
    )


@requires_model
def test_segments_carry_usable_timestamps(speech_fixture: dict) -> None:
    """Timestamps are half the point: an answer without one cannot be cited."""
    from faster_whisper import WhisperModel

    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    segments = list(model.transcribe(
        str(speech_fixture["path"]), beam_size=1, word_timestamps=True
    )[0])
    assert segments, "no segments produced"
    for segment in segments:
        assert segment.end > segment.start
        assert segment.start >= 0
    for earlier, later in zip(segments, segments[1:], strict=False):
        assert later.start >= earlier.start, "segments are out of order"

    duration = float(speech_fixture["utterances"][-1]["start"]) + 6.0
    assert segments[-1].end <= duration, "a timestamp ran past the audio"

    words = [w for s in segments for w in (s.words or [])]
    assert words, "word timestamps were requested but none came back"
    assert all(w.end >= w.start for w in words)


# --- the live pipeline, driven by the real model ------------------------------


@requires_model
def test_real_asr_produces_speech_events_before_the_stream_ends(
    speech_fixture: dict, isolated_settings: Path, tmp_path: Path
) -> None:
    """The whole live path with a real recogniser rather than a fixture one."""
    from watch_skill.live import session as live_session
    from watch_skill.live.asr import LocalWhisperASR
    from watch_skill.live.types import LiveEventType

    # Looped to ~33s. The property under test is real, but it needs a source
    # longer than model-load plus one utterance window (4s) for anyone to
    # observe it — an 8s clip ends while the first utterance is still with the
    # recogniser, which would fail the test for a reason that is not a defect.
    clip = _wrap_audio_as_video(speech_fixture["path"], tmp_path, repeats=4)
    session = live_session.start_live(
        str(clip), kind="file_replay", fps=1.0, asr_backend=LocalWhisperASR("tiny"),
    )
    try:
        seen: dict[str, object] = {}
        deadline = time.monotonic() + 90
        speech: list = []
        while time.monotonic() < deadline:
            events = live_session.observe(session.session_id, limit=200)["events"]
            speech = [e for e in events
                      if e["type"] == LiveEventType.SPEECH.value]
            if speech:
                runner = live_session.running_session(session.session_id)
                seen["running"] = bool(
                    runner and runner._source and runner._source.running
                )
                break
            time.sleep(0.1)

        assert speech, (
            "no speech event from the real model; asr status="
            f"{live_session.status(session.session_id).get('detectors', {}).get('asr')}"
        )
        assert seen.get("running"), "speech only surfaced after the source ended"
        assert speech[0]["detector"] == "faster-whisper", (
            "the event does not name the real backend"
        )
        text = " ".join(e["summary"] for e in speech).lower()
        assert any(word in text for word in ("checkout", "total", "server", "page")), (
            f"the real model recognised nothing recognisable: {text!r}"
        )
    finally:
        live_session.stop_live(session.session_id)


@requires_model
def test_cancelling_during_active_recognition_stops_promptly(
    speech_fixture: dict, tmp_path: Path
) -> None:
    """Stop must land while the model is working, not after it finishes."""
    from watch_skill.live import session as live_session
    from watch_skill.live.asr import LocalWhisperASR
    from watch_skill.live.types import LiveState

    clip = _wrap_audio_as_video(speech_fixture["path"], tmp_path, repeats=4)
    session = live_session.start_live(
        str(clip), kind="file_replay", fps=1.0, asr_backend=LocalWhisperASR("tiny"),
    )
    # Let recognition actually begin before pulling the plug.
    time.sleep(6.0)
    started = time.monotonic()
    live_session.stop_live(session.session_id)
    elapsed = time.monotonic() - started

    assert elapsed < 30, f"stop took {elapsed:.1f}s while ASR was running"
    assert live_session.get_session(session.session_id).state in (
        LiveState.STOPPED, LiveState.FINALIZED,
    )


@requires_model
def test_real_transcript_survives_finalisation_into_another_process(
    speech_fixture: dict, isolated_settings: Path, tmp_path: Path
) -> None:
    from watch_skill.live import session as live_session
    from watch_skill.live.asr import LocalWhisperASR
    from watch_skill.live.finalize import finalize_session
    from watch_skill.live.types import LiveEventType
    from watch_skill.models import get_registry

    clip = _wrap_audio_as_video(speech_fixture["path"], tmp_path)
    session = live_session.start_live(
        str(clip), kind="file_replay", fps=1.0, asr_backend=LocalWhisperASR("tiny"),
    )
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        events = live_session.observe(session.session_id, limit=200)["events"]
        if any(e["type"] == LiveEventType.SPEECH.value for e in events):
            break
        time.sleep(0.2)
    live_session.stop_live(session.session_id)
    video_id = finalize_session(session.session_id)

    # The child needs the memory this process is still holding.
    get_registry().release_all()

    probe = tmp_path / "probe.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.index.retrieval import ask_video
        ctx = ask_video({video_id!r}, "checkout total")
        text = " ".join(h.get("text", "") for h in ctx["hits"]).lower()
        print(json.dumps({{"hits": len(ctx["hits"]), "text": text[:400]}}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=600,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["hits"] > 0
    assert "checkout" in payload["text"] or "total" in payload["text"], (
        f"the real transcript did not survive: {payload['text']!r}"
    )


@requires_model
def test_real_asr_sends_nothing_over_the_network(speech_fixture: dict) -> None:
    """Local means local. A recogniser that phones home is not local-first."""
    import socket

    from watch_skill.live.asr import LocalWhisperASR
    from watch_skill.live.audio import Utterance

    calls: list = []
    original = socket.socket.connect

    def guard(self, address):  # noqa: ANN001
        calls.append(address)
        raise AssertionError(f"outbound connection attempted: {address!r}")

    with open(speech_fixture["path"], "rb") as handle:
        handle.seek(44)  # past the WAV header
        pcm = handle.read()

    socket.socket.connect = guard
    try:
        piece = LocalWhisperASR("tiny").transcribe(
            Utterance(session_id="s", index=1, pcm=pcm, media_ts=0.0)
        )
    finally:
        socket.socket.connect = original

    assert calls == [], f"the local ASR path made {len(calls)} outbound calls"
    assert piece is not None and piece.text.strip()


# --- helpers ------------------------------------------------------------------


def _wrap_audio_as_video(audio: Path, tmp_path: Path, repeats: int = 1) -> Path:
    """Mux the speech onto a plain colour video so it is a live A/V source."""
    from watch_skill.health.binaries import require_binary

    ffmpeg = str(require_binary("ffmpeg"))
    out = tmp_path / "speech clip.mp4"
    args = [ffmpeg, "-y", "-loglevel", "error"]
    if repeats > 1:
        args += ["-stream_loop", str(repeats - 1)]
    args += [
        "-i", str(audio),
        "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=5",
        "-map", "1:v", "-map", "0:a", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(out),
    ]
    subprocess.run(args, check=True, capture_output=True, timeout=300)
    return out
