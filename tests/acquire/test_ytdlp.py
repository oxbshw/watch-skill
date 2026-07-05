"""yt-dlp wrapper: breakage fingerprints, subtitle/video picking, self-heal flow."""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.acquire import ytdlp
from watch_skill.errors import AcquisitionError


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


def test_pick_subtitle_prefers_original_language(tmp_path) -> None:
    """Regression: an Arabic video must yield Arabic subs, not the English
    auto-translation the default sub-langs pattern happens to match."""
    from watch_skill.acquire.ytdlp import _pick_subtitle

    out = tmp_path / "subs dir"
    out.mkdir()
    for name in ("media.en.vtt", "media.ar.vtt", "media.en-orig.vtt"):
        (out / name).write_text("WEBVTT\n", encoding="utf-8")
    picked = _pick_subtitle(out, original_lang="ar")
    assert picked is not None and picked.name == "media.ar.vtt"
    # without language info: plain variants still beat -orig ones
    assert "-orig" not in _pick_subtitle(out).name


def test_ensure_original_subs_skips_when_present(tmp_path, monkeypatch) -> None:
    """No second yt-dlp call when the original-language track already landed."""
    from watch_skill.acquire import ytdlp as mod

    out = tmp_path / "subs dir"
    out.mkdir()
    (out / "media.ar.vtt").write_text("WEBVTT\n", encoding="utf-8")
    calls: list = []
    monkeypatch.setattr(mod, "_run_yt_dlp", lambda *a, **k: calls.append(a))
    mod._ensure_original_subs(out, "https://x", {"language": "ar"})
    assert calls == []
    # missing track -> one targeted call with that language pattern
    mod._ensure_original_subs(out, "https://x", {"language": "fr"})
    assert len(calls) == 1 and "fr.*" in calls[0][0]
