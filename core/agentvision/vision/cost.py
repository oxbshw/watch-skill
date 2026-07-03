"""Pre-call cost guard: estimate image tokens BEFORE any cloud vision call."""
from __future__ import annotations

from pathlib import Path

from agentvision.config import get_settings
from agentvision.errors import VisionError
from agentvision.vision.registry import price_for

TOKENS_PER_PIXEL_DIVISOR = 750  # Anthropic's (w*h)/750 — a fair cross-provider proxy
TEXT_TOKEN_ALLOWANCE = 2000     # prompt + context headroom per call


def image_dimensions(path: Path) -> tuple[int, int]:
    """(width, height) of an image file."""
    from PIL import Image  # noqa: PLC0415

    with Image.open(path) as img:
        return img.size


def estimate_call_tokens(image_paths: list[Path]) -> int:
    """Estimated input tokens for one call carrying these images."""
    total = TEXT_TOKEN_ALLOWANCE
    for path in image_paths:
        width, height = image_dimensions(path)
        total += (width * height) // TOKENS_PER_PIXEL_DIVISOR
    return total


def guard_cost(provider: str, model: str, image_paths: list[Path]) -> float:
    """Raise a structured error when the estimated cost exceeds the ceiling.

    Returns the estimated cost in USD (0 for local providers) so callers can
    surface it.
    """
    price = price_for(provider, model)
    if price <= 0:
        return 0.0
    tokens = estimate_call_tokens(image_paths)
    estimated_usd = tokens / 1_000_000 * price
    ceiling = get_settings().cost_ceiling_usd
    if estimated_usd > ceiling:
        raise VisionError(
            f"estimated cost ${estimated_usd:.2f} exceeds the ceiling ${ceiling:.2f} "
            f"({tokens} est. tokens, {len(image_paths)} images, model {model})",
            code="vision.cost_ceiling",
            fix="reduce frames, use a cheaper model tier, or raise "
            "AGENTVISION_COST_CEILING_USD",
            details={"estimated_usd": round(estimated_usd, 4), "tokens": tokens},
        )
    return estimated_usd
