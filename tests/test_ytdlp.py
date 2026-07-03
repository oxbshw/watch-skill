"""yt-dlp wrapper: breakage fingerprints, subtitle/video picking, self-heal flow."""
from __future__ import annotations

from pathlib import Path

import pytest

from agentvision.acquire import ytdlp
from agentvision.errors import AcquisitionError


@pytest.mark.parametrize(
    "stderr",
    [
        "ERROR: [youtube] abc: Unable to extract player version",
        "ERROR: Signature extraction failed: some detail",
        "yt-dlp: nsig extraction failed: you may experience throttling",
        "ERROR: Unsupported URL: https://newsite.example",
        "Sign in to confirm you're not a bot",
    ],
)
def test_breakage_patterns_match(stderr: str) -> None:
    assert ytdlp.is_breakage(stderr)


@pytest.mark.parametrize(
    "stderr",
    [
        "ERROR: HTTP Error 404: Not Found",
        "ERROR: This video is private",
        "network is unreachable",
        "",
    ],
)
def test_non_breakage_patterns_do_not_match(stderr: str) -> None:
    assert not ytdlp.is_breakage(stderr)


def test_pick_subtitle_prefers_non_orig(tmp_path: Path) -> None:
    (tmp_path / "media.en-orig.vtt").write_text("x", encoding="utf-8")
    (tmp_path / "media.en.vtt").write_text("x", encoding="utf-8")
    picked = ytdlp._pick_subtitle(tmp_path)
    assert picked is not None and picked.name == "media.en.vtt"


def test_pick_subtitle_none_when_absent(tmp_path: Path) -> None:
    assert ytdlp._pick_subtitle(tmp_path) is None


def test_pick_video_prefers_mp4(tmp_path: Path) -> None:
    (tmp_path / "media.webm").write_bytes(b"x")
    (tmp_path / "media.mp4").write_bytes(b"x")
    picked = ytdlp._pick_video(tmp_path)
    assert picked is not None and picked.suffix == ".mp4"


def test_download_self_heals_on_breakage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """First attempt fails with a breakage fingerprint -> update -> retry succeeds."""
    calls = {"downloads": 0, "updates": 0}

    def fake_download_once(url: str, out_dir: Path, audio_only: bool) -> dict:
        calls["downloads"] += 1
        if calls["downloads"] == 1:
            raise AcquisitionError(
                "no media",
                code="acquire.ytdlp_failed",
                details={"stderr_tail": "ERROR: Unable to extract player response"},
            )
        return {"video_path": tmp_path / "media.mp4", "subtitle_path": None, "info": {}}

    def fake_update(path: Path) -> bool:
        calls["updates"] += 1
        return True

    monkeypatch.setattr(ytdlp, "_download_once", fake_download_once)
    monkeypatch.setattr(ytdlp, "update_yt_dlp", fake_update)
    monkeypatch.setattr(ytdlp, "require_binary", lambda name: tmp_path / "yt-dlp.exe")

    result = ytdlp.download("https://example.com/v", tmp_path)
    assert calls == {"downloads": 2, "updates": 1}
    assert result["video_path"] == tmp_path / "media.mp4"


def test_download_does_not_update_on_plain_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_download_once(url: str, out_dir: Path, audio_only: bool) -> dict:
        raise AcquisitionError(
            "no media",
            code="acquire.ytdlp_failed",
            details={"stderr_tail": "ERROR: This video is private"},
        )

    updates = []
    monkeypatch.setattr(ytdlp, "_download_once", fake_download_once)
    monkeypatch.setattr(ytdlp, "update_yt_dlp", lambda p: updates.append(1) or True)

    with pytest.raises(AcquisitionError):
        ytdlp.download("https://example.com/v", tmp_path)
    assert updates == []
