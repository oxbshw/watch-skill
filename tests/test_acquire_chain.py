"""Fallback-chain behavior: cobalt participates only when configured.

The public api.cobalt.tools requires JWT auth (verified live 2026-07-05), so
an unconfigured cobalt hop is a guaranteed-failure network round-trip the
chain must skip.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from watch_skill.acquire import cobalt, resolver
from watch_skill.acquire.sources import SourceKind
from watch_skill.errors import AcquisitionError


def test_cobalt_unconfigured_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WATCHSKILL_COBALT_API_URL", raising=False)
    assert cobalt.is_configured() is False
    with pytest.raises(AcquisitionError) as exc_info:
        cobalt._request_media_url("https://example.com/watch?v=x")
    assert exc_info.value.code == "acquire.cobalt_not_configured"


def test_cobalt_configured_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_COBALT_API_URL", "http://localhost:9000/")
    assert cobalt.is_configured() is True


def test_chain_skips_cobalt_when_unconfigured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: yt-dlp failure must fall through directly to ffmpeg (no
    doomed cobalt call) unless the user set a self-hosted instance."""
    monkeypatch.delenv("WATCHSKILL_COBALT_API_URL", raising=False)
    calls: list[str] = []

    def fail_ytdlp(source, out_dir, audio_only=False):
        calls.append("yt-dlp")
        raise AcquisitionError("boom", code="acquire.ytdlp_failed")

    def spy_cobalt(source, dest):
        calls.append("cobalt")
        raise AcquisitionError("unreachable", code="acquire.cobalt_unreachable")

    def fail_direct(source, dest, duration_seconds=None):
        calls.append("ffmpeg")
        raise AcquisitionError("nope", code="acquire.direct_failed")

    monkeypatch.setattr(resolver.ytdlp, "download", fail_ytdlp)
    monkeypatch.setattr(resolver.cobalt, "download", spy_cobalt)
    monkeypatch.setattr(resolver.direct, "ffmpeg_pull", fail_direct)

    with pytest.raises(AcquisitionError) as exc_info:
        resolver._try_chain(
            "https://example.com/watch?v=x", SourceKind.PAGE_URL,
            tmp_path / "chain out", audio_only=False, duration_cap=None,
        )
    assert exc_info.value.code == "acquire.chain_exhausted"
    assert calls == ["yt-dlp", "ffmpeg"]  # cobalt skipped

    calls.clear()
    monkeypatch.setenv("WATCHSKILL_COBALT_API_URL", "http://localhost:9000/")
    with pytest.raises(AcquisitionError):
        resolver._try_chain(
            "https://example.com/watch?v=x", SourceKind.PAGE_URL,
            tmp_path / "chain out 2", audio_only=False, duration_cap=None,
        )
    assert calls == ["yt-dlp", "cobalt", "ffmpeg"]  # cobalt participates
