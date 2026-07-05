"""Self-improve loop: lessons roundtrip, injection budget, classification,
profiles, evals export/run, session semantics, and the LRU cap."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.lessons import (  # noqa: E402
    export_evals,
    get_profile,
    list_lessons,
    relevant_guidance,
    remove_lessons,
    report_mistake,
    run_evals,
    show_profiles,
)
from watch_skill.lessons.classify import classify_error, derive_guidance  # noqa: E402
from watch_skill.transcribe.types import Segment, Transcript  # noqa: E402
from watch_skill.watch import watch  # noqa: E402


@pytest.fixture()
def indexed(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video), out_dir=tmp_path / "lesson work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "the red warning screen appears first"),
            Segment(4.5, 7.5, "then the colorful calibration bars show up"),
        ],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


# ---- classification ----------------------------------------------------------

@pytest.mark.parametrize(
    "correction,expected",
    [
        ("the on-screen text says ERROR 42, not ERROR 24", "missed-ocr"),
        ("it actually happens at 2:10, not 0:30", "wrong-timestamp"),
        ("that scene is not in the video at all", "hallucination"),
        ("the answer should use the original Arabic audio, not the translation", "language"),
        ("look closer at the brief moment when the chart flashes", "sampling-miss"),
    ],
)
def test_error_classification(correction: str, expected: str) -> None:
    wrong = "it happens at 0:30" if expected == "wrong-timestamp" else "some wrong answer"
    assert classify_error("q", wrong, correction) == expected


def test_guidance_is_one_imperative_sentence() -> None:
    guidance = derive_guidance("missed-ocr", "the badge says PRO, not PRD", "screencast")
    assert guidance.startswith("Read the on-screen text")
    assert "PRO" in guidance
    assert "screencast" in guidance


# ---- roundtrip + immediate re-ask -------------------------------------------

def test_report_mistake_roundtrip_and_validation(indexed: str) -> None:
    outcome = report_mistake(
        indexed,
        question="what appears after the warning screen?",
        wrong_answer="a black screen appears",
        correction="look closer at that moment — the colorful calibration bars show up",
        agent="pytest",
        session_id="sess-1",
    )
    assert outcome["error_class"] == "sampling-miss"
    assert outcome["lesson_id"] > 0
    assert outcome["reasked"] is True
    # the correction's terms ARE in the transcript -> the re-ask should see them
    assert outcome["validated"] is True

    lessons = list_lessons(session_id="sess-1")
    assert len(lessons) == 1
    assert lessons[0]["validated"] == 1
    assert lessons[0]["content_type"] in (
        "generic", "screencast", "talking-head", "fast-cut", "vertical"
    )


def test_hallucination_report_skips_reask(indexed: str) -> None:
    outcome = report_mistake(
        indexed,
        question="when does the narrator mention pricing?",
        wrong_answer="at 0:45 the narrator discusses pricing",
        correction="that is not in the video at all — no such statement",
        session_id="sess-2",
    )
    assert outcome["error_class"] == "hallucination"
    assert "reasked" not in outcome  # nothing mechanical to re-verify


# ---- injection ---------------------------------------------------------------

def test_injection_returns_relevant_guidance_and_touches_lru(indexed: str) -> None:
    report_mistake(
        indexed,
        question="what color are the calibration bars?",
        wrong_answer="grey",
        correction="look closer, the calibration bars are colorful",
        session_id="sess-3",
        reask=False,
    )
    from watch_skill.index.store import get_video

    lines = relevant_guidance("what color are the calibration bars?", get_video(indexed))
    assert lines, "a directly relevant lesson must inject"
    assert any("calibration" in line for line in lines)


def test_injection_respects_token_cap(indexed: str, monkeypatch) -> None:
    from watch_skill.index.store import get_video

    for i in range(6):
        report_mistake(
            indexed,
            question=f"question about calibration bars variant {i}",
            wrong_answer="wrong",
            correction=f"look closer at the calibration bars case {i} " + "detail " * 30,
            session_id="sess-cap",
            reask=False,
        )
    monkeypatch.setenv("WATCHSKILL_LESSONS_INJECTION_TOKEN_CAP", "60")
    from watch_skill.config import reset_settings

    reset_settings()
    try:
        from watch_skill.answer.types import est_text_tokens

        lines = relevant_guidance("question about calibration bars", get_video(indexed))
        assert sum(est_text_tokens(line) for line in lines) <= 60
        assert len(lines) >= 1  # cap shrinks, never zeroes-out the best lesson
    finally:
        reset_settings()


def test_lessons_never_break_answers(indexed: str, monkeypatch) -> None:
    """A crashing lessons store must not sink answer_question."""
    import watch_skill.answer.engine as mod

    def boom(question, video):
        raise RuntimeError("lessons db corrupted")

    monkeypatch.setattr("watch_skill.lessons.relevant_guidance", boom)
    from watch_skill.answer import answer_question

    answer = answer_question(indexed, "when do the calibration bars show?", use_cache=False)
    assert answer.evidence  # answered despite the broken store
    assert mod is not None


# ---- session semantics + LRU cap ---------------------------------------------

def test_session_prune_and_lru_cap(indexed: str, monkeypatch) -> None:
    for i in range(4):
        report_mistake(
            indexed, question=f"q{i}", wrong_answer="w", correction=f"look closer c{i}",
            session_id="sess-prune", reask=False,
        )
    assert len(list_lessons(session_id="sess-prune")) == 4
    removed = remove_lessons(session_id="sess-prune")
    assert removed == 4
    assert list_lessons(session_id="sess-prune") == []

    monkeypatch.setenv("WATCHSKILL_LESSONS_MAX_COUNT", "3")
    from watch_skill.config import reset_settings

    reset_settings()
    try:
        for i in range(5):
            report_mistake(
                indexed, question=f"cap q{i}", wrong_answer="w",
                correction=f"look closer cap {i}", session_id="sess-lru", reask=False,
            )
        assert len(list_lessons(limit=1000)) <= 3, "LRU cap must bound the store"
    finally:
        reset_settings()


# ---- profiles ------------------------------------------------------------------

def test_profiles_aggregate_and_apply(indexed: str) -> None:
    for i in range(3):
        report_mistake(
            indexed,
            question=f"screen text q{i}",
            wrong_answer="unclear",
            correction=f"the on-screen text says VALUE-{i}",
            session_id="sess-prof",
            reask=False,
        )
    profiles = show_profiles()
    assert profiles, "3 same-class lessons must earn a profile"
    from watch_skill.index.store import get_video
    from watch_skill.lessons.classify import classify_content_type

    content_type = classify_content_type(get_video(indexed))
    overrides = get_profile(content_type)
    assert overrides.get("ocr_first") is True


def test_profile_reorders_ladder(indexed: str, monkeypatch) -> None:
    from watch_skill.answer import engine as mod

    calls: list[str] = []
    monkeypatch.setattr(
        mod, "dense_resample", lambda v, h: calls.append("dense_resample") or (0, 0)
    )
    monkeypatch.setattr(
        mod, "zoom_crops_reocr", lambda v, h: calls.append("zoom_crops_reocr") or (0, 0)
    )
    monkeypatch.setattr(mod, "_profile_for", lambda v: {"ocr_first": True})
    from watch_skill.answer import answer_question

    answer_question(indexed, "zebra spaceship quantum", use_cache=False)
    assert calls == ["zoom_crops_reocr", "dense_resample"]


# ---- evals ----------------------------------------------------------------------

def test_evals_export_and_run(indexed: str) -> None:
    report_mistake(
        indexed,
        question="what shows after the warning?",
        wrong_answer="nothing",
        correction="look again — the calibration bars show up",
        session_id="sess-eval",
        reask=False,
    )
    report_mistake(
        indexed,
        question="when does the unicorn appear?",
        wrong_answer="at 0:03 a unicorn appears",
        correction="no such thing in the video — it does not show a unicorn",
        session_id="sess-eval",
        reask=False,
    )
    path = export_evals()
    assert path.is_file()
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 2

    result = run_evals()
    assert result["total"] >= 2
    assert result["pass_rate"] is not None
    # the calibration-bars case is answerable; the hallucination case demands
    # the honest floor — both should pass against the current system
    assert result["passed"] >= 2
    history = (path.parent / "history.jsonl").read_text(encoding="utf-8")
    assert "pass_rate" in history
