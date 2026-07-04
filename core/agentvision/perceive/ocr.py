"""OCR on kept frames via RapidOCR (onnxruntime) — no system Tesseract needed.

The bundled RapidOCR models read Latin + Chinese. Other scripts need a
script-specific recognition model; we manage those like binaries: downloaded
once into ``<data_dir>/models/ocr/`` and cached. ``ocr_lang="auto"`` picks the
model from the video's detected language, so an Arabic video gets Arabic OCR
without any flag.
"""
from __future__ import annotations

import sys
from pathlib import Path

from agentvision.config import get_settings
from agentvision.errors import PerceptionError
from agentvision.perceive.types import OcrBlock

_engines: dict[str, object] = {}

# Script-specific recognition models (ONNX + charset dict), managed like
# portable binaries. Languages sharing a script map to the same model.
_REC_MODELS: dict[str, dict[str, str]] = {
    "ar": {
        "model": "https://huggingface.co/cycloneboy/arabic_PP-OCRv4_rec_infer/resolve/main/model.onnx",
        "dict": "https://huggingface.co/cycloneboy/arabic_PP-OCRv4_rec_infer/resolve/main/arabic_dict.txt",
        "model_file": "arabic_PP-OCRv4_rec_infer.onnx",
        "dict_file": "arabic_dict.txt",
    },
}
_SCRIPT_ALIASES = {"fa": "ar", "ur": "ar", "ug": "ar", "ku": "ar"}


def resolve_ocr_lang(lang: str | None) -> str:
    """Map a requested/detected language onto an available OCR engine key."""
    if not lang:
        return "default"
    key = lang.split("-")[0].lower()
    key = _SCRIPT_ALIASES.get(key, key)
    return key if key in _REC_MODELS else "default"


def _download(url: str, dest: Path) -> None:
    import httpx

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=120.0) as response:
        response.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in response.iter_bytes():
                fh.write(chunk)
    tmp.replace(dest)


def _rec_model_paths(lang: str) -> tuple[Path, Path]:
    """Local paths for a script-specific rec model, downloading on first use."""
    spec = _REC_MODELS[lang]
    models_dir = get_settings().data_dir / "models" / "ocr"
    model_path = models_dir / spec["model_file"]
    dict_path = models_dir / spec["dict_file"]
    for url_key, path in (("model", model_path), ("dict", dict_path)):
        if path.is_file() and path.stat().st_size > 0:
            continue
        print(f"[agentvision] downloading {lang} OCR model: {path.name}", file=sys.stderr)
        try:
            _download(spec[url_key], path)
        except Exception as exc:
            raise PerceptionError(
                f"could not download the {lang} OCR model: {exc}",
                code="perceive.ocr_model_download_failed",
                fix=f"check network access to huggingface.co, or place {path.name} "
                f"manually under {models_dir}",
            ) from exc
    return model_path, dict_path


def _get_engine(lang: str = "default"):
    """Lazy per-language engine cache — models load once per process."""
    if lang in _engines:
        return _engines[lang]
    try:
        from rapidocr_onnxruntime import RapidOCR  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "RapidOCR is not installed",
            code="perceive.missing_dependency",
            fix='install the OCR extra: `uv sync --extra ocr` or `pip install "agentvision[ocr]"`',
        ) from exc
    if lang == "default":
        _engines[lang] = RapidOCR()
    else:
        model_path, dict_path = _rec_model_paths(lang)
        _engines[lang] = RapidOCR(
            rec_model_path=str(model_path), rec_keys_path=str(dict_path)
        )
    return _engines[lang]


def ocr_frame(
    image_path: Path, min_confidence: float = 0.5, lang: str | None = None
) -> list[OcrBlock]:
    """Extract text blocks from one frame. Empty list when nothing is legible.

    ``lang`` selects a script-specific recognition model when one is
    available (currently: Arabic-script languages); anything else uses the
    bundled Latin+Chinese models.
    """
    engine = _get_engine(resolve_ocr_lang(lang))
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
