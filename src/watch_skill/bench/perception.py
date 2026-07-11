"""`watch-skill bench perception` — char-hit rate, latency, peak RSS per
OCR backend (and optionally the local vision provider) over the committed
fixture set in benchmarks/perception/fixtures/.

The metric is char-hit rate: what fraction of the ground truth's
characters (spaces ignored, search-normalized) the backend actually
recovered, as a multiset — order mistakes don't mask missing characters.
"""
from __future__ import annotations

import ctypes
import json
import platform
import sys
import time
from collections import Counter
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from watch_skill.index.textnorm import normalize_for_search


def _peak_rss_mb() -> float:
    """Process peak working set in MB (cumulative since process start)."""
    if sys.platform == "win32":
        class PMC(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        kernel32 = ctypes.windll.kernel32
        getter = getattr(kernel32, "K32GetProcessMemoryInfo", None)
        if getter is None:
            getter = ctypes.windll.psapi.GetProcessMemoryInfo
        handle = ctypes.c_void_p(kernel32.GetCurrentProcess())
        if not getter(handle, ctypes.byref(pmc), pmc.cb):
            return 0.0
        return pmc.PeakWorkingSetSize / (1024 * 1024)
    import resource  # noqa: PLC0415

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def char_hit_rate(truth: str, prediction: str) -> float:
    """Multiset fraction of ground-truth chars recovered (normalized)."""
    want = Counter(normalize_for_search(truth).replace(" ", ""))
    got = Counter(normalize_for_search(prediction).replace(" ", ""))
    total = sum(want.values())
    if not total:
        return 0.0
    hit = sum(min(count, got[ch]) for ch, count in want.items())
    return hit / total


# fixture name → language hints for the router / script engines
_FIXTURE_LANGS: dict[str, list[str]] = {
    "screen_text": [], "subtitles": [], "cjk": [],
    "arabic_rtl": ["ar"], "sea_lao": ["lo"],
    "mixed_script": ["ar", "zh", "lo"],
}


def _backends() -> dict[str, Callable[[Path, str], str]]:
    """name → callable(image, fixture_name) -> recognized text."""
    from watch_skill.perceive.ocr import ocr_frame
    from watch_skill.perceive.ocr_backends import (
        _tesseract_binary,
        ocr_frame_multiscript,
        ocr_frame_tesseract,
    )

    def rapidocr_default(image: Path, name: str) -> str:
        lang = (_FIXTURE_LANGS.get(name) or [None])[0]
        blocks = ocr_frame(image, min_confidence=0.3, lang=lang if lang != "lo" else None)
        return " ".join(b.text for b in blocks)

    def router(image: Path, name: str) -> str:
        blocks = ocr_frame_multiscript(image, langs=_FIXTURE_LANGS.get(name, []), min_confidence=0.3)
        return " ".join(b.text for b in blocks)

    backends: dict[str, Callable[[Path, str], str]] = {
        "rapidocr": rapidocr_default,
        "router (multi-script)": router,
    }
    try:
        _tesseract_binary()

        def tesseract(image: Path, name: str) -> str:
            langs = _FIXTURE_LANGS.get(name) or ["en"]
            blocks = ocr_frame_tesseract(image, langs[0], min_confidence=0.3)
            return " ".join(b.text for b in blocks)

        backends["tesseract"] = tesseract
    except Exception:  # noqa: BLE001 — binary absent: the table will say so
        pass
    return backends


def _vision_backend() -> Callable[[Path, str], str] | None:
    """The cheap-tier vision model as a text reader, when reachable."""
    try:
        from watch_skill.vision import get_vision

        model = get_vision("cheap")

        def describe(image: Path, name: str) -> str:
            texts = model.describe_frames([image])
            return texts[0] if texts else ""

        return describe
    except Exception:  # noqa: BLE001
        return None


def bench_perception(
    fixtures_dir: Path, include_vision: bool = False
) -> tuple[str, list[dict[str, Any]]]:
    """Run the bench; returns (markdown_report, raw_rows)."""
    truths = json.loads((fixtures_dir / "fixtures.json").read_text(encoding="utf-8"))
    backends = _backends()
    if include_vision:
        vision = _vision_backend()
        if vision is not None:
            from watch_skill.config import get_settings

            settings = get_settings()
            backends[f"vision ({settings.vision_cheap_provider}:{settings.vision_cheap_model})"] = vision

    rows: list[dict[str, Any]] = []
    for backend_name, run in backends.items():
        for fixture, meta in truths.items():
            image = fixtures_dir / f"{fixture}.png"
            start = time.monotonic()
            try:
                prediction = run(image, fixture)
                error = None
            except Exception as exc:  # noqa: BLE001 — a failing backend is a result
                prediction, error = "", f"{type(exc).__name__}"
            rows.append({
                "backend": backend_name, "fixture": fixture,
                "char_hit": round(char_hit_rate(meta["truth"], prediction), 3),
                "latency_s": round(time.monotonic() - start, 2),
                "peak_rss_mb": round(_peak_rss_mb(), 0),
                "error": error, "prediction": prediction[:120],
            })

    lines = [
        "# Perception benchmark",
        "",
        f"- Machine: {platform.platform()}, 8 GB RAM, CPU-only",
        f"- Date: {date.today().isoformat()}",
        "- Metric: char-hit rate (normalized multiset recall of ground-truth chars)",
        "- Peak RSS is process-wide and cumulative — read it as 'high-water mark by then'",
        "",
        "| backend | fixture | char-hit | latency (s) | peak RSS (MB) |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        hit = f"{row['char_hit']:.0%}" if not row["error"] else f"error: {row['error']}"
        lines.append(
            f"| {row['backend']} | {row['fixture']} | {hit} | "
            f"{row['latency_s']} | {row['peak_rss_mb']:.0f} |"
        )
    if "tesseract" not in backends:
        lines += ["", "tesseract: not installed on this machine at bench time — "
                  "the sea_lao row above is the RapidOCR reading gap the fallback exists for."]
    return "\n".join(lines), rows
