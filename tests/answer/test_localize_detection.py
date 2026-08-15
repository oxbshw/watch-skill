"""Language detection: decide on evidence, or admit there is none.

Ported from the design in oxbshw/watch-skill#16 by @muniz33, which correctly
identified that Portuguese was losing to its neighbours. The mechanism here is
different: rather than breaking a tie after the fact, tokens are weighted by
how many languages claim them, so a word only Portuguese uses outweighs one it
shares with Spanish and Italian and there is no tie left to break.
"""
from __future__ import annotations

import itertools
import random

import pytest

from watch_skill.answer.localize import (
    _LATIN_STOP,
    LanguageGuess,
    answer_language_directive,
    detect_lang,
    detect_language,
)

# Table-driven, so adding a language means adding rows rather than tests.
RESOLVED_CASES: list[tuple[str, str]] = [
    # English
    ("What does the screen show at 2:30?", "en"),
    ("Do they agree?", "en"),
    ("When did the error appear in the video?", "en"),
    ("Show me what is on the screen", "en"),
    # Portuguese — accented
    ("O que aparece na tela do vídeo?", "pt"),
    ("Quando é que o erro está na tela?", "pt"),
    ("Você não mostra a tela?", "pt"),
    # Portuguese — unaccented, as people actually type
    ("O que aparece na tela do video?", "pt"),
    ("Voce nao mostra a tela?", "pt"),
    ("Quais sao os erros na tela?", "pt"),
    # Spanish
    ("¿Qué muestra la pantalla del vídeo?", "es"),
    ("¿Cuándo aparece el error en la pantalla?", "es"),
    ("¿Dónde está la pantalla?", "es"),
    # French
    ("Que montre l'écran de la vidéo ?", "fr"),
    ("Quand est-ce que l'erreur apparaît dans la vidéo ?", "fr"),
    # Italian
    ("Che cosa mostra lo schermo del video?", "it"),
    ("Quando appare l'errore sullo schermo?", "it"),
    # German
    ("Was zeigt der Bildschirm im Video?", "de"),
    ("Wann erscheint der Fehler?", "de"),
]


@pytest.mark.parametrize(("text", "expected"), RESOLVED_CASES,
                         ids=[f"{lang}:{text[:28]}" for text, lang in RESOLVED_CASES])
def test_detection_table(text: str, expected: str) -> None:
    assert detect_lang(text) == expected


def test_the_regression_that_started_this() -> None:
    """"Do they agree?" is English.

    PR #16 added `do` and `da` to Portuguese, which is exactly how an English
    question becomes Portuguese. The fix is not to omit them but to declare
    them in every language that uses them, so the shared word is worth less to
    each.
    """
    guess = detect_language("Do they agree?")
    assert guess.lang == "en"
    assert guess.resolved is True


def test_portuguese_is_not_lost_to_its_neighbours() -> None:
    """The bug PR #16 was right about."""
    for text in ("O que aparece na tela?", "Onde está o vídeo?",
                 "Como você mostra isso?"):
        assert detect_lang(text) == "pt", text


# --- ordering must never decide anything --------------------------------------


def test_detection_does_not_depend_on_dictionary_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The property the old implementation quietly violated.

    `max(scores, key=...)` returns the first key at the maximum, so a draw was
    settled by however the dictionary literal happened to be written.
    """
    import watch_skill.answer.localize as localize

    baseline = {text: detect_lang(text) for text, _ in RESOLVED_CASES}
    original = dict(_LATIN_STOP)
    rng = random.Random(20260815)
    try:
        for _ in range(12):
            keys = list(original)
            rng.shuffle(keys)
            monkeypatch.setattr(
                localize, "_LATIN_STOP", {k: original[k] for k in keys}
            )
            monkeypatch.setattr(localize, "_WEIGHTS", localize._token_weights())
            for text, _ in RESOLVED_CASES:
                assert detect_lang(text) == baseline[text], (
                    f"{text!r} changed answer when the dictionaries were reordered"
                )
    finally:
        monkeypatch.setattr(localize, "_LATIN_STOP", original)
        monkeypatch.setattr(localize, "_WEIGHTS", localize._token_weights())


def test_word_order_within_a_question_does_not_change_the_answer() -> None:
    words = "o que aparece na tela do video".split()
    answers = {
        detect_lang(" ".join(perm))
        for perm in itertools.islice(itertools.permutations(words), 24)
    }
    assert answers == {"pt"}


# --- unresolved is a real answer ----------------------------------------------


def test_no_evidence_is_unresolved_not_english() -> None:
    """"I have no idea" and "it is English" must be distinguishable."""
    guess = detect_language("zzzz qqqq xxxx")
    assert guess.resolved is False
    assert guess.lang == "en", "the fallback is still English"
    assert guess.confidence == 0.0


def test_empty_input_is_unresolved() -> None:
    assert detect_language("").resolved is False
    assert detect_language("   ").resolved is False


def test_a_single_shared_word_is_not_enough_to_decide() -> None:
    """One word two languages share is not evidence for either."""
    guess = detect_language("una")
    assert guess.resolved is False


def test_an_even_split_reports_its_candidates() -> None:
    guess = detect_language("video")
    assert guess.resolved is False
    assert len(guess.candidates) != 1


def test_a_resolved_guess_carries_confidence() -> None:
    guess = detect_language("O que aparece na tela do vídeo?")
    assert guess.resolved is True
    assert guess.lang == "pt"
    assert 0.0 < guess.confidence <= 1.0


# --- script detection ---------------------------------------------------------


@pytest.mark.parametrize(("text", "expected"), [
    ("ماذا يظهر على الشاشة؟", "ar"),
    ("מה מופיע על המסך?", "he"),
    ("画面に何が表示されますか", "ja"),
    ("屏幕上显示什么", "zh"),
    ("화면에 무엇이 표시됩니까", "ko"),
    ("Что показано на экране?", "ru"),
    ("स्क्रीन पर क्या दिखता है", "hi"),
])
def test_script_settles_it_immediately(text: str, expected: str) -> None:
    guess = detect_language(text)
    assert guess.lang == expected
    assert guess.resolved is True
    assert guess.confidence == 1.0


# --- the directive ------------------------------------------------------------


def test_the_directive_names_a_resolved_language() -> None:
    directive = answer_language_directive(detect_language("O que aparece na tela?"))
    assert "Portuguese" in directive


def test_the_directive_defaults_to_english_when_unresolved() -> None:
    """A model told to answer in Portuguese on a 51% guess produces a
    confidently wrong language; defaulting produces a familiar one."""
    guess = detect_language("zzzz qqqq")
    assert guess.resolved is False
    assert "English" in answer_language_directive(guess)


def test_the_directive_still_accepts_a_bare_code() -> None:
    assert "Spanish" in answer_language_directive("es")
    assert "English" in answer_language_directive("")
    assert "English" in answer_language_directive("kl")


def test_a_guess_compares_equal_to_its_code() -> None:
    """Keeps `detect_language(q) == "pt"` readable at call sites."""
    assert detect_language("O que aparece na tela?") == "pt"
    assert LanguageGuess("fr", 1.0, True) == "fr"
    assert (LanguageGuess("fr", 1.0, True) == 7) is False


# --- the weighting itself ------------------------------------------------------


def test_a_shared_word_is_worth_less_than_a_distinctive_one() -> None:
    from watch_skill.answer.localize import _WEIGHTS

    assert _WEIGHTS["tela"] == pytest.approx(1.0), "pt-only word"
    assert _WEIGHTS["video"] < 0.5, "claimed by several languages"
    assert _WEIGHTS["do"] < 1.0, "shared with English"


def test_every_language_has_stopwords() -> None:
    for lang, words in _LATIN_STOP.items():
        assert words, f"{lang} has no stopwords"
