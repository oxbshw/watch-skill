"""CLI surface promises that migrating users and packagers depend on.

`--version` and `--detail` both exist for people arriving from somewhere
else: `--version` is what a packaging smoke test reaches for, and `--detail`
is claude-video's vocabulary, kept so an existing command runs here unchanged.
"""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

from watch_skill import __version__
from watch_skill.surfaces.cli.main import app

runner = CliRunner()


def test_version_flag_prints_the_package_version() -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == __version__


def test_version_command_agrees_with_the_flag() -> None:
    assert runner.invoke(app, ["version"]).stdout == runner.invoke(app, ["--version"]).stdout


@pytest.mark.parametrize("preset", ["transcript", "efficient", "balanced", "token-burner"])
def test_detail_presets_are_accepted(preset: str) -> None:
    """Accepted means: not rejected as a bad value before any work starts.

    The run itself fails on the unreachable source, which is the point — we
    are asserting the argument parses, not that the network works.
    """
    result = runner.invoke(app, ["watch", "does-not-exist.mp4", "--detail", preset])
    assert "unknown --detail" not in result.stdout


def test_unknown_detail_preset_is_rejected_before_any_work() -> None:
    """Exit 2 is "you typed it wrong" — distinct from a runtime failure."""
    result = runner.invoke(app, ["watch", "does-not-exist.mp4", "--detail", "cinematic"])
    assert result.exit_code == 2
    # The diagnostic goes to stderr so stdout stays parseable for agents.
    assert "unknown --detail" in result.output
    assert "token-burner" in result.output


def _budget_for(argv: list[str], monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Run `watch` with the engine stubbed, returning the kwargs it received."""
    import watch_skill.watch as watch_mod

    seen: dict[str, object] = {}

    def fake_watch(source: str, **kwargs: object):
        seen.update(kwargs)
        raise SystemExit(0)

    monkeypatch.setattr(watch_mod, "watch", fake_watch)
    runner.invoke(app, argv)
    return seen


def test_explicit_max_frames_beats_the_preset(monkeypatch: pytest.MonkeyPatch) -> None:
    """--detail sets a budget; --max-frames is the user being specific."""
    seen = _budget_for(["watch", "x.mp4", "--detail", "efficient", "--max-frames", "7"], monkeypatch)
    assert seen["max_frames"] == 7


def test_balanced_sets_a_frame_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _budget_for(["watch", "x.mp4", "--detail", "balanced"], monkeypatch)
    assert seen["max_frames"] == 32
    assert seen["transcript_only"] is False


def test_transcript_preset_skips_frames_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _budget_for(["watch", "x.mp4", "--detail", "transcript"], monkeypatch)
    assert seen["transcript_only"] is True
