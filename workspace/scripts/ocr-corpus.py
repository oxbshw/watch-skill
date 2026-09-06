"""Generate the OCR ground-truth corpus, and run a real engine over it.

The corpus is *generated* rather than collected, and that is the point: every
sample's ground truth is the string that was drawn, so the truth is exact rather
than transcribed by somebody who might have made a mistake. It is also
versioned and deterministic — the same corpus every time, on any machine — which
is what makes two benchmark runs comparable.

What it deliberately includes is the material OCR is actually bad at, not the
material that flatters it: small type, low contrast, tight tracking, mixed
fonts, timestamps and identifiers where a single wrong character changes the
meaning, and scripts beyond Latin.

Nothing here decides whether a result is good. Thresholds live in
`ocr-qualification.ts` and were written long before this ran; this script only
measures.

Usage:
  python scripts/ocr-corpus.py                    generate and run
  python scripts/ocr-corpus.py --gen              generate only
  python scripts/ocr-corpus.py --out <dir>        write somewhere specific

`--out` defaults to the same place `scripts/lib/manual-paths.mjs` puts the rest
of the manual-QA material, so the Node benchmark reads what this wrote without
either side being told where that is. It used to be required, and package.json
passed `G:/watch-manual/ocr` -- a drive on one maintainer's machine.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

CORPUS_VERSION = 1

# Windows ships these; each is chosen for what it exercises rather than looks.
FONTS = {
    "ui": "C:/Windows/Fonts/segoeui.ttf",       # the face a UI is actually in
    "sans": "C:/Windows/Fonts/arial.ttf",       # the safe baseline
    "mono": "C:/Windows/Fonts/consola.ttf",     # identifiers and timestamps
    "arabic": "C:/Windows/Fonts/tahoma.ttf",    # a face with Arabic coverage
}

# id, text, font, size, foreground, background, tracking
# Contrast and size are the two variables that dominate OCR accuracy, so both
# are varied deliberately rather than left at a comfortable default.
SAMPLES = [
    ("clean-ui-en", "Settings saved successfully", "ui", 28, (20, 22, 27), (255, 255, 255), 0),
    ("clean-ui-dark", "Verification failed", "ui", 28, (240, 242, 246), (14, 16, 20), 0),
    ("small-text", "Last tested: never", "ui", 12, (40, 44, 52), (255, 255, 255), 0),
    ("tiny-text", "index rebuilt", "ui", 9, (40, 44, 52), (255, 255, 255), 0),
    ("low-contrast", "Not bound", "ui", 24, (150, 155, 162), (190, 194, 200), 0),
    ("very-low-contrast", "Degraded", "ui", 24, (168, 172, 178), (188, 192, 198), 0),
    ("error-code", "Installer reported error 0x80070643", "mono", 22, (200, 40, 40), (255, 255, 255), 0),
    ("timestamp", "2026-08-28T09:41:44.198Z", "mono", 20, (20, 22, 27), (255, 255, 255), 0),
    ("identifier", "session-b2c5e677-ce32-4eee", "mono", 18, (20, 22, 27), (255, 255, 255), 0),
    ("digest", "sha256:379eea916a3c20b5", "mono", 18, (20, 22, 27), (255, 255, 255), 0),
    ("mixed-case", "WATCH Workspace Verified", "sans", 26, (20, 22, 27), (255, 255, 255), 0),
    ("tracked-out", "S P A C E D  O U T", "sans", 24, (20, 22, 27), (255, 255, 255), 3),
    ("long-line", "The agent completed the task but verification could not confirm the row was written", "ui", 18, (20, 22, 27), (255, 255, 255), 0),
    ("numbers", "1049 tests 0 failures 37 providers", "mono", 22, (20, 22, 27), (255, 255, 255), 0),
    ("punctuation", "Agent completed != Verified.", "ui", 24, (20, 22, 27), (255, 255, 255), 0),
    # RapidOCR ships Chinese and English detection/recognition models. Arabic is
    # included anyway: measuring that an engine cannot read a script is a
    # result, and leaving it out would let "unsupported" pass for "untested".
    ("arabic", "تم حفظ الإعدادات", "arabic", 30, (20, 22, 27), (255, 255, 255), 0),
    ("arabic-mixed", "الخطأ 0x8007", "arabic", 28, (20, 22, 27), (255, 255, 255), 0),
    # Negative sample: nothing to read. An engine that returns text here is
    # hallucinating, which is worse than returning nothing.
    ("blank", "", "ui", 24, (255, 255, 255), (255, 255, 255), 0),
]


def generate(out: Path) -> list[dict]:
    from PIL import Image, ImageDraw, ImageFont

    images = out / "images"
    images.mkdir(parents=True, exist_ok=True)
    manifest = []

    for sample_id, text, font_key, size, fg, bg, tracking in SAMPLES:
        path = FONTS.get(font_key)
        try:
            font = ImageFont.truetype(path, size)
        except OSError:
            font = ImageFont.load_default()

        drawn = text if tracking == 0 else text
        width = max(320, int(size * (len(drawn) + 4) * 0.62))
        height = max(64, size * 3)
        image = Image.new("RGB", (width, height), bg)
        draw = ImageDraw.Draw(image)
        draw.text((20, height // 3), drawn, font=font, fill=fg)

        file = images / f"{sample_id}.png"
        image.save(file)
        manifest.append({
            "id": sample_id,
            "file": str(file).replace("\\", "/"),
            "expected": text,
            "font": font_key,
            "size": size,
            "script": "arabic" if font_key == "arabic" else "latin",
            "negative": text == "",
        })

    (out / "corpus.json").write_text(
        json.dumps({"version": CORPUS_VERSION, "samples": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def run(manifest: list[dict], out: Path) -> dict:
    try:
        from rapidocr import RapidOCR
    except ImportError as error:
        return {"engine": "rapidocr", "available": False, "reason": str(error), "results": []}

    engine = RapidOCR()
    results = []

    for sample in manifest:
        started = time.perf_counter()
        crashed = False
        text = ""
        try:
            output = engine(sample["file"])
            # The result shape differs between rapidocr releases; take whichever
            # of the two documented forms is present rather than guessing one.
            lines = getattr(output, "txts", None)
            if lines is None and isinstance(output, tuple):
                lines = [row[1] for row in (output[0] or [])]
            text = " ".join(lines) if lines else ""
        except Exception as error:  # noqa: BLE001 - a crash is a measurement
            crashed = True
            text = f"<crash: {error}>"
        elapsed = (time.perf_counter() - started) * 1000

        results.append({
            "id": sample["id"],
            "expected": sample["expected"],
            "actual": "" if crashed else text,
            "script": sample["script"],
            "negative": sample["negative"],
            "crashed": crashed,
            "ms": round(elapsed, 1),
        })

    return {
        "engine": "rapidocr",
        "available": True,
        "device": "cpu",
        "corpusVersion": CORPUS_VERSION,
        "results": results,
    }


def default_out() -> Path:
    """Where the manual-QA material lives, by the platform's own convention.

    Mirrors `manualPath('WATCH_OCR_DIR', ['ocr'])` in scripts/lib/manual-paths.mjs.
    """
    explicit = os.environ.get("WATCH_OCR_DIR")
    if explicit:
        return Path(explicit)
    root = os.environ.get("WATCH_MANUAL_ROOT")
    if root:
        return Path(root) / "ocr"
    if sys.platform == "win32":
        state = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        state = Path.home() / "Library" / "Application Support"
    else:
        state = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return state / "watch-manual" / "ocr"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None)
    parser.add_argument("--gen", action="store_true")
    args = parser.parse_args()

    out = Path(args.out) if args.out else default_out()
    out.mkdir(parents=True, exist_ok=True)
    manifest = generate(out)
    print(f"corpus: {len(manifest)} sample(s), version {CORPUS_VERSION}", flush=True)
    if args.gen:
        return 0

    measured = run(manifest, out)
    (out / "raw-results.json").write_text(
        json.dumps(measured, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    if not measured["available"]:
        print(f"engine unavailable: {measured['reason']}", flush=True)
        return 0
    print(f"ran {len(measured['results'])} sample(s) on cpu", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
