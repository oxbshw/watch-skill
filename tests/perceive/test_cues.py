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
    measure_offset,
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
    """The two clocks run at the same rate and start at different moments."""

    def test_a_measured_offset_moves_every_moment_by_the_same_amount(self) -> None:
        # A screencast that started 0.28 s after the page did puts every later
        # moment 0.28 s earlier in the file than the session clock says.
        assert to_media_timeline(
            [1.0, 3.0, 5.0], offset=-0.28, media_duration=5.6
        ) == [0.72, 2.72, 4.72]

    def test_a_moment_before_the_recording_starts_is_clamped_not_dropped(self) -> None:
        assert to_media_timeline([0.1], offset=-1.0, media_duration=5.0) == [0.0]

    def test_nothing_is_pushed_past_the_end(self) -> None:
        assert to_media_timeline([6.0], offset=0.5, media_duration=5.0) == [5.0]

    def test_an_unmeasurable_recording_leaves_the_moments_alone(self) -> None:
        assert to_media_timeline(
            [1.0, 2.0], offset=-0.5, media_duration=0.0) == [1.0, 2.0]

    def test_no_measurement_means_no_correction(self) -> None:
        # Nothing to align against is not a licence to invent an alignment.
        assert to_media_timeline(
            [1.0, 2.0], offset=0.0, media_duration=5.0) == [1.0, 2.0]


class TestMeasuringTheOffset:
    """The alignment is measured against the recording, never inferred."""

    def _recording(self, tmp_path: Path, change_at: float, seconds: float) -> Path:
        """A clip that is one colour and then abruptly another."""
        import shutil
        import subprocess

        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            pytest.skip("ffmpeg not available")
        out = tmp_path / "aligned" / "capture.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s=320x240:r=25:d={change_at}",
            "-f", "lavfi", "-i",
            f"color=c=white:s=320x240:r=25:d={seconds - change_at}",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out),
        ], capture_output=True, text=True)
        if result.returncode != 0:
            pytest.skip(f"ffmpeg could not build the fixture: {result.stderr[-200:]}")
        return out

    def test_it_finds_how_far_the_recording_lags_the_session_clock(
        self, tmp_path: Path
    ) -> None:
        # The change is at 1.0 s in the file. A session that saw it at 1.30 s
        # was running 0.30 s ahead of the recording.
        video = self._recording(tmp_path, change_at=1.0, seconds=3.0)
        offset = measure_offset(video, changed_at=1.30, media_duration=3.0)
        assert offset is not None
        assert offset == pytest.approx(-0.30, abs=0.12)

    def test_it_finds_a_session_clock_that_lags_the_recording(
        self, tmp_path: Path
    ) -> None:
        video = self._recording(tmp_path, change_at=1.5, seconds=3.0)
        offset = measure_offset(video, changed_at=1.2, media_duration=3.0)
        assert offset is not None
        assert offset == pytest.approx(0.30, abs=0.12)

    def test_a_recording_that_never_changes_aligns_to_nothing(
        self, tmp_path: Path
    ) -> None:
        video = self._recording(tmp_path, change_at=3.0, seconds=3.0)
        assert measure_offset(video, changed_at=1.0, media_duration=3.0) is None

    def test_an_absurd_result_is_refused_rather_than_applied(
        self, tmp_path: Path
    ) -> None:
        # Half a minute apart is not a measurement of the same event.
        video = self._recording(tmp_path, change_at=1.0, seconds=3.0)
        assert measure_offset(video, changed_at=30.0, media_duration=3.0) is None

    def test_the_search_gives_up_rather_than_reading_a_whole_film(
        self, tmp_path: Path
    ) -> None:
        video = self._recording(tmp_path, change_at=1.0, seconds=3.0)
        assert measure_offset(
            video, changed_at=1.0, media_duration=3.0, search_seconds=0.3) is None


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
            [math.inf, math.nan, -5.0, 2.0], offset=-0.3, media_duration=5.0)
        assert len(mapped) == 4
        assert all(math.isfinite(value) and value >= 0 for value in mapped)
        write_sidecar(recording, [Cue(value) for value in mapped])
        assert read_sidecar(recording, duration_seconds=5.0) == mapped
