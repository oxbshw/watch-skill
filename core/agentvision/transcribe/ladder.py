"""The transcription ladder: captions -> local whisper -> cloud (opt-in).

Each rung's failure is reported to stderr and the next rung tried; the final
Transcript records which rung produced it (``source``). Returns an empty
Transcript (source="none") rather than raising when every rung fails —
frames-only analysis is still useful, and the report names the gap.
"""
from __future__ import annotations

import sys
from pathlib import Path

from agentvision.config import get_settings
from agentvision.errors import TranscriptionError
from agentvision.transcribe import audio as audio_mod
from agentvision.transcribe import cloud, local, vtt
from agentvision.transcribe.types import Transcript


def get_transcript(
    video_path: Path | None,
    work_dir: Path,
    subtitle_path: Path | None = None,
    has_audio: bool = True,
    allow_local: bool | None = None,
    allow_cloud: bool | None = None,
    whisper_model: str | None = None,
    preferred_cloud_backend: str | None = None,
) -> Transcript:
    """Run the ladder. Any rung may be force-disabled; defaults come from settings."""
    settings = get_settings()
    use_local = settings.local_whisper_enabled if allow_local is None else allow_local
    use_cloud = settings.cloud_stt_enabled if allow_cloud is None else allow_cloud
    model = whisper_model or settings.whisper_model

    if subtitle_path is not None and Path(subtitle_path).is_file():
        try:
            transcript = vtt.parse_vtt(Path(subtitle_path))
            if transcript:
                return transcript
        except OSError as exc:
            print(f"[agentvision] caption parse failed: {exc}", file=sys.stderr)

    if video_path is None or not has_audio:
        if video_path is not None:
            print("[agentvision] no audio stream — skipping transcription", file=sys.stderr)
        return Transcript(source="none")

    if use_local:
        try:
            audio_path = audio_mod.extract_audio(video_path, work_dir / "audio.mp3")
            return local.transcribe_local(audio_path, model_size=model)
        except TranscriptionError as exc:
            print(f"[agentvision] local whisper unavailable ({exc.code})", file=sys.stderr)

    if use_cloud:
        try:
            return cloud.transcribe_cloud(
                video_path, work_dir, preferred_backend=preferred_cloud_backend
            )
        except TranscriptionError as exc:
            print(f"[agentvision] cloud STT failed ({exc.code})", file=sys.stderr)

    return Transcript(source="none")
