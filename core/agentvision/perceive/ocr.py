"""OCR on kept frames via RapidOCR (onnxruntime) — no system Tesseract needed."""
from __future__ import annotations

from pathlib import Path

from agentvision.errors import PerceptionError
from agentvision.perceive.types import OcrBlock

_engine = None


def _get_engine():
    """Lazy singleton — RapidOCR loads ONNX models on first construction."""
    global _engine
    if _engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR  # noqa: PLC0415
        except ImportError as exc:
            raise PerceptionError(
                "RapidOCR is not installed",
                code="perceive.missing_dependency",
                fix='install the OCR extra: `uv sync --extra ocr` or `pip install "agentvision[ocr]"`',
            ) from exc
        _engine = RapidOCR()
    return _engine


def ocr_frame(image_path: Path, min_confidence: float = 0.5) -> list[OcrBlock]:
    """Extract text blocks from one frame. Empty list when nothing is legible."""
    engine = _get_engine()
    result, _ = engine(str(image_path))
    blocks: list[OcrBlock] = []
    for entry in result or []:
        box, text, score = entry[0], str(entry[1]), float(entry[2])
        if score < min_confidence or not text.strip():
            continue
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        blocks.append(
            OcrBlock(
                text=text.strip(),
                bbox=(min(xs), min(ys), max(xs), max(ys)),
                confidence=round(score, 3),
            )
        )
    return blocks
