"""Bad arguments fail fast, with a fix, before any expensive work.

Both cases here were found by driving the CLI by hand rather than by a
failing test: neither raised, so neither was caught.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.acquire import acquire
from watch_skill.errors import AcquisitionError, PerceptionError
from watch_skill.watch import watch


@pytest.mark.parametrize("budget", [0, -1, -5])
def test_a_frame_budget_below_one_is_rejected(budget: int, tmp_path: Path) -> None:
    """0 and negatives used to clamp to a single frame silently.

    The report then looked normal — "1 kept from 1 candidates" — so a typo
    produced a confident answer built from one frame instead of an error.
    """
    with pytest.raises(PerceptionError) as exc:
        watch("does-not-matter.mp4", max_frames=budget)
    assert exc.value.code == "perceive.bad_budget"
    assert "at least 1" in str(exc.value)


def test_the_budget_is_checked_before_the_source_is_touched() -> None:
    """A bad budget must not cost a download.

    The source here does not exist; a budget error proves validation ran
    before acquisition rather than after it.
    """
    with pytest.raises(PerceptionError) as exc:
        watch("https://example.invalid/never-fetched.mp4", max_frames=0)
    assert exc.value.code == "perceive.bad_budget"


def test_a_directory_says_so_and_points_at_batch(tmp_path: Path) -> None:
    """It reported "file not found" for a path that plainly exists."""
    with pytest.raises(AcquisitionError) as exc:
        acquire(str(tmp_path))
    assert exc.value.code == "acquire.is_a_directory"
    assert "batch" in (exc.value.fix or ""), "the fix should name the command that handles folders"


def test_a_missing_file_still_reports_not_found(tmp_path: Path) -> None:
    """The directory branch must not swallow the ordinary case."""
    with pytest.raises(AcquisitionError) as exc:
        acquire(str(tmp_path / "absent.mp4"))
    assert exc.value.code == "acquire.file_not_found"
