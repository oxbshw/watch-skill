"""OCR on kept frames via RapidOCR (ONNX Runtime) — no system Tesseract needed.

RapidOCR ships per-script recognition models and downloads the right one on
first use into ``<data_dir>/models/ocr/`` (managed like our binaries, so the
doctor can see them). ``ocr_lang="auto"`` picks the model from the video's
detected language, so an Arabic video gets Arabic OCR without any flag.

The default PP-OCRv6 ``multi`` recognizer covers Latin scripts (accents
included), Chinese, and Japanese. Scripts it cannot read route to a
dedicated model; the (ocr_version, det) combos below were picked by a
rendered-ground-truth benchmark on real images — see docs/DECISIONS.md.
"""
from __future__ import annotations

from pathlib import Path

from watch_skill.config import get_settings
from watch_skill.errors import PerceptionError
from watch_skill.perceive.types import OcrBlock

_engines: dict[str, object] = {}

# ISO 639-1 code → script model key. Languages sharing a script map to the
# same model. Everything absent (en, zh, ja, es, fr, de, …) reads correctly
# with the bundled default multilingual recognizer.
_LANG_TO_SCRIPT: dict[str, str] = {
    "ar": "arabic", "fa": "arabic", "ur": "arabic", "ug": "arabic", "ku": "arabic",
    "ru": "eslav", "uk": "eslav", "be": "eslav",
    "bg": "cyrillic", "sr": "cyrillic", "mk": "cyrillic",
    "kk": "cyrillic", "ky": "cyrillic", "tg": "cyrillic", "mn": "cyrillic",
    "hi": "devanagari", "mr": "devanagari", "ne": "devanagari", "sa": "devanagari",
    "ko": "korean", "th": "th", "el": "el", "ta": "ta", "te": "te", "ka": "ka",
}


def resolve_ocr_lang(lang: str | None) -> str:
    """Map a requested/detected language onto an available OCR engine key."""
    if not lang:
        return "default"
    key = lang.split("-")[0].lower()
    return _LANG_TO_SCRIPT.get(key, "default")


def _script_params(script: str) -> dict:
    """RapidOCR params for one script model (benchmarked combos)."""
    from rapidocr.utils.typings import (  # noqa: PLC0415
        LangDet,
        LangRec,
        ModelType,
        OCRVersion,
    )

    # Arabic: the v5 recognizer returns visually-ordered (reversed) text;
    # v4 + the multilingual detector read 100% of the benchmark chars.
    # Korean: the default detector missed half the line; multi det fixed it.
    multi_det = {
        "Det.lang_type": LangDet.MULTI,
        "Det.ocr_version": OCRVersion.PPOCRV4,
        "Det.model_type": ModelType.MOBILE,
    }
    v4 = {"Rec.ocr_version": OCRVersion.PPOCRV4, "Rec.model_type": ModelType.MOBILE}
    v5 = {"Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE}
    table: dict[str, dict] = {
        "arabic": {"Rec.lang_type": LangRec.ARABIC, **v4, **multi_det},
        "eslav": {"Rec.lang_type": LangRec.ESLAV, **v5},
        "cyrillic": {"Rec.lang_type": LangRec.CYRILLIC, **v5},
        "devanagari": {"Rec.lang_type": LangRec.DEVANAGARI, **v5},
        "korean": {"Rec.lang_type": LangRec.KOREAN, **v5, **multi_det},
        "th": {"Rec.lang_type": LangRec.TH, **v5},
        "el": {"Rec.lang_type": LangRec.EL, **v5},
        "ta": {"Rec.lang_type": LangRec.TA, **v5},
        "te": {"Rec.lang_type": LangRec.TE, **v5},
        "ka": {"Rec.lang_type": LangRec.KA, **v4},
    }
    return table[script]


def _get_engine(lang: str = "default"):
    """Lazy per-language engine cache — models load once per process."""
    if lang in _engines:
        return _engines[lang]
    try:
        from rapidocr import RapidOCR  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "RapidOCR is not installed",
            code="perceive.missing_dependency",
            fix='install the OCR extra: `uv sync --extra ocr` or `pip install "watch-skill[ocr]"`',
        ) from exc
    models_dir = get_settings().data_dir / "models" / "ocr"
    params: dict[str, object] = {
        "Global.model_root_dir": str(models_dir),
        "Global.log_level": "warning",  # keep MCP stdio clean
    }
    if lang != "default":
        params.update(_script_params(lang))
    try:
        _engines[lang] = RapidOCR(params=params)
    except Exception as exc:
        raise PerceptionError(
            f"could not initialize the {lang} OCR engine: {exc}",
            code="perceive.ocr_model_download_failed",
            fix=f"check network access (models auto-download to {models_dir}), "
            "or retry with ocr_lang=None for the bundled default model",
        ) from exc
    return _engines[lang]


def ocr_frame(
    image_path: Path, min_confidence: float = 0.5, lang: str | None = None
) -> list[OcrBlock]:
    """Extract text blocks from one frame. Empty list when nothing is legible.

    ``lang`` selects a script-specific recognition model when one is
    available (Arabic, Cyrillic, Devanagari, Korean, and more); anything
    else — including Latin scripts, Chinese, and Japanese — uses the bundled
    multilingual model.
    """
    engine = _get_engine(resolve_ocr_lang(lang))
    result = engine(str(image_path))
    if result is None or not getattr(result, "txts", None):
        return []
    blocks: list[OcrBlock] = []
    for box, text, score in zip(result.boxes, result.txts, result.scores, strict=False):
        text = str(text)
        score = float(score)
        if score < min_confidence or not text.strip():
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        blocks.append(
            OcrBlock(
                text=text.strip(),
                bbox=(min(xs), min(ys), max(xs), max(ys)),
                confidence=round(score, 3),
            )
        )
    return blocks
