"""The critic must never turn absent evidence into a pass.

Every case here scored 92/"pass" before the verdict model grew
``inconclusive``: no frames, no descriptions, an unreachable judge, a model
that could not be built. A confident pass over evidence that was never
collected is the worst failure this system can produce, because it looks
exactly like a real one.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.errors import VisionError
from watch_skill.loop import critic as critic_mod
from watch_skill.loop.critic import (
    Critique,
    critique_recording,
    describe_critique,
    inconclusive,
)
from watch_skill.perceive.types import Frame, OcrBlock, PerceptionResult, VideoMetadata


def _perception(frames: list[Frame]) -> PerceptionResult:
    return PerceptionResult(
        source="rec.mp4",
        metadata=VideoMetadata(
            duration_seconds=10.0, width=320, height=240, fps=10.0,
            codec="h264", has_audio=False,
        ),
        frames=frames,
    )


def _frame(tmp_path: Path, index: int, ocr: str = "") -> Frame:
    path = tmp_path / f"f{index}.jpg"
    path.write_bytes(b"\xff\xd8\xff\xdb")  # not a decodable image; nothing decodes it
    return Frame(
        index=index, timestamp_seconds=float(index), path=path,
        scene_id=index, phash="0" * 16, reason="scene",
        ocr_blocks=[OcrBlock(text=ocr, bbox=(0, 0, 1, 1), confidence=0.9)] if ocr else [],
    )


class _Vision:
    """A stand-in vision model with programmable failure."""

    def __init__(self, describe=None, judge=None) -> None:
        self._describe = describe
        self._judge = judge
        self.client = self

    def describe_frames(self, frames, context: str = "") -> list[str]:
        if callable(self._describe):
            return [self._describe(f) for f in frames]
        return [self._describe or ""] * len(frames)

    def generate(self, prompt: str, images=None) -> str:
        if callable(self._judge):
            return self._judge(prompt)
        if self._judge is None:
            raise VisionError("judge down", code="vision.call_failed", fix="retry")
        return self._judge


# --- no evidence ------------------------------------------------------------


def test_no_frames_is_inconclusive_not_a_score_of_92() -> None:
    verdict = describe_critique(_perception([]), "the total must be visible")
    assert verdict.verdict == "inconclusive"
    assert verdict.score == 0
    assert verdict.decisive is False
    assert verdict.limitations


def test_no_frames_through_the_json_critic_is_also_inconclusive() -> None:
    verdict = critique_recording(_perception([]), "the total must be visible")
    assert verdict.verdict == "inconclusive"
    assert verdict.score == 0


def test_empty_descriptions_and_no_ocr_cannot_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: _Vision(describe=""))
    verdict = describe_critique(
        _perception([_frame(tmp_path, i) for i in range(3)]),
        "the checkout page must show a total",
    )
    assert verdict.verdict == "inconclusive"
    assert any("no usable visual evidence" in line or "empty" in line
               for line in [verdict.summary, *verdict.limitations])


def test_every_describe_call_failing_cannot_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_frame):
        raise VisionError("down", code="vision.call_failed", fix="retry")

    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: _Vision(describe=boom))
    verdict = describe_critique(
        _perception([_frame(tmp_path, i) for i in range(3)]),
        "the checkout page must show a total",
    )
    assert verdict.verdict == "inconclusive"


# --- unreachable model ------------------------------------------------------


def test_unavailable_vision_model_is_inconclusive_not_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unavailable(*args, **kwargs):
        raise VisionError("no key", code="vision.no_api_key", fix="set a key")

    monkeypatch.setattr(critic_mod, "get_vision", unavailable)
    verdict = describe_critique(
        _perception([_frame(tmp_path, 0)]), "the page must look right"
    )
    assert verdict.verdict == "inconclusive"


def test_failed_fallback_judge_is_inconclusive_not_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The judge is the last link; a judge that never ran judged nothing."""
    monkeypatch.setattr(
        critic_mod, "get_vision",
        lambda *a, **k: _Vision(describe="a login form", judge=None),
    )
    verdict = describe_critique(
        _perception([_frame(tmp_path, i) for i in range(2)]),
        "the page must look right",
    )
    assert verdict.verdict == "inconclusive"
    assert "judge" in " ".join([verdict.summary, *verdict.limitations]).lower()


# --- deterministic rules still decide ---------------------------------------


def test_a_banned_term_in_the_evidence_still_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        critic_mod, "get_vision",
        lambda *a, **k: _Vision(describe="cart total shows NaN"),
    )
    verdict = describe_critique(
        _perception([_frame(tmp_path, 0)]), "the total must never show NaN"
    )
    assert verdict.verdict == "fail"
    assert verdict.assurance == "deterministic_local"


def test_a_deterministic_pass_is_not_marketed_as_independent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        critic_mod, "get_vision",
        lambda *a, **k: _Vision(describe="cart total $29.00"),
    )
    verdict = describe_critique(
        _perception([_frame(tmp_path, 0)]),
        "the cart must show a real dollar total (like $29.00)",
    )
    assert verdict.verdict == "pass"
    # local rules over local evidence — never remote_attested
    assert verdict.assurance == "deterministic_local"


def test_a_model_json_pass_stays_advisory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A model cannot promote its own verdict by writing a field."""
    payload = (
        '{"verdict": "pass", "score": 100, "summary": "perfect", "issues": [],'
        ' "assurance": "remote_attested"}'
    )
    monkeypatch.setattr(
        critic_mod, "get_vision", lambda *a, **k: _Vision(judge=lambda _p: payload)
    )
    verdict = critique_recording(_perception([_frame(tmp_path, 0)]), "looks right")
    assert verdict.verdict == "pass"
    assert verdict.assurance == "visual_advisory"


# --- the shape of an inconclusive verdict -----------------------------------


def test_inconclusive_never_carries_a_grade_like_score() -> None:
    verdict = inconclusive("could not tell", "model down")
    assert verdict.score == 0
    assert verdict.decisive is False
    assert verdict.limitations == ["model down"]


def test_verdict_field_rejects_an_unknown_value() -> None:
    with pytest.raises(ValueError):
        Critique(verdict="probably", score=50)


def test_assurance_field_rejects_an_invented_level() -> None:
    with pytest.raises(ValueError):
        Critique(verdict="pass", score=90, assurance="cryptographically_certain")


# --- the loop and the monitor honour it -------------------------------------


def test_loop_does_not_stop_successfully_on_an_inconclusive_verdict() -> None:
    from watch_skill.loop.runner import LoopState, _update_status

    state = LoopState(
        loop_id="x", target="screen:", pass_criteria="c", script=None,
        max_iterations=3, duration_seconds=1.0,
    )
    state.iterations = [{"n": 0, "critique": inconclusive("no frames").model_dump()}]
    _update_status(state)
    assert state.status == "running"

    state.iterations *= 3
    _update_status(state)
    assert state.status == "inconclusive"
    assert state.status != "passed"


def test_monitor_reports_inconclusive_rather_than_a_false_detection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A blind critic must not page someone, and must not be silent either."""
    from watch_skill.loop import monitor as monitor_mod
    from watch_skill.perceive import media

    perception = _perception([_frame(tmp_path, 0)])
    monkeypatch.setattr(monitor_mod, "perceive", lambda *a, **k: perception)
    monkeypatch.setattr(
        media, "probe",
        lambda *a, **k: VideoMetadata(
            duration_seconds=5.0, width=320, height=240, fps=10.0,
            codec="h264", has_audio=False,
        ),
    )
    detections = monitor_mod._check_recording(
        tmp_path / "rec.mp4", tmp_path / "work", "an error toast",
        lambda _p, _c: inconclusive("the critic could not be reached"),
    )
    assert len(detections) == 1
    assert detections[0]["severity"] == "inconclusive"
    assert detections[0]["limitations"]
