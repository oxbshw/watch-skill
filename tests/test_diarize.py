"""Diarization: pure speaker-assignment logic + structured degradation."""
from __future__ import annotations

from agentvision.transcribe.diarize import SpeakerTurn, assign_speakers
from agentvision.transcribe.types import Segment, Transcript


def _transcript() -> Transcript:
    return Transcript(
        segments=[
            Segment(0.0, 4.0, "hello and welcome"),
            Segment(4.0, 8.0, "thanks for having me"),
            Segment(20.0, 24.0, "closing remarks"),
        ],
        source="captions",
    )


def test_assign_speakers_dominant_overlap() -> None:
    turns = [
        SpeakerTurn(0.0, 4.5, "SPEAKER_00"),
        SpeakerTurn(4.5, 9.0, "SPEAKER_01"),
    ]
    labeled = assign_speakers(_transcript(), turns)
    assert labeled.segments[0].speaker == "SPEAKER_00"
    assert labeled.segments[1].speaker == "SPEAKER_01"
    assert labeled.segments[2].speaker is None  # no overlapping turn
    assert labeled.source == "captions"
    # original untouched (pure function)
    assert _transcript().segments[0].speaker is None


def test_assign_speakers_picks_larger_overlap() -> None:
    # segment 4..8 overlaps SPEAKER_00 for 1s and SPEAKER_01 for 3s
    turns = [
        SpeakerTurn(0.0, 5.0, "SPEAKER_00"),
        SpeakerTurn(5.0, 30.0, "SPEAKER_01"),
    ]
    labeled = assign_speakers(_transcript(), turns)
    assert labeled.segments[1].speaker == "SPEAKER_01"


def test_formatted_includes_speaker_labels() -> None:
    labeled = assign_speakers(_transcript(), [SpeakerTurn(0.0, 9.0, "SPEAKER_00")])
    text = labeled.formatted()
    assert "[00:00] SPEAKER_00: hello and welcome" in text
    assert "[00:20] closing remarks" in text  # unlabeled stays bare


def test_segment_to_dict_roundtrips_speaker() -> None:
    seg = Segment(1.0, 2.0, "hi", speaker="SPEAKER_03")
    assert seg.to_dict()["speaker"] == "SPEAKER_03"
    assert "speaker" not in Segment(1.0, 2.0, "hi").to_dict()


def test_diarize_audio_uses_pyannote4_token_kwarg(tmp_path, monkeypatch) -> None:
    """Regression (pyannote.audio 3.x → 4.x): Pipeline.from_pretrained renamed
    use_auth_token= to token=. Fake the module and assert the new kwarg."""
    import sys
    import types

    from agentvision.transcribe import diarize as mod

    seen: dict = {}

    class FakeTurn:
        start, end = 0.0, 2.0

    class FakeAnnotation:
        def itertracks(self, yield_label=False):
            return iter([(FakeTurn(), None, "SPEAKER_00")])

    class FakePipeline:
        @classmethod
        def from_pretrained(cls, model, **kwargs):
            seen.update(kwargs, model=model)
            return cls()

        def __call__(self, path):
            return FakeAnnotation()

    fake_audio = types.ModuleType("pyannote.audio")
    fake_audio.Pipeline = FakePipeline
    fake_pkg = types.ModuleType("pyannote")
    fake_pkg.audio = fake_audio
    monkeypatch.setitem(sys.modules, "pyannote", fake_pkg)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)

    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"fake")
    turns = mod.diarize_audio(audio, hf_token="hf_test")
    assert turns == [mod.SpeakerTurn(0.0, 2.0, "SPEAKER_00")]
    assert seen["token"] == "hf_test"
    assert "use_auth_token" not in seen


def test_diarize_transcript_degrades_without_backend(tmp_path) -> None:
    """No pyannote / no token on this machine -> transcript returned unchanged."""
    from agentvision.transcribe.diarize import diarize_transcript

    original = _transcript()
    video = tmp_path / "v.mp4"
    video.write_bytes(b"not a real video")
    result = diarize_transcript(original, video, tmp_path)
    assert [s.text for s in result.segments] == [s.text for s in original.segments]
    assert all(s.speaker is None for s in result.segments)
