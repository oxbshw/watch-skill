"""Pillar 6 — the eval report: lessons classified against the CURRENT
pipeline as still-effective / prunable / regressed, and --prune acts on it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.lessons import evals, inject, store  # noqa: E402
from watch_skill.lessons.evals import eval_report, prune_lessons  # noqa: E402
from watch_skill.transcribe.types import Segment, Transcript  # noqa: E402
from watch_skill.watch import watch  # noqa: E402


@pytest.fixture()
def indexed(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video), out_dir=tmp_path / "lessons work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[Segment(0.5, 3.5, "the red warning banner appears before the calibration bars")],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


def _lesson(video_id: str, question: str, correction: str) -> int:
    return store.add_lesson(
        question=question, wrong_answer="something wrong", correction=correction,
        error_class="misread", guidance=f"When asked '{question}': {correction}",
        video_id=video_id,
    )


def test_prunable_when_pipeline_answers_without_the_lesson(indexed: str) -> None:
    # the correction's terms live in the transcript — retrieval surfaces
    # them with or without the lesson, so the lesson is not load-bearing
    lesson_id = _lesson(indexed, "what appears before the bars?", "the red warning banner")
    report = eval_report()
    states = {e["lesson_id"]: e["state"] for e in report["lessons"]}
    assert states[lesson_id] == "prunable"


def test_regressed_when_correction_never_surfaces(indexed: str) -> None:
    lesson_id = _lesson(indexed, "what is the wifi password?", "hunter2 quokka volcano")
    report = eval_report()
    states = {e["lesson_id"]: e["state"] for e in report["lessons"]}
    assert states[lesson_id] == "regressed"


def test_skipped_when_source_video_gone() -> None:
    lesson_id = _lesson("vanished-video-id", "anything?", "anything")
    report = eval_report()
    entry = next(e for e in report["lessons"] if e["lesson_id"] == lesson_id)
    assert entry["state"] == "skipped"
    assert report["counts"]["skipped"] == 1


def test_still_effective_when_lesson_is_load_bearing(
    indexed: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Classification logic: passes WITH the lesson, fails WITHOUT it."""
    lesson_id = _lesson(indexed, "what color is the banner?", "crimson alarm shade")

    from types import SimpleNamespace

    class FakeAnswer:
        honest_floor = False

        def __init__(self, evidence_text: str) -> None:
            self.text = "an answer"
            # the pass rule reads EVIDENCE, not prose (prose quotes the question)
            self.evidence = [SimpleNamespace(text=evidence_text)] if evidence_text else []

    def fake_answer(video_id, question, use_cache=True, verify=None, **kwargs):
        if lesson_id in inject._EXCLUDED_LESSON_IDS:
            return FakeAnswer("")  # without the lesson: nothing surfaces
        return FakeAnswer("the crimson alarm shade banner")  # with it: hits

    monkeypatch.setattr("watch_skill.answer.answer_question", fake_answer)
    report = eval_report()
    states = {e["lesson_id"]: e["state"] for e in report["lessons"]}
    assert states[lesson_id] == "still_effective"


def test_prune_removes_only_prunable(indexed: str) -> None:
    keep_id = _lesson(indexed, "what is the wifi password?", "hunter2 quokka volcano")
    prune_id = _lesson(indexed, "what appears before the bars?", "the red warning banner")
    report = eval_report()
    removed = prune_lessons(report)
    assert removed == 1
    remaining = {lesson["id"] for lesson in store.list_lessons(limit=100)}
    assert keep_id in remaining and prune_id not in remaining


def test_export_reflects_current_lessons(indexed: str) -> None:
    """eval_report must re-export before classifying, or pruned/new lessons
    would be judged against a stale case file."""
    _lesson(indexed, "first question?", "the red warning banner")
    eval_report()
    added_later = _lesson(indexed, "second question later?", "the red warning banner")
    report = eval_report()
    assert any(e["lesson_id"] == added_later for e in report["lessons"])


def test_evals_module_exports() -> None:
    assert callable(evals.eval_report) and callable(evals.prune_lessons)
