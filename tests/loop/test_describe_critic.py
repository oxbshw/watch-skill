"""The describe-then-judge critic: the small-model path for THE LOOP.

Captioning models (moondream) cannot emit the critic's JSON schema, but they
reliably describe frames and can answer PASS/FAIL over text evidence. These
tests pin that contract: rules from 'never X' criteria, the plain-text judge,
and critique_recording's automatic degrade when the JSON critic is impossible.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("PIL", reason="perceive extra not installed")

from watch_skill.errors import VisionError  # noqa: E402
from watch_skill.loop import critic as critic_mod  # noqa: E402
from watch_skill.loop.critic import (  # noqa: E402
    _banned_terms,
    _split_exemplars,
    _violates_rules,
    describe_critique,
)
from watch_skill.perceive.types import (  # noqa: E402
    Frame,
    OcrBlock,
    PerceptionResult,
    VideoMetadata,
)


def _perception(ocr_texts: list[str]) -> PerceptionResult:
    frames = [
        Frame(
            index=i, timestamp_seconds=float(i * 2), path=Path(f"frame_{i}.jpg"),
            scene_id=i, phash="0" * 16, reason="scene-start",
            ocr_blocks=(
                [OcrBlock(text=text, bbox=(0, 0, 1, 1), confidence=0.9)] if text else []
            ),
        )
        for i, text in enumerate(ocr_texts)
    ]
    meta = VideoMetadata(
        duration_seconds=len(frames) * 2.0 or 1.0,
        width=320, height=240, fps=30.0, codec="h264", has_audio=False,
    )
    return PerceptionResult(source="fake", metadata=meta, frames=frames)


class _FakeVision:
    """describe_frames + text judge with scripted outputs."""

    def __init__(self, descriptions: dict[str, str], judge_reply: str = "PASS"):
        self._descriptions = descriptions
        self.judge_reply = judge_reply
        self.judge_prompts: list[str] = []
        outer = self

        class _Client:
            def generate(self, prompt: str, images=None):
                if images:
                    raise AssertionError("judge must be text-only")
                outer.judge_prompts.append(prompt)
                if isinstance(outer.judge_reply, Exception):
                    raise outer.judge_reply
                return outer.judge_reply

        self.client = _Client()

    def describe_frames(self, frames, context=""):
        return [self._descriptions.get(Path(f).name, "a plain page") for f in frames]


# --- banned-term rules -------------------------------------------------------

def test_banned_terms_parse_never_no_or() -> None:
    terms = _banned_terms(
        "The page must show a real dollar total (like $29.00), never NaN or a placeholder."
    )
    assert "nan" in terms and "a placeholder" in terms


def test_violates_rules_is_word_bounded() -> None:
    assert _violates_rules("total: $nan shown", ["nan"]) == "nan"
    assert _violates_rules("finance dashboard", ["nan"]) is None  # no hit inside a word


def test_banned_terms_shed_light_verbs() -> None:
    """'never shows nan' must ban 'nan', not the unmatchable 'shows nan' —
    the flagship browser demo shipped a $NaN past the rule this way."""
    assert "nan" in _banned_terms("the total updates and never shows nan")
    assert "error toast" in _banned_terms("no error toast ever appears")
    assert "nan" in _banned_terms(
        "after checkout is clicked, the order total always shows a real "
        "dollar amount (like $29.00) and never shows nan"
    )


def test_exemplar_patterns_generalize_digits() -> None:
    positive, banned = _split_exemplars("must show a real dollar total (like $29.00)")
    assert banned == []
    (pattern,) = positive
    assert pattern.search("total is $348.20")  # same shape, different number
    assert pattern.search("TOTAL: $19.00")
    assert not pattern.search("TOTAL: $NaN")


def test_exemplar_with_leadin_words_sheds_clause_punctuation() -> None:
    """'(a number like $29.00), never NaN' — the paren doesn't start with
    'like', so the bare-word branch captures '$29.00),' and the shape must
    not keep the ')' (it made the golden-path critic judge a fixed page)."""
    positive, banned = _split_exemplars(
        "The checkout page must show a real dollar total (a number like $29.00), "
        "never NaN, and the BUY NOW button label must be clearly readable."
    )
    (pattern,) = positive
    assert pattern.search("the total cost of an item as $29.00 and change")
    assert pattern.search("Total: $348.20")  # no trailing ')' required
    assert banned == []  # 'NaN' is a banned TERM, not an exemplar pattern
    assert "nan" in _banned_terms(
        "must show a real dollar total (a number like $29.00), never NaN, and more"
    )


def test_exemplar_inside_negative_clause_becomes_ban() -> None:
    """'must never show X (like ERROR 502)' — the exemplar is what must NOT
    appear (the monitor frames conditions this way); treating it as a pass
    pattern would invert detection."""
    positive, banned = _split_exemplars(
        "The recording must never show an error screen (like ERROR 502)"
    )
    assert positive == []
    (pattern,) = banned
    assert pattern.search("red banner reading ERROR 502")
    assert pattern.search("shows ERROR 404 page")  # digit-generalized
    assert pattern.search("OCR text: ERROR502")    # OCR drops spaces — still hits


def test_describe_critique_detects_banned_pattern(monkeypatch) -> None:
    fake = _FakeVision({"frame_0.jpg": "red screen with big text ERROR 502"})
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(
        _perception([""]),
        "The recording must never show an error screen (like ERROR 502)",
    )
    assert critique.verdict == "fail"
    assert critique.issues[0].severity == "critical"
    assert fake.judge_prompts == []  # deterministic detection, no judge


def test_exemplar_pass_skips_the_judge(monkeypatch) -> None:
    """Evidence matching the criteria's exemplar passes deterministically —
    the unreliable text judge is never consulted (a moondream false-FAIL on a
    genuinely fixed page blocked the loop from ever passing)."""
    fake = _FakeVision(
        {"frame_0.jpg": "checkout page, total reads $29.00"}, judge_reply="FAIL"
    )
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(
        _perception([""]), "must show a real dollar total (like $29.00), never NaN"
    )
    assert critique.verdict == "pass"
    assert fake.judge_prompts == []  # judge never called


def test_exemplar_is_recording_level(monkeypatch) -> None:
    """An animated capture has frames where OCR misses the HUD; the exemplar
    seen in ANY frame satisfies the requirement — no judge on the others."""
    fake = _FakeVision(
        {"frame_0.jpg": "ball mid-bounce, HUD unreadable",
         "frame_1.jpg": "game screen, HUD reads SCORE: 7"},
        judge_reply="FAIL",  # would false-fail frame_0 if consulted
    )
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(
        _perception(["", ""]),
        "The SCORE counter must show a number (like SCORE: 12), never NaN",
    )
    assert critique.verdict == "pass"
    assert fake.judge_prompts == []


def test_banned_term_beats_exemplar(monkeypatch) -> None:
    """A frame showing both $19.00 and $NaN must still fail: negative rules
    outrank exemplar matches."""
    fake = _FakeVision({"frame_0.jpg": "items $19.00 and $10.00, total reads $NaN"})
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(
        _perception([""]), "must show a real dollar total (like $29.00), never NaN"
    )
    assert critique.verdict == "fail"
    assert critique.issues[0].severity == "critical"


# --- describe critic ---------------------------------------------------------

def test_describe_critique_fails_on_banned_term(monkeypatch) -> None:
    fake = _FakeVision({"frame_0.jpg": "checkout page, total reads $NaN"})
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(
        _perception([""]), "show a real dollar total, never NaN"
    )
    assert critique.verdict == "fail"
    assert critique.issues and critique.issues[0].severity == "critical"
    assert "nan" in critique.issues[0].description.lower()
    assert fake.judge_prompts == []  # rules decided; no judge call needed


def test_describe_critique_uses_judge_when_rules_clean(monkeypatch) -> None:
    fake = _FakeVision({"frame_0.jpg": "checkout page, total reads $29.00"}, judge_reply="FAIL")
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(_perception([""]), "the buy button label must be readable")
    assert critique.verdict == "fail"
    assert critique.issues[0].severity == "major"
    assert len(fake.judge_prompts) == 1


def test_describe_critique_passes_clean_frames(monkeypatch) -> None:
    fake = _FakeVision({"frame_0.jpg": "checkout page, total reads $29.00"}, judge_reply="PASS")
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(_perception([""]), "show a real dollar total, never NaN")
    assert critique.verdict == "pass"
    assert critique.score >= 90 and critique.issues == []


def test_describe_critique_judge_error_degrades_to_pass_when_rules_clean(monkeypatch) -> None:
    fake = _FakeVision(
        {"frame_0.jpg": "a normal page"},
        judge_reply=VisionError("empty", code="vision.empty"),
    )
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(_perception([""]), "never NaN")
    assert critique.verdict == "pass"  # rules clean + judge unavailable = pass


def test_describe_critique_reads_ocr_evidence(monkeypatch) -> None:
    """OCR text on the frame joins the evidence even if the description misses it."""
    fake = _FakeVision({"frame_0.jpg": "a checkout page"})
    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: fake)
    critique = describe_critique(_perception(["TOTAL: $NaN"]), "never NaN")
    assert critique.verdict == "fail"


# --- automatic degrade from the JSON critic ----------------------------------

def test_critique_recording_degrades_to_describe_critic(monkeypatch) -> None:
    """A model that answers 'Pass' instead of JSON (moondream) must not kill
    the loop: critique_recording falls back to describe-then-judge."""

    class _Client:
        def __init__(self):
            self.calls = 0

        def generate(self, prompt: str, images=None):
            if images:  # the JSON critic call (frames attached)
                self.calls += 1
                return "Pass"  # never JSON
            return "PASS"  # text-only judge

    class _Vision:
        client = _Client()

        def describe_frames(self, frames, context=""):
            return ["a healthy page, total $29.00"]

    monkeypatch.setattr(critic_mod, "get_vision", lambda *a, **k: _Vision())
    critique = critic_mod.critique_recording(_perception([""]), "never NaN")
    assert critique.verdict == "pass"
    assert critique.summary  # assembled by the describe critic
