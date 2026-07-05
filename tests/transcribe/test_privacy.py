"""Privacy invariants as executable rules.

1. The video file NEVER leaves the machine.
2. Cloud STT is opt-in; disabled by default; refuses before any network I/O.
3. yt-dlp is never invoked with cookies/login flags, and URLs are always
   preceded by `--` (argv-injection guard).
"""
from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from watch_skill.errors import TranscriptionError
from watch_skill.transcribe import cloud


def test_cloud_stt_refuses_when_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Disabled cloud STT must fail BEFORE touching the network or ffmpeg."""

    def _explode(*args, **kwargs):
        raise AssertionError("network I/O attempted while cloud STT is disabled")

    monkeypatch.setattr(cloud.httpx, "post", _explode)
    monkeypatch.setattr(cloud.audio_mod, "extract_audio", _explode)

    with pytest.raises(TranscriptionError) as excinfo:
        cloud.transcribe_cloud(tmp_path / "video.mp4", tmp_path)
    assert excinfo.value.code == "transcribe.cloud_disabled"


def test_cloud_stt_uploads_audio_only_by_construction() -> None:
    """The upload call opens the extracted audio path — the video path is
    only ever passed to ffmpeg for audio extraction. Guard the contract by
    asserting the uploader's signature takes an audio file, not a video."""
    signature = inspect.signature(cloud._post_once)
    assert "audio_path" in signature.parameters
    source = inspect.getsource(cloud.transcribe_cloud)
    # the only open/upload target is the audio artifact
    assert "audio_mod.extract_audio" in source
    assert "video_path.open" not in source


def test_ytdlp_never_uses_cookies_or_login() -> None:
    from watch_skill.acquire import ytdlp

    source = inspect.getsource(ytdlp)
    for forbidden in ("--cookies", "--username", "--password", "cookies-from-browser"):
        assert forbidden not in source, f"privacy violation: {forbidden} in ytdlp.py"


def test_ytdlp_guards_argv_injection() -> None:
    from watch_skill.acquire import ytdlp

    source = inspect.getsource(ytdlp._run_yt_dlp)
    assert '"--", url' in source or "'--', url" in source


def test_cloud_disabled_by_default() -> None:
    from watch_skill.config import get_settings

    assert get_settings().cloud_stt_enabled is False
