"""Model-agnostic vision layer: Anthropic / OpenAI / Gemini / Ollama.

Provider + model are config (a data registry), not code. Two tiers: cheap
(bulk scene descriptions) and strong (answers, critiques). Every cloud call
passes a pre-flight cost guard.
"""

from agentvision.vision.client import VisionClient
from agentvision.vision.cost import estimate_call_tokens, guard_cost
from agentvision.vision.model import ClientVisionModel, VisionModel, get_vision
from agentvision.vision.registry import MODEL_PRICES, PROVIDERS

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
