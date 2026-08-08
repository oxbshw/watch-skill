"""The provider benchmark reports what it measured, and nothing else.

A comparison table is only worth publishing if a row that was not run is
absent rather than guessed, and a cost is the provider's own number rather
than an estimate. These tests hold both.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.bench.providers import (
    ProviderReport,
    ProviderRun,
    bench_providers,
    char_hit_rate,
    configured_providers,
    render_markdown,
)

FIXTURES = Path(__file__).resolve().parents[2] / "benchmarks" / "perception" / "fixtures"


def test_char_hit_is_a_multiset_not_a_substring() -> None:
    """Scrambled order must not be scored as a miss, missing chars must."""
    assert char_hit_rate("abc", "cba") == 1.0
    assert char_hit_rate("abc", "ab") == pytest.approx(2 / 3)
    assert char_hit_rate("abc", "") == 0.0
    assert char_hit_rate("", "anything") == 1.0


def test_a_provider_without_a_key_is_named_not_dropped(monkeypatch) -> None:
    from watch_skill import config

    for var in ("ANTHROPIC", "OPENAI", "GEMINI", "GROQ", "OPENROUTER"):
        monkeypatch.delenv(f"WATCHSKILL_{var}_API_KEY", raising=False)
    monkeypatch.setenv("WATCHSKILL_GROQ_API_KEY", "gsk-test")
    config.reset_settings()

    ready, skipped = configured_providers()
    assert "groq" in ready
    assert "anthropic" in skipped
    assert "WATCHSKILL_ANTHROPIC_API_KEY" in skipped["anthropic"]
    # Keyless providers are runnable, not skipped for lacking a key.
    assert "ollama" in ready


def test_an_empty_run_says_so_instead_of_printing_a_table() -> None:
    report = ProviderReport(machine="test", date="2026-01-01", skipped={"groq": "no key"})
    out = render_markdown(report)
    assert "No provider ran" in out
    assert "|---|" not in out, "an empty benchmark must not render a results table"
    assert "`groq` — no key" in out


def test_a_provider_that_reports_no_usage_gets_a_dash_not_a_guess() -> None:
    report = ProviderReport(
        machine="test",
        date="2026-01-01",
        runs=[ProviderRun("groq", "m", "screen_text", 0.9, 1.2, None)],
    )
    row = [ln for ln in render_markdown(report).splitlines() if ln.startswith("| groq")][0]
    assert row.rstrip().endswith("| - |"), f"expected a dash for unknown cost: {row}"


def test_a_failed_call_is_reported_as_failed_not_as_zero_accuracy() -> None:
    """0% means the model read nothing; a crash means we learned nothing."""
    report = ProviderReport(
        machine="test",
        date="2026-01-01",
        runs=[ProviderRun("xai", "m", "cjk", None, 0.4, None, error="TimeoutError: slow")],
    )
    out = render_markdown(report)
    assert "failed" in out
    assert "TimeoutError" in out


@pytest.mark.skipif(not FIXTURES.is_dir(), reason="fixtures not generated")
def test_cost_comes_from_reported_tokens(monkeypatch) -> None:
    """1250 prompt tokens on a $0.4/Mtok provider is $0.0005, not an estimate."""
    import watch_skill.vision.client as client_mod
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_GROQ_API_KEY", "gsk-test")
    config.reset_settings()

    class FakeClient:
        def __init__(self, provider: str, model: str) -> None:
            self.last_usage = {"prompt_tokens": 1250}

        def generate(self, prompt: str, images: list[Path]) -> str:
            return "whatever the model saw"

    # bench_providers imports VisionClient inside the function, so the module
    # it imports from is the one seam that matters.
    monkeypatch.setattr(client_mod, "VisionClient", FakeClient)

    report = bench_providers(FIXTURES, providers=["groq"])
    assert report.runs, "no runs produced"
    for run in report.runs:
        assert run.usd == pytest.approx(0.4 * 1250 / 1_000_000)
        assert run.char_hit is not None
