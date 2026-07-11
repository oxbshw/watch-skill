"""Pillar 3 — cost meter v2 and THE COST POLICY.

The meter must account for every token the answer path spends, split by
source, and the policy must actually change which model tiers a verify
pass may touch. All offline: verify stays disabled (no provider calls),
policy selection is tested as the unit it is.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.answer import answer_question  # noqa: E402
from watch_skill.answer.cache import record_spend, spend_stats  # noqa: E402
from watch_skill.answer.engine import _tiers_for_policy  # noqa: E402
from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.transcribe.types import Segment, Transcript  # noqa: E402
from watch_skill.vision.registry import MODEL_PRICES, price_for, price_table  # noqa: E402
from watch_skill.watch import watch  # noqa: E402


@pytest.fixture()
def indexed(sample_video: Path, tmp_path: Path) -> str:
    result = watch(
        str(sample_video), out_dir=tmp_path / "cost work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[Segment(0.5, 3.5, "the red warning screen appears first")],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


# ---- per-answer breakdown ---------------------------------------------------

def test_answer_carries_cost_breakdown(indexed: str) -> None:
    answer = answer_question(indexed, "what appears first?", verify=False, use_cache=False)
    assert answer.cost_breakdown, "fresh answers must say where the spend went"
    assert answer.cost_breakdown.get("text_first", 0) > 0
    assert sum(answer.cost_breakdown.values()) == answer.tokens_spent_estimate
    assert answer.cost_usd_estimate == 0.0  # no cloud call was made


def test_cached_answer_revives_without_breakdown_keys_breaking(indexed: str) -> None:
    first = answer_question(indexed, "what appears first?", verify=False)
    again = answer_question(indexed, "what appears first?", verify=False)
    assert again.cached
    assert again.text == first.text  # old-format cache entries revive fine too


# ---- lifetime meters --------------------------------------------------------

def test_record_spend_accumulates_by_source() -> None:
    record_spend({"text_first": 100, "local_escalation": 40, "vision_call": 0}, 0.0)
    record_spend({"text_first": 50, "vision_call": 900}, 0.0027)
    record_spend({"cache": 0}, 0.0)
    stats = spend_stats()
    assert stats["text_first"] == 150
    assert stats["local_escalation"] == 40
    assert stats["vision_call"] == 900
    assert stats["cache_hits"] == 1
    assert stats["usd_spent_total"] == pytest.approx(0.0027)


def test_answering_feeds_the_lifetime_meter(indexed: str) -> None:
    before = spend_stats()
    answer_question(indexed, "what shows up?", verify=False, use_cache=False)
    after = spend_stats()
    assert after["text_first"] > before["text_first"]


# ---- THE COST POLICY --------------------------------------------------------

def _settings(policy: str, cheap_provider: str = "anthropic", strong_provider: str = "anthropic"):
    return SimpleNamespace(
        cost_policy=policy,
        vision_cheap_provider=cheap_provider,
        vision_strong_provider=strong_provider,
    )


def test_cheapest_policy_stops_at_cheap_when_confident() -> None:
    assert _tiers_for_policy(_settings("cheapest"), confidence=0.9, target=0.6) == ["cheap"]


def test_cheapest_policy_adds_strong_when_unsure() -> None:
    assert _tiers_for_policy(_settings("cheapest"), confidence=0.2, target=0.6) == ["cheap", "strong"]


def test_quality_first_goes_straight_to_strong() -> None:
    assert _tiers_for_policy(_settings("quality_first"), confidence=0.9, target=0.6) == ["strong"]


def test_offline_only_filters_cloud_tiers_out() -> None:
    tiers = _tiers_for_policy(_settings("offline_only"), confidence=0.2, target=0.6)
    assert tiers == [], "both tiers are cloud providers — none may run"


def test_offline_only_keeps_local_tiers() -> None:
    tiers = _tiers_for_policy(
        _settings("offline_only", cheap_provider="ollama"), confidence=0.2, target=0.6
    )
    assert tiers == ["cheap"], "ollama is keyless/local — the cheap tier stays"


# ---- the price data file ----------------------------------------------------

def test_price_table_is_dated_and_feeds_price_for() -> None:
    table = price_table()
    assert table["as_of"] >= "2026-07-11"
    assert price_for("ollama", "moondream") == 0.0
    assert price_for("anthropic", "claude-sonnet-5") == 3.0
    # unknown model falls back to the provider default
    assert price_for("anthropic", "some-future-model") == 3.0


def test_model_prices_alias_stays_live() -> None:
    """Pre-v1.0 code mutated MODEL_PRICES directly; the alias must still
    be the same object price_for reads."""
    MODEL_PRICES["test-model-xyz"] = 42.0
    try:
        assert price_for("anthropic", "test-model-xyz") == 42.0
    finally:
        del MODEL_PRICES["test-model-xyz"]
