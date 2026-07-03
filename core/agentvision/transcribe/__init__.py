"""Transcription ladder: platform captions -> local faster-whisper -> cloud (opt-in).

Implemented in Milestone 1. Cloud STT sends ONLY extracted mono-16kHz audio,
and only when the user explicitly enabled it — the video never leaves the
machine (privacy invariant, tested).
"""
