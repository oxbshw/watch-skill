"""Transcription ladder: captions -> local faster-whisper -> cloud (opt-in).

Privacy invariant: only extracted mono-16kHz audio may reach a cloud API,
and only when the user explicitly enabled cloud STT. The video never leaves
the machine.
"""

from watch_skill.transcribe.ladder import get_transcript
from watch_skill.transcribe.types import Segment, Transcript
from watch_skill.transcribe.vtt import parse_vtt

__all__ = ["Segment", "Transcript", "get_transcript", "parse_vtt"]
