"""The cue sidecar, held to being worth acting on without being read first.

A sidecar is discovered, not requested: the pipeline finds it beside a
recording and pins frames from it. That makes every one of these a real
scenario rather than a hypothetical -- the file sits in a directory a user can
write to, an earlier capture can have left one behind, and half-written JSON
is a shape `[]` and `null` actually take.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from watch_skill.identity import digest_file
from watch_skill.perceive.cues import (
    MAX_CUES,
    MAX_SIDECAR_BYTES,
    Cue,
    CueError,
    clear_sidecar,
    discover_cues,
    read_sidecar,
    sidecar_path_for,
    to_media_timeline,
    write_sidecar,
)


@pytest.fixture()
def recording(tmp_path: Path) -> Path:
    """A stand-in for a capture: the loader reads bytes, never pixels."""
    video = tmp_path / "recording dir" / "capture.webm"
    video.parent.mkdir(parents=True)
    video.write_bytes(b"not really a video, but it has a size and a digest")
    return video


def _sidecar(video: Path, payload: object) -> Path:
    path = sidecar_path_for(video)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _bound(video: Path, cues: list[object], **extra: object) -> dict[str, object]:
    return {
        "version": 1,
        "recording": {
            "name": video.name,
            "bytes": video.stat().st_size,
            "sha256": digest_file(video),
        },
        "cues": cues,
        **extra,
    }


class TestTheHappyPath:
    def test_a_written_sidecar_reads_back(self, recording: Path) -> None:
        write_sidecar(recording, [Cue(1.5, "fill #qty"), Cue(3.25, "click #apply")])
        assert read_sidecar(recording) == [1.5, 3.25]

    def test_the_sidecar_sits_beside_the_recording(self, recording: Path) -> None:
        written = write_sidecar(recording, [Cue(1.0)])
        assert written == recording.parent / "capture.cues.json"

    def test_no_sidecar_is_not_an_error(self, recording: Path) -> None:
        assert read_sidecar(recording) is None

    def test_an_empty_list_pins_nothing(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, []))
        assert read_sidecar(recording) is None

    def test_a_label_is_carried_and_the_seconds_still_read(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, [{"seconds": 2.0, "label": "fill #qty"}]))
        assert read_sidecar(recording) == [2.0]

    def test_a_hand_written_override_needs_no_binding(self, recording: Path) -> None:
        # Nothing claims this came from a capture, so there is no earlier
        # recording it could be describing instead.
        _sidecar(recording, {"cues": [1.0, 2.0]})
        assert read_sidecar(recording) == [1.0, 2.0]


class TestAStaleSidecarIsNeverApplied:
    """The scenario: capture twice into one directory, unscripted the second time.

    The video is overwritten because capture writes a fixed name. A sidecar
    that survived that would pin real moments from the wrong session, and
    nothing downstream could tell -- the times are in range and the frames
    come out fine, they are simply of something else.
    """

    def test_a_digest_that_does_not_match_is_refused(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, [1.0]))
        recording.write_bytes(b"a different recording, written over the first one")
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.stale"
        assert "delete" in (caught.value.fix or "")

    def test_a_size_that_does_not_match_is_refused(self, recording: Path) -> None:
        payload = _bound(recording, [1.0])
        payload["recording"]["bytes"] = 999_999  # type: ignore[index]
        _sidecar(recording, payload)
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.stale"

    def test_a_capture_sidecar_that_names_no_recording_is_refused(
        self, recording: Path
    ) -> None:
        _sidecar(recording, {"version": 1, "cues": [1.0]})
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.unbound"

    def test_clearing_removes_it_and_tolerates_absence(self, recording: Path) -> None:
        write_sidecar(recording, [Cue(1.0)])
        clear_sidecar(recording)
        assert not sidecar_path_for(recording).exists()
        clear_sidecar(recording)  # a second call is not an error


class TestNothingInTheFileIsTakenOnTrust:
    @pytest.mark.parametrize("payload", [[], None, 3, "cues", True])
    def test_a_root_that_is_not_an_object_is_refused(
        self, recording: Path, payload: object
    ) -> None:
        # `[]` and `null` are what a half-written file looks like, and `.get`
        # on either is an AttributeError nobody upstream is catching.
        _sidecar(recording, payload)
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.bad_schema"

    def test_cues_that_are_not_a_list_are_refused(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, {"first": 1.0}))  # type: ignore[arg-type]
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.bad_schema"

    def test_unparseable_json_is_refused(self, recording: Path) -> None:
        sidecar_path_for(recording).write_text("{not json", encoding="utf-8")
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.unreadable"

    @pytest.mark.parametrize(
        ("value", "why"),
        [
            (True, "a bool is an int, and True would pin a frame at one second"),
            (False, "the same, at zero"),
            (-1.0, "before the recording starts"),
            ("2.0", "a string is not a number"),
            (None, "a hole where a number should be"),
            ({"label": "fill"}, "an object with no seconds"),
        ],
    )
    def test_a_value_that_is_not_a_moment_is_refused(
        self, recording: Path, value: object, why: str
    ) -> None:
        _sidecar(recording, _bound(recording, [1.0, value]))
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.bad_timestamp", why

    @pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
    def test_non_finite_numbers_are_refused(self, recording: Path, literal: str) -> None:
        # `json.loads` accepts these by default, so they reach the filter as
        # floats and `isinstance(x, float)` says yes to all three.
        raw = json.dumps(_bound(recording, [1.0])).replace("[1.0]", f"[{literal}]")
        sidecar_path_for(recording).write_text(raw, encoding="utf-8")
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.bad_timestamp"

    def test_more_cues_than_there_is_budget_for_are_refused(
        self, recording: Path
    ) -> None:
        _sidecar(recording, _bound(recording, [float(i) for i in range(MAX_CUES + 1)]))
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.too_many"

    def test_a_file_too_large_to_be_a_cue_list_is_not_read(
        self, recording: Path
    ) -> None:
        sidecar_path_for(recording).write_text(
            " " * (MAX_SIDECAR_BYTES + 1), encoding="utf-8")
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.code == "cues.too_large"

    def test_every_refusal_says_what_to_do_about_it(self, recording: Path) -> None:
        _sidecar(recording, [])
        with pytest.raises(CueError) as caught:
            read_sidecar(recording)
        assert caught.value.fix, "a diagnostic with no action is not actionable"
        assert str(caught.value).startswith(f"[{caught.value.code}]")


class TestBoundsAgainstTheRecording:
    def test_a_cue_past_the_end_is_refused(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, [1.0, 40.0]))
        with pytest.raises(CueError) as caught:
            read_sidecar(recording, duration_seconds=10.0)
        assert caught.value.code == "cues.out_of_bounds"

    def test_the_last_moment_of_a_session_is_trimmed_not_refused(
        self, recording: Path
    ) -> None:
        # A duration read from a container and a moment read from a clock do
        # not agree to the millisecond, and the last cue lands at the end.
        _sidecar(recording, _bound(recording, [9.98, 10.2]))
        assert read_sidecar(recording, duration_seconds=10.0) == [9.98, 10.0]

    def test_without_a_duration_nothing_is_bounded(self, recording: Path) -> None:
        _sidecar(recording, _bound(recording, [40.0]))
        assert read_sidecar(recording) == [40.0]


class TestDiscoveryDegradesLoudly:
    def test_a_broken_sidecar_does_not_fail_the_watch(
        self, recording: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        _sidecar(recording, {"version": 1, "cues": [1.0]})  # unbound
        assert discover_cues(recording) is None
        said = capsys.readouterr().err
        assert "cues.unbound" in said
        assert "ignoring interaction cues" in said

    def test_a_good_sidecar_is_returned(self, recording: Path) -> None:
        write_sidecar(recording, [Cue(2.0)])
        assert discover_cues(recording) == [2.0]


class TestTheMediaTimeline:
    """The recording and the wall clock share an origin, not a length."""

    def test_a_recording_shorter_than_the_session_shifts_everything_earlier(
        self,
    ) -> None:
        # 0.4 s of the session never made it into the file, and it is the 0.4 s
        # at the front -- the screencast starts once the browser is ready to
        # emit frames.
        assert to_media_timeline(
            [1.0, 3.0, 5.0], wall_span=6.0, media_duration=5.6
        ) == [0.6, 2.6, 4.6]

    def test_a_moment_before_the_recording_starts_is_clamped_not_dropped(self) -> None:
        assert to_media_timeline([0.1], wall_span=6.0, media_duration=5.0) == [0.0]

    def test_nothing_is_pushed_past_the_end(self) -> None:
        assert to_media_timeline([6.0], wall_span=6.0, media_duration=5.0) == [5.0]

    def test_an_unmeasurable_recording_leaves_the_moments_alone(self) -> None:
        assert to_media_timeline([1.0, 2.0], wall_span=3.0, media_duration=0.0) == [
            1.0, 2.0]

    def test_the_offset_is_never_negative(self) -> None:
        # A container that rounds its duration up must not push cues later.
        assert to_media_timeline([1.0], wall_span=5.0, media_duration=5.2) == [1.0]


class TestRoundTripping:
    def test_a_written_sidecar_survives_its_own_validator(
        self, recording: Path
    ) -> None:
        write_sidecar(
            recording,
            [Cue(0.5, "fill #qty"), Cue(2.25, "click #apply")],
            timeline={"wall_span": 4.0, "media_duration": 3.6},
        )
        payload = json.loads(sidecar_path_for(recording).read_text(encoding="utf-8"))
        assert payload["timeline"] == {"wall_span": 4.0, "media_duration": 3.6}
        assert payload["recording"]["sha256"] == digest_file(recording)
        assert read_sidecar(recording, duration_seconds=3.6) == [0.5, 2.25]

    def test_the_writer_never_emits_a_value_the_reader_would_refuse(
        self, recording: Path
    ) -> None:
        # The mapping is the last thing between a clock that produced
        # something strange and a file the reader then has to refuse. It is
        # also length-preserving, because the caller pairs it with labels.
        mapped = to_media_timeline(
            [math.inf, math.nan, -5.0, 2.0], wall_span=6.0, media_duration=5.0)
        assert len(mapped) == 4
        assert all(math.isfinite(value) and value >= 0 for value in mapped)
        write_sidecar(recording, [Cue(value) for value in mapped])
        assert read_sidecar(recording, duration_seconds=5.0) == mapped
