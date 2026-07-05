"""Self-healing answer loop: confidence, ladder, honest floor, cache, savings.

The forced honest-floor tests are the trust contract: asking about something
absent from the clip must produce a plain "not clearly shown" — with zero
fabricated timestamps.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from agentvision.answer import answer_question  # noqa: E402
from agentvision.answer.confidence import retrieval_confidence  # noqa: E402
from agentvision.answer.engine import _sanitize_timestamps  # noqa: E402
from agentvision.answer.types import est_frame_tokens  # noqa: E402
from agentvision.index import index_watch_result  # noqa: E402
from agentvision.index.retrieval import Hit  # noqa: E402
from agentvision.transcribe.types import Segment, Transcript  # noqa: E402
from agentvision.watch import watch  # noqa: E402

_TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")


@pytest.fixture()
def indexed(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video), out_dir=tmp_path / "ans work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "the red warning screen appears first"),
            Segment(4.5, 7.5, "then the colorful calibration bars show up"),
            Segment(8.5, 11.5, "finally the moving test pattern with a counter"),
        ],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


def _ts_seconds(token: str) -> float:
    parts = [int(p) for p in token.split(":")]
    return parts[-1] + parts[-2] * 60 + (parts[-3] * 3600 if len(parts) == 3 else 0)


# ---- confidence unit behavior ---------------------------------------------

def test_confidence_zero_without_hits() -> None:
    assert retrieval_confidence([]) == 0.0


def test_confidence_rewards_clear_winner_and_agreement() -> None:
    clear_winner = [
        Hit("v", "segment", 1, 10.0, "exact answer", 0.55),
        Hit("v", "ocr", 2, 11.0, "corroborating text", 0.20),
    ]
    murky_crowd = [
        Hit("v", "segment", 1, 10.0, "maybe", 0.22),
        Hit("v", "segment", 2, 80.0, "maybe elsewhere", 0.21),
        Hit("v", "segment", 3, 150.0, "or here", 0.20),
    ]
    assert retrieval_confidence(clear_winner) > retrieval_confidence(murky_crowd) + 0.2


# ---- citation discipline ----------------------------------------------------

def test_sanitize_strips_fabricated_timestamps() -> None:
    text = "It appears at 1:23 and again at 0:05."
    cleaned = _sanitize_timestamps(text, legal=[5.0])
    assert "0:05" in cleaned
    assert "1:23" not in cleaned
    assert "[see evidence]" in cleaned


# ---- forced honest floor ----------------------------------------------------

def test_honest_floor_on_absent_content(indexed: str) -> None:
    """Ask about something that is NOT in the clip: no guess, no fabricated
    timestamp — every timestamp in the text must map to real evidence."""
    answer = answer_question(indexed, "when does the giraffe ride the bicycle?", use_cache=False)
    assert answer.honest_floor is True
    assert answer.verified is False
    assert "does not clearly show" in answer.text
    legal = {e.timestamp for e in answer.evidence if e.timestamp is not None}
    for token in _TS.findall(answer.text):
        seconds = _ts_seconds(token)
        assert any(abs(seconds - ts) <= 2.0 for ts in legal), (
            f"fabricated timestamp {token} in honest-floor answer"
        )


def test_totally_empty_index_floor(sample_video: Path, tmp_path: Path) -> None:
    """No transcript at all -> still an honest floor, never a crash/guess."""
    result = watch(
        str(sample_video), out_dir=tmp_path / "empty work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(segments=[], source="none")
    video_id = index_watch_result(result, describe_scenes=False)
    answer = answer_question(video_id, "what is said about pricing?", use_cache=False)
    assert answer.honest_floor is True
    assert "does not clearly show" in answer.text


# ---- escalation ladder ------------------------------------------------------

def test_ladder_runs_in_order_and_stops_at_target(indexed: str, monkeypatch) -> None:
    from agentvision.answer import engine as mod

    calls: list[str] = []
    strong_hits = [
        Hit(indexed, "segment", 1, 1.0, "the exact answer text", 0.58),
        Hit(indexed, "ocr", 2, 1.5, "supporting ocr", 0.2),
    ]

    def fake_resample(video, hits):
        calls.append("dense_resample")
        return 3, 0  # found new items

    # after resample, retrieval suddenly finds a clear winner
    real_search = mod.hybrid_search

    def fake_search(question, video_id=None, k=8):
        return strong_hits if calls else real_search(question, video_id=video_id, k=k)

    monkeypatch.setattr(mod, "dense_resample", fake_resample)
    monkeypatch.setattr(mod, "zoom_crops_reocr", lambda v, h: calls.append("zoom") or (0, 0))
    monkeypatch.setattr(mod, "hybrid_search", fake_search)

    answer = answer_question(indexed, "completely unrelated nonsense query", use_cache=False)
    assert calls == ["dense_resample"], "ladder must stop once confidence clears the bar"
    assert answer.escalations_used == ["dense_resample"]
    assert answer.honest_floor is False


def test_ladder_full_walk_on_stubborn_low_confidence(indexed: str, monkeypatch) -> None:
    from agentvision.answer import engine as mod

    calls: list[str] = []
    monkeypatch.setattr(
        mod, "dense_resample", lambda v, h: calls.append("dense_resample") or (0, 0)
    )
    monkeypatch.setattr(
        mod, "zoom_crops_reocr", lambda v, h: calls.append("zoom_crops_reocr") or (0, 0)
    )
    answer = answer_question(indexed, "zebra spaceship quantum", use_cache=False)
    assert calls == ["dense_resample", "zoom_crops_reocr"]
    assert set(answer.escalations_used) == {"dense_resample", "zoom_crops_reocr"}


# ---- verify pass ------------------------------------------------------------

def test_verify_pass_confirms_and_marks_verified(indexed: str, monkeypatch) -> None:
    from agentvision.answer import engine as mod

    monkeypatch.setattr(
        mod, "_try_model_verify",
        lambda q, e, f, lessons, tier: (True, 0.9, "The warning screen appears at 0:01."),
    )
    answer = answer_question(indexed, "when does the red warning screen appear?", use_cache=False)
    assert answer.verified is True
    assert answer.honest_floor is False
    assert answer.confidence > 0.6
    assert "warning screen" in answer.text


def test_verify_pass_rejection_forces_floor(indexed: str, monkeypatch) -> None:
    """Model looked at the frames and did NOT see the claim -> honest floor,
    not the unverified claim."""
    from agentvision.answer import engine as mod

    monkeypatch.setattr(
        mod, "_try_model_verify", lambda q, e, f, lessons, tier: (False, 0.1, "not visible")
    )
    answer = answer_question(indexed, "when does the red warning screen appear?", use_cache=False)
    assert answer.verified is False
    assert answer.honest_floor is True
    assert "not visible" not in answer.text  # rejected prose is not the answer


def test_no_provider_degrades_gracefully(indexed: str) -> None:
    """Keyless machine: verify returns None internally, answer still forms."""
    answer = answer_question(indexed, "when do the calibration bars show up?", use_cache=False)
    assert answer.verified is False  # nothing verified without a model
    assert isinstance(answer.confidence, float)
    assert answer.evidence


# ---- budget guard -----------------------------------------------------------

def test_budget_guard_stops_model_calls(indexed: str, monkeypatch) -> None:
    from agentvision.answer import engine as mod

    monkeypatch.setenv("AGENTVISION_ANSWER_TOKEN_BUDGET", "10")
    from agentvision.config import reset_settings

    reset_settings()
    called = []
    monkeypatch.setattr(
        mod, "_try_model_verify", lambda *a: called.append(1) or (True, 0.9, "yes")
    )
    try:
        answer = answer_question(
            indexed, "when do the calibration bars show up?", use_cache=False
        )
    finally:
        reset_settings()
    assert called == [], "budget must veto the model call"
    assert answer.budget_stopped is True


# ---- cache + savings ---------------------------------------------------------

def test_cache_hit_on_repeat_and_semantic_near_duplicate(indexed: str) -> None:
    first = answer_question(indexed, "when do the calibration bars show up?")
    assert first.cached is False
    repeat = answer_question(indexed, "when do the calibration bars show up?")
    assert repeat.cached is True
    assert repeat.text == first.text
    near = answer_question(indexed, "at what time do the calibration bars appear?")
    assert near.cached is True, "semantic near-duplicate should hit the cache"


def test_cache_invalidated_on_rewatch(indexed: str, sample_video: Path, tmp_path: Path) -> None:
    answer_question(indexed, "when do the calibration bars show up?")
    result = watch(
        str(sample_video), out_dir=tmp_path / "rewatch work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[Segment(0.5, 3.5, "totally new commentary")], source="captions"
    )
    index_watch_result(result, describe_scenes=False)  # same source -> same id
    fresh = answer_question(indexed, "when do the calibration bars show up?")
    assert fresh.cached is False, "re-watch must invalidate the answer cache"


def test_savings_meter_math(indexed: str) -> None:
    from agentvision.answer.cache import lifetime_stats
    from agentvision.index.db import connect

    answer = answer_question(indexed, "when does the moving test pattern start?", use_cache=False)
    conn = connect()
    try:
        scenes = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (indexed,)
        ).fetchone()["n"]
    finally:
        conn.close()
    naive_floor = scenes * est_frame_tokens()
    assert answer.tokens_saved_estimate <= naive_floor + len(answer.text)
    assert answer.tokens_spent_estimate > 0
    stats = lifetime_stats()
    assert stats["tokens_saved_total"] >= answer.tokens_saved_estimate
    assert stats["answers_count"] >= 1


# ---- index augmentation -------------------------------------------------------

def test_augment_video_adds_without_deleting(indexed: str) -> None:
    from agentvision.index.db import connect
    from agentvision.index.store import augment_video
    from agentvision.perceive.types import OcrBlock

    class FakeFrame:
        def __init__(self, tmp: Path):
            self.scene_id = 99
            self.timestamp_seconds = 2.0
            self.path = tmp
            self.phash = "00"
            self.ocr_blocks = [
                OcrBlock(text="ESCALATION FOUND ME", bbox=(1, 2, 3, 4), confidence=0.9)
            ]

    class FakePerception:
        def __init__(self, tmp: Path):
            self.frames = [FakeFrame(tmp)]

    conn = connect()
    before = conn.execute(
        "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (indexed,)
    ).fetchone()["n"]
    conn.close()

    added = augment_video(indexed, FakePerception(Path("esc_frame.jpg")))
    assert added == 1

    conn = connect()
    try:
        after = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ?", (indexed,)
        ).fetchone()["n"]
        ocr = conn.execute(
            "SELECT text FROM ocr_blocks WHERE video_id = ? AND text = 'ESCALATION FOUND ME'",
            (indexed,),
        ).fetchone()
    finally:
        conn.close()
    assert after == before + 1
    assert ocr is not None
