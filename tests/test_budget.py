"""Frame budgets: reference-inherited tiers, 2 fps cap, time parsing."""
from __future__ import annotations

import pytest

from agentvision.perceive.budget import focused_budget, format_time, full_budget, parse_time


def test_full_budget_tiers() -> None:
    assert full_budget(10)[1] == 12  # short floor
    assert full_budget(30)[1] == 30
    assert full_budget(45)[1] == 40
    assert full_budget(120)[1] == 60
    assert full_budget(400)[1] == 80
    assert full_budget(3600)[1] == 100  # cap


def test_full_budget_respects_explicit_cap() -> None:
    fps, target = full_budget(3600, max_frames=40)
    assert target == 40


def test_fps_never_exceeds_two() -> None:
    fps, _ = full_budget(1)
    assert fps <= 2.0
    fps, _ = focused_budget(1)
    assert fps <= 2.0


def test_focused_budget_denser_than_full() -> None:
    for duration in (5, 15, 30, 60):
        assert focused_budget(duration)[1] >= full_budget(duration)[1]


def test_focused_tiers() -> None:
    assert focused_budget(5)[1] == 10  # 2 fps cap: 5s * 2 = 10
    assert focused_budget(30)[1] == 60
    assert focused_budget(60)[1] == 80
    assert focused_budget(300)[1] == 100


@pytest.mark.parametrize(
    ("value", "expected"),
    [("90", 90.0), ("1:30", 90.0), ("01:02:03", 3723.0), ("2:15.5", 135.5), (75, 75.0), (None, None), ("", None)],
)
def test_parse_time(value, expected) -> None:
    assert parse_time(value) == expected


def test_parse_time_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        parse_time("abc")


def test_format_time() -> None:
    assert format_time(75) == "01:15"
    assert format_time(3723) == "1:02:03"
    assert format_time(0) == "00:00"
