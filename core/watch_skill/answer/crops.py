"""Zoom crops: re-read small on-screen text at 2x from high-res frames.

Region detection is OCR's own box output — wherever the full-frame pass saw
*something*, the crop pass looks closer. No model calls.
"""
from __future__ import annotations

from pathlib import Path

from watch_skill.errors import PerceptionError
from watch_skill.perceive.ocr import ocr_frame
from watch_skill.perceive.types import OcrBlock

_PAD_FRACTION = 0.15
_UPSCALE = 2
_MIN_CROP_PX = 24
_MAX_CROPS_PER_FRAME = 6


def crop_and_reocr(frame_path: Path, lang: str | None = None) -> list[OcrBlock]:
    """OCR the frame, crop each detected region padded + upscaled, re-OCR.

    Returns blocks recovered from the crops whose confidence beats the
    original full-frame reading (or that the full frame missed entirely).
    Coordinates are mapped back to full-frame space.
    """
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError as exc:
        raise PerceptionError(
            "Pillow is required for zoom crops",
            code="perceive.missing_dependency",
            fix='install the perceive extra: `uv sync --extra perceive`',
        ) from exc

    full_blocks = ocr_frame(frame_path, min_confidence=0.2, lang=lang)
    if not full_blocks:
        return []

    recovered: list[OcrBlock] = []
    with Image.open(frame_path) as img:
        width, height = img.size
        for block in full_blocks[:_MAX_CROPS_PER_FRAME]:
            x1, y1, x2, y2 = block.bbox
            pad_x = max(_MIN_CROP_PX, (x2 - x1) * _PAD_FRACTION)
            pad_y = max(_MIN_CROP_PX, (y2 - y1) * _PAD_FRACTION)
            left = max(0, int(x1 - pad_x))
            top = max(0, int(y1 - pad_y))
            right = min(width, int(x2 + pad_x))
            bottom = min(height, int(y2 + pad_y))
            if right - left < _MIN_CROP_PX or bottom - top < _MIN_CROP_PX:
                continue
            crop = img.crop((left, top, right, bottom))
            crop = crop.resize((crop.width * _UPSCALE, crop.height * _UPSCALE))
            crop_path = frame_path.with_name(
                f"{frame_path.stem}_crop_{left}_{top}{frame_path.suffix}"
            )
            crop.save(crop_path)
            for crop_block in ocr_frame(crop_path, min_confidence=0.5, lang=lang):
                if crop_block.confidence <= block.confidence and crop_block.text == block.text:
                    continue  # nothing new learned
                cx1, cy1, cx2, cy2 = crop_block.bbox
                recovered.append(
                    OcrBlock(
                        text=crop_block.text,
                        bbox=(
                            left + cx1 / _UPSCALE,
                            top + cy1 / _UPSCALE,
                            left + cx2 / _UPSCALE,
                            top + cy2 / _UPSCALE,
                        ),
                        confidence=crop_block.confidence,
                    )
                )
    return recovered
