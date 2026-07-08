"""A4 — the engine speaks the QUESTION's language.

Honest-floor refusal, evidence label, and the model answer-language directive
are localized; English is byte-for-byte unchanged (the trust-contract tests in
test_answer.py still assert the English wording). RTL timestamps are isolated
so they can't reorder under the bidi algorithm.
"""
from __future__ import annotations

import pytest

from watch_skill.answer.engine import (
    _VERIFY_PROMPT,
    _answer_text,
    _evidence_lines,
    _honest_floor_text,
)
from watch_skill.answer.localize import (
    answer_language_directive,
    detect_lang,
    is_rtl,
    messages,
)
from watch_skill.answer.types import Evidence

LRI, PDI = "⁦", "⁩"


# ---- language detection ---------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("متى تظهر شاشة التحذير؟", "ar"),
    ("警告画面はいつ表示されますか", "ja"),
    ("警告屏幕什么时候出现", "zh"),
    ("경고 화면은 언제 나타납니까", "ko"),
    ("Когда появляется экран предупреждения?", "ru"),
    ("चेतावनी स्क्रीन कब दिखती है?", "hi"),
    ("מתי מופיע מסך האזהרה?", "he"),
    ("¿Cuándo aparece la pantalla de advertencia?", "es"),
    ("Quand l'écran d'avertissement apparaît-il ?", "fr"),
    ("Wann erscheint der Warnbildschirm?", "de"),
    ("When does the warning screen appear?", "en"),
])
def test_detect_lang(text: str, expected: str) -> None:
    assert detect_lang(text) == expected


def test_detect_lang_defaults_to_english() -> None:
    assert detect_lang("zzz qqq") == "en"


# ---- honest floor localized ------------------------------------------------

def test_honest_floor_english_wording_unchanged() -> None:
    """The trust contract: English keeps the exact asserted phrase + repr quotes."""
    text = _honest_floor_text("what color is the hat?", [], "en")
    assert "The video does not clearly show an answer to:" in text
    assert "'what color is the hat?'" in text  # repr() quoting preserved
    assert LRI not in text  # no isolates leak into English output


@pytest.mark.parametrize("lang,needle", [
    ("es", "no muestra claramente"),
    ("ar", "لا يُظهر بوضوح"),
    ("ja", "明確な答えは映っていません"),
    ("fr", "ne montre pas clairement"),
])
def test_honest_floor_localized(lang: str, needle: str) -> None:
    text = _honest_floor_text("q", [], lang)
    assert needle in text
    assert messages(lang)["floor_nothing"] in text  # no-evidence branch localized


# ---- evidence label localized ---------------------------------------------

@pytest.mark.parametrize("lang,label", [
    ("en", "Evidence:"), ("es", "Evidencia:"), ("ja", "根拠:"), ("ar", "الأدلة:"),
])
def test_answer_text_evidence_label(lang: str, label: str) -> None:
    ev = [Evidence(74.0, "segment", "some text", 0.5)]
    assert label in _answer_text("q", ev, "an answer", lang)


# ---- RTL isolation ---------------------------------------------------------

def test_rtl_timestamp_is_isolated_and_intact() -> None:
    ev = [Evidence(74.0, "segment", "نص عربي هنا", 0.5)]
    line = _evidence_lines(ev, "ar")
    assert LRI in line and PDI in line          # timestamp wrapped in an LTR isolate
    assert "[01:14]" in line                    # digits/colon intact, not reordered
    assert f"{LRI}[01:14]{PDI}" in line


def test_ltr_evidence_has_no_isolates() -> None:
    ev = [Evidence(74.0, "segment", "some text", 0.5)]
    assert LRI not in _evidence_lines(ev, "en")


# ---- model answer-language directive --------------------------------------

@pytest.mark.parametrize("lang,name", [
    ("es", "Spanish"), ("ja", "Japanese"), ("ar", "Arabic"), ("en", "English"),
])
def test_answer_language_directive(lang: str, name: str) -> None:
    assert name in answer_language_directive(lang)


def test_verify_prompt_carries_directive() -> None:
    filled = _VERIFY_PROMPT.format(
        question="q", evidence="- ev", lessons="", directive=answer_language_directive("es")
    )
    assert "{directive}" not in filled
    assert "Spanish" in filled


def test_rtl_flags() -> None:
    assert is_rtl("ar") and is_rtl("he")
    assert not is_rtl("en") and not is_rtl("ja")


# ---- integration: a Spanish question about absent content refuses in Spanish

def test_spanish_honest_floor_end_to_end(sample_video, tmp_path) -> None:
    pytest.importorskip("scenedetect", reason="perceive extra not installed")
    from watch_skill.answer import answer_question
    from watch_skill.index import index_watch_result
    from watch_skill.transcribe.types import Segment, Transcript
    from watch_skill.watch import watch

    result = watch(
        str(sample_video), out_dir=tmp_path / "es work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[Segment(0.5, 3.5, "the red warning screen appears first")],
        source="captions",
    )
    video_id = index_watch_result(result, describe_scenes=False)
    # ask, in Spanish, about something absent from the clip
    answer = answer_question(video_id, "¿De qué color es el sombrero del unicornio?", verify=False)
    assert answer.honest_floor is True
    assert "no muestra claramente" in answer.text  # refusal is in Spanish
