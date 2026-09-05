"""A GPU that is visible is not a GPU that works, and the difference is a transcript.

``has_cuda_gpu`` asks ``nvidia-smi`` whether an NVIDIA card with enough memory
is present. That is a real question and it is not the question that matters
here: CTranslate2 needs a matching CUDA and cuDNN runtime, and a machine can
have the card without them. On this repository's development machine, loading
the model raised ``Library cublas64_12.dll is not found or cannot be loaded``
— and the whole transcription ended there, reporting "no whisper rung
succeeded" about a clip the same machine's processor transcribes in four
seconds.

The advice to set ``WATCHSKILL_WHISPER_DEVICE=cpu`` was already in the error's
``fix``, which is not where somebody reading a report will find it, on a path
that had already given up.

So a *guessed* CUDA is retried once on the processor. A device somebody asked
for is not retried anywhere: honouring an explicit choice matters more than
succeeding, because a benchmark that quietly ran somewhere else measured
nothing.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.errors import TranscriptionError
from watch_skill.transcribe import local


class _Segment:
    def __init__(self, start: float, end: float, text: str) -> None:
        self.start, self.end, self.text = start, end, text
        self.words: list = []


def _install_model(monkeypatch: pytest.MonkeyPatch, behaviour: dict[str, object]) -> list[str]:
    """Stand a fake ``WhisperModel`` in, and record the devices it was asked for."""
    tried: list[str] = []

    class FakeModel:
        def __init__(self, size: str, device: str, compute_type: str) -> None:
            tried.append(device)
            outcome = behaviour.get(device)
            if isinstance(outcome, Exception):
                raise outcome
            self.device = device

        def transcribe(self, *args: object, **kwargs: object):
            return [_Segment(0.5, 1.5, "the server returned error five zero two")], None

    module = type("fw", (), {"WhisperModel": FakeModel})
    monkeypatch.setitem(__import__("sys").modules, "faster_whisper", module)
    return tried


def test_a_guessed_cuda_that_fails_is_retried_on_the_processor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    monkeypatch.delenv("WATCHSKILL_WHISPER_DEVICE", raising=False)
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    tried = _install_model(monkeypatch, {
        "cuda": RuntimeError("Library cublas64_12.dll is not found or cannot be loaded"),
    })

    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"")
    transcript = local.transcribe_local(audio, model_size="base")

    assert tried == ["cuda", "cpu"], "the processor must be tried after the GPU failed"
    assert len(transcript.segments) == 1
    assert "five zero two" in transcript.segments[0].text


def test_a_device_somebody_chose_is_honoured_even_when_it_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    monkeypatch.setenv("WATCHSKILL_WHISPER_DEVICE", "cuda")
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    tried = _install_model(monkeypatch, {"cuda": RuntimeError("no cuDNN here")})

    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"")
    with pytest.raises(TranscriptionError) as raised:
        local.transcribe_local(audio, model_size="base")

    assert tried == ["cuda"], "an explicit choice must not be silently overridden"
    assert raised.value.code == "transcribe.local_failed"
    assert raised.value.details["device"] == "cuda"


def test_a_processor_failure_is_not_retried_anywhere(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    monkeypatch.delenv("WATCHSKILL_WHISPER_DEVICE", raising=False)
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: False)
    tried = _install_model(monkeypatch, {"cpu": RuntimeError("out of memory")})

    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"")
    with pytest.raises(TranscriptionError):
        local.transcribe_local(audio, model_size="base")

    assert tried == ["cpu"], "there is nowhere to fall back to from the processor"


def test_both_failing_says_both_failed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    # The one thing worse than a GPU failure is a report that blames the GPU
    # for a failure the processor also had.
    monkeypatch.delenv("WATCHSKILL_WHISPER_DEVICE", raising=False)
    monkeypatch.setattr(local, "has_cuda_gpu", lambda: True)
    _install_model(monkeypatch, {
        "cuda": RuntimeError("no cuDNN"),
        "cpu": RuntimeError("model file is corrupt"),
    })

    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"")
    with pytest.raises(TranscriptionError) as raised:
        local.transcribe_local(audio, model_size="base")

    assert "on the GPU and on the processor" in str(raised.value)
    assert raised.value.details["device"] == "cuda->cpu"
    assert "no cuDNN" in raised.value.details["cuda_error"]
    assert "corrupt" in str(raised.value)


def test_requested_device_separates_a_choice_from_a_guess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("WATCHSKILL_WHISPER_DEVICE", raising=False)
    assert local.requested_device() is None
    monkeypatch.setenv("WATCHSKILL_WHISPER_DEVICE", "  CPU ")
    assert local.requested_device() == "cpu"
    monkeypatch.setenv("WATCHSKILL_WHISPER_DEVICE", "metal")
    assert local.requested_device() is None, "an unsupported name is not a choice"
