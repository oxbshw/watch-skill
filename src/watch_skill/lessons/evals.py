"""Every mistake becomes a test: lessons → eval cases → pass-rate over time.

``export_evals`` converts lessons into replayable constraint cases under
``<data_dir>/evals/``; ``run_evals`` replays them against the CURRENT system
and appends the pass-rate to a history file. The pass-rate rising is the
user-visible proof that the system learns.
"""
from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.lessons import store

_WORD_RE = re.compile(r"[\w؀-ۿ一-鿿]{3,}", re.UNICODE)

# function words make must_surface trivially satisfiable — "the" appears in
# every answer, so a case carrying it can never fail (which made regressed
# lessons classify as prunable; the self-improvement demo caught it live)
_STOPWORDS = frozenset(
    "the and for that this with was are were any not has have had its".split()
)


def _key_terms(text: str, cap: int = 6) -> list[str]:
    seen: list[str] = []
    for term in _WORD_RE.findall(text.lower()):
        if term not in seen and term not in _STOPWORDS:
            seen.append(term)
        if len(seen) >= cap:
            break
    return seen


def export_evals() -> Path:
    """Write one eval case per lesson; returns the eval file path."""
    evals_dir = get_settings().evals_dir
    evals_dir.mkdir(parents=True, exist_ok=True)
    out = evals_dir / "lessons_evals.jsonl"
    lessons = store.list_lessons(limit=10_000)
    with out.open("w", encoding="utf-8") as fh:
        for lesson in lessons:
            case = {
                "lesson_id": lesson["id"],
                "video_id": lesson["video_id"],
                "question": lesson["question"],
                "error_class": lesson["error_class"],
                # the correction's key terms should surface in evidence/answer
                "must_surface": _key_terms(lesson["correction"]),
                # a hallucination lesson demands the honest floor instead
                "expect_honest_floor": lesson["error_class"] == "hallucination",
            }
            fh.write(json.dumps(case, ensure_ascii=False) + "\n")
    return out


def run_evals() -> dict[str, Any]:
    """Replay every eval case against the current system; append history."""
    from watch_skill.answer import answer_question  # noqa: PLC0415
    from watch_skill.index.store import get_video  # noqa: PLC0415

    evals_dir = get_settings().evals_dir
    cases_file = evals_dir / "lessons_evals.jsonl"
    if not cases_file.is_file():
        return {"total": 0, "passed": 0, "skipped": 0, "pass_rate": None}

    total = passed = skipped = 0
    failures: list[dict[str, Any]] = []
    for line in cases_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if not case.get("video_id") or get_video(case["video_id"]) is None:
            skipped += 1  # the source video is no longer indexed
            continue
        total += 1
        try:
            answer = answer_question(case["video_id"], case["question"], use_cache=False)
        except Exception as exc:  # an eval crash is a failure, not an abort
            failures.append({"lesson_id": case["lesson_id"], "error": str(exc)})
            continue
        ok = _case_passes(case, answer)
        if ok:
            passed += 1
        else:
            failures.append({"lesson_id": case["lesson_id"], "question": case["question"]})

    result = {
        "total": total,
        "passed": passed,
        "skipped": skipped,
        "pass_rate": round(passed / total, 3) if total else None,
        "failures": failures[:10],
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    history = evals_dir / "history.jsonl"
    history.parent.mkdir(parents=True, exist_ok=True)
    with history.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({k: v for k, v in result.items() if k != "failures"},
                            ensure_ascii=False) + "\n")
    return result


def _case_passes(case: dict[str, Any], answer: Any) -> bool:
    """One pass rule for run_evals and the report alike.

    Terms must surface in the EVIDENCE, not the answer prose: the honest
    floor's text quotes the question, which would leak question words into
    a prose match and pass corrections the system never actually found."""
    if case.get("expect_honest_floor"):
        return bool(answer.honest_floor)
    blob = " ".join(e.text for e in answer.evidence).lower()
    terms = case.get("must_surface", [])
    hits = [t for t in terms if t in blob]
    return bool(terms) and len(hits) >= max(1, len(terms) // 3)


def eval_report() -> dict[str, Any]:
    """Replay every stored lesson against the CURRENT pipeline and classify:

    - ``still_effective`` — passes with the lesson injected, fails without
      it: the lesson is load-bearing, keep it.
    - ``prunable`` — passes even with the lesson suppressed: the pipeline
      answers correctly on its own now (root cause fixed); the lesson only
      costs injection budget.
    - ``regressed`` — fails even with the lesson: the lesson no longer
      protects against its own mistake; it needs a human look.

    Verification is off during replay: the report measures the retrieval +
    lesson mechanics deterministically, not a vision model's mood.
    """
    from watch_skill.answer import answer_question  # noqa: PLC0415
    from watch_skill.index.store import get_video  # noqa: PLC0415
    from watch_skill.lessons import inject  # noqa: PLC0415

    export_evals()  # classifications must reflect the CURRENT lesson set
    cases_file = get_settings().evals_dir / "lessons_evals.jsonl"
    classifications: list[dict[str, Any]] = []
    counts = {"still_effective": 0, "prunable": 0, "regressed": 0, "skipped": 0}

    for line in cases_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if not case.get("video_id") or get_video(case["video_id"]) is None:
            counts["skipped"] += 1
            classifications.append({"lesson_id": case["lesson_id"], "state": "skipped",
                                    "reason": "source video no longer indexed"})
            continue
        try:
            with_lesson = answer_question(
                case["video_id"], case["question"], use_cache=False, verify=False
            )
            passes_with = _case_passes(case, with_lesson)
            if not passes_with:
                state = "regressed"
            else:
                with inject.excluding([case["lesson_id"]]):
                    without_lesson = answer_question(
                        case["video_id"], case["question"], use_cache=False, verify=False
                    )
                state = "prunable" if _case_passes(case, without_lesson) else "still_effective"
        except Exception as exc:  # a crashed replay is a regression, not an abort
            state = "regressed"
            classifications.append({"lesson_id": case["lesson_id"], "state": state,
                                    "error": str(exc)[:200]})
            counts[state] += 1
            continue
        counts[state] += 1
        classifications.append({
            "lesson_id": case["lesson_id"], "state": state,
            "question": case["question"], "error_class": case.get("error_class"),
        })
    return {"counts": counts, "lessons": classifications,
            "at": datetime.now(UTC).isoformat(timespec="seconds")}


def prune_lessons(report: dict[str, Any] | None = None) -> int:
    """Delete the lessons the report marked prunable; returns how many."""
    from watch_skill.lessons import store as lessons_store  # noqa: PLC0415

    report = report or eval_report()
    prunable = [
        entry["lesson_id"] for entry in report["lessons"] if entry["state"] == "prunable"
    ]
    if not prunable:
        return 0
    return lessons_store.remove_lessons(ids=prunable)
