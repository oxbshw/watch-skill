"""`watch.source.moment`, which had never once returned an answer.

Two defects, stacked, and the first hid the second. The Host forwarded its own
parameter name -- `atMs` for a method that reads `timestampMs` -- so every call
was refused for its shape. Behind that refusal the handler serialised its
result with ``context.to_dict() if hasattr(...) else dict(context)``, and
``MomentContext`` is a dataclass with no ``to_dict``: the fallback ran, a
dataclass is not iterable, and the call raised ``TypeError``.

Nothing caught either one, because nothing here asked this method for an
answer. A test that accepts `bridge.invalid_params` proves the method exists;
the two tests below require the moment.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.surfaces.bridge.methods import source_moment  # noqa: E402
from watch_skill.surfaces.bridge.protocol import BridgeError  # noqa: E402


@pytest.fixture()
def indexed(sample_video: Path) -> str:
    """A real source in the index, so a moment has something to be about."""
    from watch_skill.index import index_watch_result
    from watch_skill.watch import watch

    result = watch(str(sample_video), use_cache=False, run_ocr=False, max_frames=6)
    return index_watch_result(result, describe_scenes=False)


class TestAMomentComesBack:
    def test_the_call_returns_a_payload_rather_than_raising(self, indexed: str) -> None:
        payload = source_moment({"sourceId": indexed, "timestampMs": 4000})
        assert isinstance(payload, dict), (
            "a dataclass reached `dict()` and raised; the result must be serialised"
        )

    def test_the_payload_is_the_moment_that_was_asked_for(self, indexed: str) -> None:
        payload = source_moment(
            {"sourceId": indexed, "timestampMs": 4000, "windowMs": 5000})
        assert payload["video_id"] == indexed
        assert payload["timestamp"] == pytest.approx(4.0)
        assert payload["window"] == pytest.approx(5.0)

    def test_it_carries_what_was_observed_around_that_moment(
        self, indexed: str
    ) -> None:
        # The point of the method: frames, transcript and on-screen text that
        # overlap one instant. An empty answer to a moment inside an indexed
        # video is the failure this exists to catch.
        payload = source_moment({"sourceId": indexed, "timestampMs": 4000})
        for key in ("frames", "segments", "ocr"):
            assert key in payload, f"the moment has no {key} field at all"
        assert payload["frames"], "no frame was returned for a moment in the video"

    def test_a_default_window_is_applied_when_none_is_given(
        self, indexed: str
    ) -> None:
        payload = source_moment({"sourceId": indexed, "timestampMs": 4000})
        assert payload["window"] == pytest.approx(10.0)

    def test_frame_paths_do_not_leak_this_machine(self, indexed: str) -> None:
        # `scrub` exists because a frame path is absolute here and disclosive
        # to whoever is reading the answer.
        payload = source_moment({"sourceId": indexed, "timestampMs": 4000})
        rendered = str(payload)
        assert "C:\\Users" not in rendered and "/home/" not in rendered


class TestTheParameterItReads:
    def test_the_name_the_host_used_to_send_is_still_refused(
        self, indexed: str
    ) -> None:
        # `atMs` was the Host's own parameter name. Accepting it now would let
        # the two halves drift apart again in the other direction.
        with pytest.raises(BridgeError) as caught:
            source_moment({"sourceId": indexed, "atMs": 4000})
        assert caught.value.error == "bridge.invalid_params"
        assert "timestampMs" in caught.value.message

    @pytest.mark.parametrize("value", [None, "4000", True, False, [4000]])
    def test_a_timestamp_that_is_not_a_number_is_refused(
        self, indexed: str, value: object
    ) -> None:
        with pytest.raises(BridgeError) as caught:
            source_moment({"sourceId": indexed, "timestampMs": value})
        assert caught.value.error == "bridge.invalid_params"
        assert caught.value.fix

    def test_a_missing_source_is_refused_rather_than_crashing(self) -> None:
        with pytest.raises(BridgeError):
            source_moment({"timestampMs": 4000})
