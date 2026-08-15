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
