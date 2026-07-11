# Perception benchmark

Committed fixtures, committed results, one command to re-run:

```powershell
uv run --no-sync watch-skill bench perception [--vision] [--write RESULTS.md]
```

The fixtures (`fixtures/`) are rendered ground truth: screen text (code),
subtitles, shaped Arabic RTL, CJK, Lao, and one frame mixing code +
Arabic + CJK. `make_fixtures.py` regenerates them; the PNGs are
committed so the bench itself needs no fonts or shaping libraries.

Current results: [RESULTS.md](RESULTS.md). How to read them:

- **rapidocr** rows use the language hint the pipeline would pass for a
  single-language video — on a pure-Arabic frame that dedicated engine
  is the right tool, and the router does not replace it.
- **router (multi-script)** is for frames no single engine reads: on the
  mixed code + Arabic + CJK fixture it reads 98% where the best single
  engine stops at 81%. Each candidate script engine reads the full frame
  and regions merge by overlap, gated on the engine finding its OWN
  script there — cross-engine confidences don't compare, script share
  does. (The first router design re-recognized cropped regions and
  measured WORSE than no routing; the numbers are why it was rebuilt.)
- **sea_lao at 0%** is the RapidOCR reading gap (no Lao/Khmer/Myanmar/
  Tibetan recognizer ships with rapidocr 3.9.1 — audited against its
  LangRec enum). The tesseract fallback exists exactly for these rows;
  it was not installed on the reference machine at bench time (the
  installer needs elevation), so its rows are absent rather than
  invented.
- **vision (moondream)** is not an OCR engine and the table shows why it
  cannot replace one: strong on plain English text, 18% on Arabic, 0% on
  CJK — while OCR reads both. This is the measured argument for layered
  perception.

PP-OCR generation audit (2026-07-05, re-checked 2026-07-11): rapidocr
3.9.1 ships PP-OCRv4/v5 ONNX per script; the (rec, det) combos pinned in
`perceive/ocr.py` were chosen by char-hit rate on rendered ground truth —
see docs/DECISIONS.md for the per-script numbers.
