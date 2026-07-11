"""OCR backend registry — data, not code, mirroring the vision registry.

Three backends, honestly scoped:

- ``rapidocr`` (default) — PP-OCR ONNX models, no system install, covers
  Latin/CJK plus the script models in ``ocr.py``. Cannot read Lao, Khmer,
  Myanmar, or Tibetan: RapidOCR ships no recognizer for them (audited
  against rapidocr 3.9.1 — its ``LangRec`` enum ends at th/el/ta/te/ka).
- ``tesseract`` — auto-routed fallback ONLY for that reading gap. Needs
  the system binary plus the script's traineddata; both absences produce
  structured errors with the exact install command.
- ``surya`` — opt-in for stronger machines (transformer OCR, ~3 GB+ of
  weights; do not route to it implicitly on an 8 GB box).

Routing: ``resolve_backend(script)`` — explicit setting wins; ``auto``
means rapidocr for everything it can read, tesseract for the gap.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.errors import PerceptionError
from watch_skill.perceive.types import OcrBlock

# Scripts RapidOCR has NO recognizer for → ISO 639-1 → tesseract traineddata.
RAPIDOCR_GAP: dict[str, str] = {
    "lo": "lao",
    "km": "khm",
    "my": "mya",
    "bo": "bod",
}


@dataclass(frozen=True)
class OcrBackendSpec:
    """One OCR backend: what it is, when routing may pick it."""

    name: str
    kind: str  # onnx | system-binary | transformers
    auto_routable: bool  # may `auto` choose it without the user opting in
    note: str


OCR_BACKENDS: dict[str, OcrBackendSpec] = {
    "rapidocr": OcrBackendSpec(
        name="rapidocr", kind="onnx", auto_routable=True,
        note="default; PP-OCR v4/v5 ONNX per script (see ocr.py combos)",
    ),
    "tesseract": OcrBackendSpec(
        name="tesseract", kind="system-binary", auto_routable=True,
        note="fallback for the RapidOCR reading gap: Lao/Khmer/Myanmar/Tibetan",
    ),
    "surya": OcrBackendSpec(
        name="surya", kind="transformers", auto_routable=False,
        note="opt-in only — transformer OCR needs more RAM than an 8 GB box has",
    ),
}


def resolve_backend(lang: str | None) -> str:
    """Which backend reads this language, honoring the configured policy."""
    configured = getattr(get_settings(), "ocr_backend", "auto")
    if configured != "auto":
        return configured
    key = (lang or "").split("-")[0].lower()
    return "tesseract" if key in RAPIDOCR_GAP else "rapidocr"


def _tesseract_binary() -> str:
    path = shutil.which("tesseract")
    if path:
        return path
    for candidate in (
        Path("C:/Program Files/Tesseract-OCR/tesseract.exe"),
        Path.home() / "AppData/Local/Programs/Tesseract-OCR/tesseract.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    raise PerceptionError(
        "tesseract binary not found (needed only for Lao/Khmer/Myanmar/Tibetan)",
        code="perceive.tesseract_missing",
        fix="winget install UB-Mannheim.TesseractOCR (Windows) or "
        "`apt install tesseract-ocr` (Linux), then re-run",
    )


def tesseract_langs(binary: str | None = None) -> set[str]:
    """traineddata sets installed for the system tesseract."""
    binary = binary or _tesseract_binary()
    out = subprocess.run(
        [binary, "--list-langs"], capture_output=True, text=True, timeout=30,
    )
    return {line.strip() for line in out.stdout.splitlines() if line.strip() and ":" not in line}


_IOU_SAME_REGION = 0.5  # boxes overlapping this much are one region, competing


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def _script_share(text: str, script: str) -> float:
    """Fraction of the text's letters belonging to the engine's script —
    the calibration bridge between engines whose confidences don't
    compare. An Arabic engine's read of a code line is high-confidence
    garbage; its share of Arabic letters says so."""
    import unicodedata

    ranges = {
        "arabic": lambda ch: "؀" <= ch <= "ۿ" or "ݐ" <= ch <= "ݿ",
        "eslav": lambda ch: "Ѐ" <= ch <= "ӿ",
        "cyrillic": lambda ch: "Ѐ" <= ch <= "ӿ",
        "devanagari": lambda ch: "ऀ" <= ch <= "ॿ",
        "korean": lambda ch: "가" <= ch <= "힯" or "ᄀ" <= ch <= "ᇿ",
        "th": lambda ch: "฀" <= ch <= "๿",
        "el": lambda ch: "Ͱ" <= ch <= "Ͽ",
        "ta": lambda ch: "஀" <= ch <= "௿",
        "te": lambda ch: "ఀ" <= ch <= "౿",
        "ka": lambda ch: "Ⴀ" <= ch <= "ჿ",
    }
    check = ranges.get(script)
    letters = [ch for ch in text if unicodedata.category(ch).startswith("L")]
    if not letters or check is None:
        return 0.0
    return sum(1 for ch in letters if check(ch)) / len(letters)


def ocr_frame_multiscript(
    image_path: Path,
    langs: list[str],
    min_confidence: float = 0.5,
) -> list[OcrBlock]:
    """Per-REGION script routing for frames that mix writing systems.

    One frame can hold code, an Arabic UI, and a CJK slide at once; a
    single recognizer reads only its own script well. Each candidate
    script engine reads the FULL frame (detection needs context — crop
    re-reads measured worse), then regions merge by overlap: a script
    engine's read replaces the default's only when it actually produced
    its own script there (confidences across engines don't compare;
    script share does). Deterministic: same frame, same langs, same
    result.
    """
    from watch_skill.perceive.ocr import _get_engine, resolve_ocr_lang  # noqa: PLC0415

    def read(engine_key: str) -> list[tuple[tuple[float, float, float, float], str, float]]:
        result = _get_engine(engine_key)(str(image_path))
        if result is None or not getattr(result, "txts", None):
            return []
        out = []
        for box, text, score in zip(result.boxes, result.txts, result.scores, strict=False):
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            if str(text).strip():
                out.append(((min(xs), min(ys), max(xs), max(ys)), str(text).strip(), float(score)))
        return out

    candidate_scripts: list[str] = []
    gap_langs: list[str] = []
    for lang in langs:
        key = lang.split("-")[0].lower()
        if key in RAPIDOCR_GAP:
            gap_langs.append(key)
        else:
            script = resolve_ocr_lang(key)
            if script != "default" and script not in candidate_scripts:
                candidate_scripts.append(script)

    merged = [
        {"bbox": bbox, "text": text, "score": score}
        for bbox, text, score in read("default")
    ]
    for script in candidate_scripts:
        for bbox, text, score in read(script):
            share = _script_share(text, script)
            if share < 0.5:
                continue  # the engine did not find its own script here
            for region in merged:
                if _iou(region["bbox"], bbox) >= _IOU_SAME_REGION:
                    # same region: the script engine read actual script text
                    # where the default engine, by construction, could not
                    if _script_share(region["text"], script) < share:
                        region.update(text=text, score=score)
                    break
            else:
                merged.append({"bbox": bbox, "text": text, "score": score})

    for gap in gap_langs:
        try:
            gap_blocks = ocr_frame_tesseract(image_path, gap, min_confidence=0.0)
        except PerceptionError:
            continue  # binary/language data missing — the gap stays unread
        for gap_block in gap_blocks:
            for region in merged:
                if _iou(region["bbox"], gap_block.bbox) >= _IOU_SAME_REGION:
                    if not region["text"] or region["score"] < gap_block.confidence:
                        region.update(text=gap_block.text, score=gap_block.confidence)
                    break
            else:
                merged.append({
                    "bbox": gap_block.bbox, "text": gap_block.text,
                    "score": gap_block.confidence,
                })

    merged.sort(key=lambda r: (r["bbox"][1], r["bbox"][0]))
    return [
        OcrBlock(text=r["text"], bbox=r["bbox"], confidence=round(r["score"], 3))
        for r in merged
        if r["text"] and r["score"] >= min_confidence
    ]


def ocr_frame_surya(image_path: Path, min_confidence: float = 0.5) -> list[OcrBlock]:
    """Opt-in transformer OCR. Never auto-routed: the models want more RAM
    than the reference 8 GB machine has — set ``ocr_backend=surya`` only on
    hardware that can afford it."""
    try:
        from surya.detection import DetectionPredictor  # noqa: PLC0415
        from surya.recognition import RecognitionPredictor  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "surya is not installed (opt-in backend)",
            code="perceive.surya_missing",
            fix="pip install surya-ocr — and budget ~3 GB+ RAM for its models",
        ) from exc
    from PIL import Image  # noqa: PLC0415

    with Image.open(image_path) as img:
        predictions = RecognitionPredictor()([img.convert("RGB")], det_predictor=DetectionPredictor())
    blocks: list[OcrBlock] = []
    for line in predictions[0].text_lines:
        if line.confidence is not None and line.confidence < min_confidence:
            continue
        if not line.text.strip():
            continue
        x1, y1, x2, y2 = line.bbox
        blocks.append(OcrBlock(
            text=line.text.strip(), bbox=(float(x1), float(y1), float(x2), float(y2)),
            confidence=round(float(line.confidence or 0.0), 3),
        ))
    return blocks


def ocr_frame_tesseract(
    image_path: Path, lang: str, min_confidence: float = 0.5
) -> list[OcrBlock]:
    """Read one frame with tesseract for a gap script; block-level output.

    Uses TSV output (no pytesseract dependency): word boxes with
    confidences, merged per line."""
    traineddata = RAPIDOCR_GAP.get(lang.split("-")[0].lower(), lang)
    binary = _tesseract_binary()
    if traineddata not in tesseract_langs(binary):
        raise PerceptionError(
            f"tesseract has no '{traineddata}' language data installed",
            code="perceive.tesseract_lang_missing",
            fix=f"download {traineddata}.traineddata from "
            "https://github.com/tesseract-ocr/tessdata and place it in the "
            "tesseract tessdata directory",
        )
    out = subprocess.run(
        [binary, str(image_path), "stdout", "-l", traineddata, "tsv"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
    )
    if out.returncode != 0:
        raise PerceptionError(
            f"tesseract failed on {image_path.name}: {out.stderr.strip()[:200]}",
            code="perceive.tesseract_failed",
            fix="run `tesseract --version` to check the install; re-run doctor",
        )
    lines: dict[tuple[int, int, int], list[dict]] = {}
    header: list[str] | None = None
    for row in out.stdout.splitlines():
        cells = row.split("\t")
        if header is None:
            header = cells
            continue
        if len(cells) != len(header):
            continue
        rec = dict(zip(header, cells, strict=False))
        text = rec.get("text", "").strip()
        conf = float(rec.get("conf", -1))
        if not text or conf < 0:
            continue
        key = (int(rec["block_num"]), int(rec["par_num"]), int(rec["line_num"]))
        lines.setdefault(key, []).append(
            {"text": text, "conf": conf / 100.0,
             "x": float(rec["left"]), "y": float(rec["top"]),
             "w": float(rec["width"]), "h": float(rec["height"])}
        )
    blocks: list[OcrBlock] = []
    for words in lines.values():
        confidence = sum(w["conf"] for w in words) / len(words)
        if confidence < min_confidence:
            continue
        xs = [w["x"] for w in words] + [w["x"] + w["w"] for w in words]
        ys = [w["y"] for w in words] + [w["y"] + w["h"] for w in words]
        blocks.append(OcrBlock(
            text=" ".join(w["text"] for w in words),
            bbox=(min(xs), min(ys), max(xs), max(ys)),
            confidence=round(confidence, 3),
        ))
    return blocks
