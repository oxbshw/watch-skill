"""Model-agnostic vision layer: Anthropic / OpenAI / Gemini / OpenRouter / Ollama.

Provider + model are config (a data registry), not code. Two tiers: cheap
(bulk scene descriptions) and strong (answers, critiques). Every cloud call
passes a pre-flight cost guard.
"""

from watch_skill.vision.client import VisionClient
from watch_skill.vision.cost import estimate_call_tokens, guard_cost
from watch_skill.vision.model import ClientVisionModel, VisionModel, get_vision
from watch_skill.vision.registry import MODEL_PRICES, PROVIDERS

__all__ = [
    "MODEL_PRICES",
    "PROVIDERS",
    "ClientVisionModel",
    "VisionClient",
    "VisionModel",
    "estimate_call_tokens",
    "get_vision",
    "guard_cost",
]
