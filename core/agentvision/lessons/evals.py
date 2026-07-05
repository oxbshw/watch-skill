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

from agentvision.config import get_settings
from agentvision.lessons import store

_WORD_RE = re.compile(r"[\w؀-ۿ一-鿿]{3,}", re.UNICODE)


def _key_terms(text: str, cap: int = 6) -> list[str]:
    seen: list[str] = []
    for term in _WORD_RE.findall(text.lower()):
        if term not in seen:
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
    from agentvision.answer import answer_question  # noqa: PLC0415
    from agentvision.index.store import get_video  # noqa: PLC0415

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
        if case.get("expect_honest_floor"):
            ok = answer.honest_floor
        else:
            blob = (answer.text + " " + " ".join(e.text for e in answer.evidence)).lower()
            terms = case.get("must_surface", [])
            hits = [t for t in terms if t in blob]
            ok = bool(terms) and len(hits) >= max(1, len(terms) // 3)
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
