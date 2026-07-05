"""Speaker diarization: who spoke when, merged onto the transcript.

Optional and flag-gated (``WATCHSKILL_DIARIZATION_ENABLED`` or
``--diarize``). The heavy backend (pyannote.audio, torch) is an optional
extra — ``pip install watch-skill[diarize]`` — and needs a Hugging Face token
for the gated pyannote models. Everything downstream works on the pure
:class:`SpeakerTurn` contract, so tests and alternative backends never need
torch installed.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.errors import DependencyError, TranscriptionError
from watch_skill.transcribe.types import Segment, Transcript

_PIPELINE_MODEL = "pyannote/speaker-diarization-community-1"


@dataclass
class SpeakerTurn:
    """One contiguous span attributed to one speaker."""

    start: float
    end: float
    speaker: str  # e.g. "SPEAKER_00"


def diarize_audio(audio_path: Path, hf_token: str | None = None) -> list[SpeakerTurn]:
    """Run pyannote speaker diarization over an audio file.

    Requires the ``diarize`` extra and a Hugging Face token accepted for the
    pyannote model. Raises a structured error otherwise so agents can act.
    """
    token = hf_token or _configured_token()
    try:
        from pyannote.audio import Pipeline  # noqa: PLC0415
    except ImportError as exc:
        raise TranscriptionError(
            "pyannote.audio is not installed",
            code="transcribe.diarization_unavailable",
            fix="pip install 'watch-skill[diarize]' (needs torch; ~2 GB)",
        ) from exc
    if not token:
        raise TranscriptionError(
            "diarization needs a Hugging Face token",
            code="transcribe.diarization_no_token",
            fix="set WATCHSKILL_HUGGINGFACE_TOKEN (accept the pyannote model terms on hf.co first)",
        )
    try:
        # pyannote.audio 4.x renamed use_auth_token= to token=
        pipeline = Pipeline.from_pretrained(_PIPELINE_MODEL, token=token)
        annotation = pipeline(str(audio_path))
    except Exception as exc:
        raise TranscriptionError(
            f"diarization failed: {exc}",
            code="transcribe.diarization_failed",
            fix="check the HF token has accepted the pyannote model terms",
            details={"model": _PIPELINE_MODEL, "audio": str(audio_path)},
        ) from exc
    return [
        SpeakerTurn(start=turn.start, end=turn.end, speaker=str(label))
        for turn, _, label in annotation.itertracks(yield_label=True)
    ]


def _configured_token() -> str | None:
    token = get_settings().huggingface_token
    return token.get_secret_value().strip() if token else None


def _overlap(seg: Segment, turn: SpeakerTurn) -> float:
    return max(0.0, min(seg.end, turn.end) - max(seg.start, turn.start))


def assign_speakers(transcript: Transcript, turns: list[SpeakerTurn]) -> Transcript:
    """Label each transcript segment with its dominant-overlap speaker.

    Pure function over the SpeakerTurn contract — usable with any diarization
    backend. Segments with no overlapping turn keep ``speaker=None``.
    """
    labeled: list[Segment] = []
    for seg in transcript.segments:
        best: tuple[float, str | None] = (0.0, None)
        for turn in turns:
            overlap = _overlap(seg, turn)
            if overlap > best[0]:
                best = (overlap, turn.speaker)
        labeled.append(Segment(start=seg.start, end=seg.end, text=seg.text, speaker=best[1]))
    return Transcript(segments=labeled, source=transcript.source)


def diarize_transcript(
    transcript: Transcript, video_path: Path, work_dir: Path
) -> Transcript:
    """Extract audio, diarize, and merge speakers onto ``transcript``.

    Degrades loudly (stderr) but never fatally: on any diarization failure the
    original transcript is returned unchanged — speech content beats labels.
    """
    if not transcript:
        return transcript
    try:
        from watch_skill.transcribe.audio import extract_audio  # noqa: PLC0415

        audio_path = work_dir / "audio.mp3"
        if not audio_path.is_file():
            audio_path = extract_audio(video_path, audio_path)
        turns = diarize_audio(audio_path)
    except (TranscriptionError, DependencyError) as exc:
        print(f"[watch-skill] diarization skipped ({exc.code}): {exc.message}", file=sys.stderr)
        return transcript
    return assign_speakers(transcript, turns)
