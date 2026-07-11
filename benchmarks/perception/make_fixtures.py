"""Render the committed perception fixtures + their ground truth.

Run once (on a machine with the Windows font set) to regenerate
benchmarks/perception/fixtures/. The PNGs are committed, so running the
bench needs no fonts and no text-shaping libraries — only generation
does. Arabic is shaped with `arabic_reshaper` + `python-bidi` (PIL has
no RAQM here); install the reshaper ad hoc (`uv pip install
arabic-reshaper`) — it is deliberately NOT a project dependency.

Run:  uv run --no-sync python benchmarks/perception/make_fixtures.py
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"

_FONTS = {
    "mono": "consola.ttf",
    "ui": "arial.ttf",
    "arabic": "ARIALUNI.TTF",
    "cjk": "msyh.ttc",  # falls back below if absent
    "lao": "LeelawUI.ttf",
    "myanmar": "mmrtext.ttf",
}


def _font(kind: str, size: int):
    candidates = [_FONTS[kind]]
    if kind == "cjk":
        candidates += ["msjh.ttc", "meiryo.ttc", "MEIRYO.TTC", "simsun.ttc"]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    raise SystemExit(f"no usable font for {kind!r} — regenerate on a machine that has one")


def _shape_arabic(text: str) -> str:
    import arabic_reshaper
    from bidi.algorithm import get_display

    return get_display(arabic_reshaper.reshape(text))


def main() -> int:
    FIXTURES.mkdir(exist_ok=True)
    truths: dict[str, dict] = {}

    def render(name: str, lines: list[tuple[str, str, int]], truth: str,
               size=(720, 240), bg=(24, 26, 33), fg=(235, 235, 235), note: str = "") -> None:
        img = Image.new("RGB", size, bg)
        draw = ImageDraw.Draw(img)
        y = 30
        for text, kind, px in lines:
            draw.text((28, y), text, fill=fg, font=_font(kind, px))
            y += int(px * 1.6)
        img.save(FIXTURES / f"{name}.png")
        truths[name] = {"truth": truth, "note": note}

    render(
        "screen_text",
        [("def cache_get(key: str) -> str | None:", "mono", 30),
         ("    return _store.get(key)  # TTL 300s", "mono", 30)],
        truth="def cache_get(key: str) -> str | None: return _store.get(key) # TTL 300s",
        note="code on a dark editor background",
    )
    render(
        "subtitles",
        [("The deploy finished at 9:15 PM.", "ui", 34)],
        truth="The deploy finished at 9:15 PM.",
        bg=(60, 62, 70),
        note="subtitle-style line",
    )
    arabic = "خطأ في الخادم رقم 502"
    render(
        "arabic_rtl",
        [(_shape_arabic(arabic), "arabic", 40)],
        truth=arabic,
        note="shaped + bidi-reordered render (arabic_reshaper + python-bidi)",
    )
    render(
        "cjk",
        [("缓存配置教程", "cjk", 40), ("キャッシュ設定", "cjk", 40)],
        truth="缓存配置教程 キャッシュ設定",
        note="Simplified Chinese + Japanese kana",
    )
    lao = "ສະບາຍດີ ໂລກ"
    render(
        "sea_lao",
        [(lao, "lao", 42)],
        truth=lao,
        note="Lao — RapidOCR has no recognizer for it (the reading gap)",
    )
    render(
        "mixed_script",
        [("watch_skill.serve(port=8747)", "mono", 28),
         (_shape_arabic("خطأ في الخادم"), "arabic", 34),
         ("缓存配置", "cjk", 34)],
        truth="watch_skill.serve(port=8747) خطأ في الخادم 缓存配置",
        note="one frame mixing code + Arabic UI + CJK slide",
    )

    (FIXTURES / "fixtures.json").write_text(
        json.dumps(truths, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"rendered {len(truths)} fixtures -> {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
