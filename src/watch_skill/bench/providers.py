"""`watch-skill bench providers` — read the same frames with every vision
provider you hold a key for, and print what each one actually cost, took,
and got right.

Sixteen providers is a menu, not an answer. The question a user has is
"which one should I point this at", and the honest way to settle it is to
send identical inputs to each and publish the table.

Method, so the numbers mean something:

* The inputs are the committed perception fixtures — rendered ground truth
  in code, subtitles, Arabic, CJK, Lao, and one mixed-script frame. No
  private media, nothing that can drift.
* The metric is the same char-hit rate the perception bench uses: what
  share of the truth's characters came back, as a multiset, so word order
  cannot hide a missing character.
* Cost comes from the provider's reported token usage multiplied by
  `prices.json`. When a provider does not report usage the cost column
  reads `-` rather than a guess.
* Only providers with a configured key are attempted. A provider that is
  not configured is skipped and named, never silently dropped.
"""
from __future__ import annotations

import platform
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from watch_skill.index.textnorm import normalize_for_search

# Reading text off a frame is the task where providers visibly differ, and
# it is checkable against ground truth — unlike "describe this scene".
READ_PROMPT = (
    "Transcribe every character of text visible in this image. "
    "Output only the text, no commentary, no translation."
)


@dataclass
class ProviderRun:
    """One provider against one fixture."""

    provider: str
    model: str
    fixture: str
    char_hit: float | None      # None = the call failed
    latency_s: float
    usd: float | None           # None = the provider reported no usage
    error: str | None = None


@dataclass
class ProviderReport:
    machine: str
    date: str
    runs: list[ProviderRun] = field(default_factory=list)
    skipped: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "machine": self.machine,
            "date": self.date,
            "runs": [asdict(r) for r in self.runs],
            "skipped": self.skipped,
        }


def char_hit_rate(truth: str, got: str) -> float:
    """Share of the truth's characters recovered, as a multiset."""
    want = Counter(normalize_for_search(truth).replace(" ", ""))
    have = Counter(normalize_for_search(got or "").replace(" ", ""))
    total = sum(want.values())
    if total == 0:
        return 1.0
    return sum(min(n, have[ch]) for ch, n in want.items()) / total


def configured_providers() -> tuple[list[str], dict[str, str]]:
    """Split the registry into (has a key, skipped with a reason)."""
    from watch_skill.config import get_settings
    from watch_skill.vision.registry import PROVIDERS

    settings = get_settings()
    ready: list[str] = []
    skipped: dict[str, str] = {}
    for name, spec in sorted(PROVIDERS.items()):
        if spec.key_setting is None:          # ollama and friends: keyless
            ready.append(name)
            continue
        value = getattr(settings, spec.key_setting, None)
        secret = value.get_secret_value() if hasattr(value, "get_secret_value") else value
        if secret and str(secret).strip():
            ready.append(name)
        else:
            skipped[name] = f"no key: set WATCHSKILL_{name.upper()}_API_KEY"
    return ready, skipped


def _usd_for(provider: str, model: str, usage: dict | None) -> float | None:
    """Reported input tokens × the dated price. No usage, no number."""
    if not usage:
        return None
    tokens = usage.get("prompt_tokens") or usage.get("input_tokens")
    if not tokens:
        return None
    from watch_skill.vision.registry import price_for

    return round(price_for(provider, model) * (int(tokens) / 1_000_000), 6)


def bench_providers(
    fixtures_dir: Path,
    providers: list[str] | None = None,
    model_for: dict[str, str] | None = None,
) -> ProviderReport:
    """Run every configured provider over the fixture set."""
    import json as _json

    from watch_skill.health.vision_setup import CLOUD_PROVIDER_DEFAULTS
    from watch_skill.vision.client import VisionClient

    truth = _json.loads((fixtures_dir / "fixtures.json").read_text(encoding="utf-8"))
    ready, skipped = configured_providers()
    if providers:
        wanted = set(providers)
        skipped = {k: v for k, v in skipped.items() if k in wanted}
        ready = [p for p in ready if p in wanted]

    report = ProviderReport(
        machine=f"{platform.platform()}",
        date=date.today().isoformat(),
        skipped=skipped,
    )

    for provider in ready:
        model = (model_for or {}).get(provider)
        if not model:
            defaults = CLOUD_PROVIDER_DEFAULTS.get(provider)
            model = defaults[1] if defaults else ""
        if not model:
            report.skipped[provider] = "no default model — pass --model"
            continue

        for name, meta in sorted(truth.items()):
            image = fixtures_dir / f"{name}.png"
            if not image.is_file():
                continue
            started = time.perf_counter()
            try:
                client = VisionClient(provider=provider, model=model)
                text = client.generate(READ_PROMPT, [image])
                usage = client.last_usage
                elapsed = time.perf_counter() - started
                report.runs.append(
                    ProviderRun(
                        provider=provider,
                        model=model,
                        fixture=name,
                        char_hit=char_hit_rate(meta["truth"], text),
                        latency_s=round(elapsed, 2),
                        usd=_usd_for(provider, model, usage),
                    )
                )
            except Exception as exc:  # one bad provider must not end the run
                report.runs.append(
                    ProviderRun(
                        provider=provider,
                        model=model,
                        fixture=name,
                        char_hit=None,
                        latency_s=round(time.perf_counter() - started, 2),
                        usd=None,
                        error=f"{type(exc).__name__}: {exc}"[:160],
                    )
                )
    return report


def render_markdown(report: ProviderReport) -> str:
    """The committed-results table, same shape as the other benches."""
    lines = [
        "# Vision provider benchmark",
        "",
        f"- Machine: {report.machine}",
        f"- Date: {report.date}",
        "- Task: transcribe all text in a frame; metric is char-hit rate "
        "(multiset recall of ground-truth characters)",
        "- Cost: the provider's own reported input tokens x the dated price "
        "in `src/watch_skill/vision/prices.json`",
        "",
    ]
    if report.runs:
        lines += [
            "| provider | model | fixture | char-hit | latency (s) | USD |",
            "|---|---|---|---|---|---|",
        ]
        for r in report.runs:
            hit = "failed" if r.char_hit is None else f"{r.char_hit:.0%}"
            usd = "-" if r.usd is None else f"{r.usd:.6f}"
            lines.append(
                f"| {r.provider} | {r.model} | {r.fixture} | {hit} | {r.latency_s} | {usd} |"
            )
        failures = [r for r in report.runs if r.error]
        if failures:
            lines += ["", "Failures:", ""]
            lines += [f"- `{r.provider}` / {r.fixture}: {r.error}" for r in failures]
    else:
        lines.append("_No provider ran: none of the sixteen had a key configured._")

    if report.skipped:
        lines += ["", "Skipped:", ""]
        lines += [f"- `{name}` — {why}" for name, why in sorted(report.skipped.items())]
    return "\n".join(lines) + "\n"
