"""The yt-dlp format selector: always audio, never above the cap.

Ported from oxbshw/watch-skill#15 by @felores, which correctly spotted that
the old selector's tail (`/bv+ba/b`) had no height predicate and could pick 4K
exactly when the preferred rung failed. Two corrections to that patch:

* it raised the default to 1080p; 720p stays the default and 1080 is the hard
  ceiling a user may opt up to;
* its fallback rung was `bv*[height<=N]` — video-only — which yields a file
  with no audio track and surfaces much later as an empty transcript.
"""
from __future__ import annotations

import re

import pytest

from watch_skill.acquire.ytdlp import MAX_VIDEO_HEIGHT, _video_format


# Each `/`-separated rung must be independently acceptable: yt-dlp falls
# through them in order, and a rung is only reached when the ones before it
# failed — which is exactly when a silent downgrade would go unnoticed.
def _rungs(selector: str) -> list[str]:
    return [rung for rung in selector.split("/") if rung]


def _use_settings(monkeypatch: pytest.MonkeyPatch, settings) -> None:
    """Swap the settings accessor, keeping the interface the fixtures use.

    `reset_settings()` calls `get_settings.cache_clear()` in teardown, so a
    bare lambda breaks every test that runs afterwards.
    """
    stub = lambda: settings  # noqa: E731 - deliberately a drop-in accessor
    stub.cache_clear = lambda: None
    monkeypatch.setattr("watch_skill.config.get_settings", stub)


def test_the_default_cap_is_720p() -> None:
    assert "height<=720" in _video_format()


def test_every_rung_that_takes_video_caps_its_height() -> None:
    """The tail used to be `bv+ba/b` — no cap at all, reached on failure."""
    for rung in _rungs(_video_format()):
        if rung.startswith("bv"):
            assert "height<=" in rung, f"uncapped video rung: {rung}"


def test_no_rung_is_video_only() -> None:
    """A video-only rung produces a file with no audio track.

    The failure does not surface at download time; it surfaces later as a
    transcript that is mysteriously empty.
    """
    for rung in _rungs(_video_format()):
        if rung.startswith("bv"):
            assert "+ba" in rung, f"video-only rung would drop audio: {rung}"


def test_the_last_resort_still_carries_audio() -> None:
    """`b` is a *combined* stream, so the final rung is not audio-less."""
    last = _rungs(_video_format())[-1]
    assert last.startswith("b") and not last.startswith("bv")


@pytest.mark.parametrize("height", [144, 360, 480, 720, 1080])
def test_a_configured_height_is_honoured(
    height: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    from watch_skill.config import Settings

    _use_settings(monkeypatch, Settings(max_video_height=height))
    selector = _video_format()
    assert f"height<={height}" in selector
    for value in re.findall(r"height<=(\d+)", selector):
        assert int(value) == height


def test_a_request_above_the_ceiling_is_clamped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """4K costs minutes of transfer to answer a question 720p answers."""
    class Loose:
        max_video_height = 4320  # someone bypassing validation

    _use_settings(monkeypatch, Loose())
    for value in re.findall(r"height<=(\d+)", _video_format()):
        assert int(value) <= MAX_VIDEO_HEIGHT


def test_an_absurdly_small_request_is_floored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Loose:
        max_video_height = 1

    _use_settings(monkeypatch, Loose())
    for value in re.findall(r"height<=(\d+)", _video_format()):
        assert int(value) >= 144


def test_the_setting_rejects_out_of_range_values() -> None:
    from pydantic import ValidationError

    from watch_skill.config import Settings

    with pytest.raises(ValidationError):
        Settings(max_video_height=2160)
    with pytest.raises(ValidationError):
        Settings(max_video_height=0)


def test_audio_only_downloads_are_untouched() -> None:
    """The audio path has its own selector and must not gain a height filter."""
    from watch_skill.acquire import ytdlp

    source = ytdlp._download_once.__doc__ or ""
    assert "height" not in source


# --- legitimately silent sources ----------------------------------------------


def test_the_audio_required_selector_never_ends_video_only() -> None:
    """The default path must not be able to produce a silent file."""
    assert _rungs(_video_format())[-1] == "b"
    assert not any(rung.startswith("bv") and "+ba" not in rung
                   for rung in _rungs(_video_format()))


def test_a_known_silent_source_may_be_downloaded_video_only() -> None:
    """A screen recording made without sound is not a broken download.

    Refusing it would be its own bug — but the video-only rung is last, so it
    is reached only after every audio-bearing option has failed.
    """
    rungs = _rungs(_video_format(allow_video_only=True))
    assert rungs[-1].startswith("bv*")
    assert "+ba" not in rungs[-1]
    assert rungs[:-1] == _rungs(_video_format()), (
        "enabling the silent path must not weaken the audio-bearing rungs"
    )


def test_the_video_only_rung_still_carries_the_height_cap() -> None:
    for value in re.findall(r"height<=(\d+)", _video_format(allow_video_only=True)):
        assert int(value) <= MAX_VIDEO_HEIGHT


@pytest.mark.parametrize(("formats", "expected"), [
    # Combined media: one format carrying both.
    ([{"acodec": "aac", "vcodec": "h264"}], True),
    # Split streams: separate video-only and audio-only formats.
    ([{"acodec": "none", "vcodec": "h264"}, {"acodec": "opus", "vcodec": "none"}], True),
    # Genuinely silent: every format says so.
    ([{"acodec": "none", "vcodec": "h264"}, {"acodec": "none", "vcodec": "vp9"}], False),
    # Older payloads describe audio by bitrate/sample rate instead.
    ([{"vcodec": "h264", "abr": 128}], True),
    ([{"vcodec": "h264", "asr": 44100}], True),
])
def test_audio_presence_is_read_from_the_real_format_list(
    formats: list[dict], expected: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json as _json

    from watch_skill.acquire import ytdlp

    class Result:
        stdout = _json.dumps({"formats": formats})
        stderr = ""
        returncode = 0

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", lambda *a, **k: Result())
    assert ytdlp.probe_has_audio("https://example.com/v") is expected


@pytest.mark.parametrize("payload", ["", "not json", "{}", '{"formats": []}'])
def test_an_unanswerable_probe_is_unknown_not_silent(
    payload: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unknown is not the same as no.

    Treating an unanswerable probe as "no audio" would quietly authorise a
    video-only download for a source that had audio all along.
    """
    from watch_skill.acquire import ytdlp

    class Result:
        stdout = payload
        stderr = ""
        returncode = 0

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", lambda *a, **k: Result())
    assert ytdlp.probe_has_audio("https://example.com/v") is None


def test_a_failing_probe_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    from watch_skill.acquire import ytdlp

    def explode(*_a, **_k):
        raise OSError("yt-dlp is gone")

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", explode)
    assert ytdlp.probe_has_audio("https://example.com/v") is None


def test_the_probe_is_only_consulted_after_an_audio_download_fails(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful normal download must never pay for a second round trip."""
    from watch_skill.acquire import ytdlp

    probes: list[str] = []
    monkeypatch.setattr(ytdlp, "probe_has_audio",
                        lambda url: probes.append(url) or True)

    class Result:
        stdout = ""
        stderr = ""
        returncode = 0

    def fake_run(args, url, **_k):
        (tmp_path / "media.mp4").write_bytes(b"video")
        return Result()

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", fake_run)
    payload = ytdlp._download_once("https://example.com/v", tmp_path, audio_only=False)
    assert probes == [], "the probe ran even though the download succeeded"
    assert payload["audio_status"] == "audio_expected"


def test_a_silent_source_reports_audio_unavailable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The status is the point: it distinguishes silence from a lost track."""
    from watch_skill.acquire import ytdlp

    monkeypatch.setattr(ytdlp, "probe_has_audio", lambda url: False)
    selectors: list[str] = []

    class Result:
        stdout = ""
        stderr = ""
        returncode = 0

    def fake_run(args, url, **_k):
        selector = args[args.index("-f") + 1]
        selectors.append(selector)
        if "+ba" not in selector.split("/")[0] or len(selectors) > 1:
            (tmp_path / "media.mp4").write_bytes(b"video")
        return Result()

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", fake_run)
    payload = ytdlp._download_once("https://example.com/v", tmp_path, audio_only=False)
    assert payload["audio_status"] == "audio_unavailable"
    assert len(selectors) == 2, "the video-only retry did not happen"
    assert selectors[1].split("/")[-1].startswith("bv*")


def test_an_unknown_probe_does_not_authorise_a_video_only_retry(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from watch_skill.acquire import ytdlp

    monkeypatch.setattr(ytdlp, "probe_has_audio", lambda url: None)
    selectors: list[str] = []

    class Result:
        stdout = ""
        stderr = ""
        returncode = 1

    def fake_run(args, url, **_k):
        selectors.append(args[args.index("-f") + 1])
        return Result()

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", fake_run)
    with pytest.raises(Exception) as raised:
        ytdlp._download_once("https://example.com/v", tmp_path, audio_only=False)
    assert len(selectors) == 1, "a video-only retry ran on an unknown probe"
    assert raised.value.details["audio_status"] == "audio_unknown"


def test_audio_only_downloads_never_gain_a_video_only_rung(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from watch_skill.acquire import ytdlp

    selectors: list[str] = []

    class Result:
        stdout = ""
        stderr = ""
        returncode = 0

    def fake_run(args, url, **_k):
        selectors.append(args[args.index("-f") + 1])
        (tmp_path / "media.m4a").write_bytes(b"audio")
        return Result()

    monkeypatch.setattr(ytdlp, "_run_yt_dlp", fake_run)
    ytdlp._download_once("https://example.com/v", tmp_path, audio_only=True)
    assert selectors == ["ba/bestaudio"]
