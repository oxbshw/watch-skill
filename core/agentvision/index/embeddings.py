"""Local text embeddings via fastembed (ONNX MiniLM-class; no torch).

Degrades loudly: when fastembed is not installed, the index still works with
FTS5 keyword search only — hybrid retrieval just loses its vector half.
"""
from __future__ import annotations

import struct
import sys

_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_model = None
_unavailable = False


def _get_model():
    global _model, _unavailable
    if _model is not None or _unavailable:
        return _model
    try:
        from fastembed import TextEmbedding  # noqa: PLC0415

        _model = TextEmbedding(model_name=_MODEL_NAME)
    except ImportError:
        _unavailable = True
        print(
            "[agentvision] fastembed not installed — keyword-only search "
            '(install with `uv sync --extra index`)',
            file=sys.stderr,
        )
    return _model


def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """Embed a batch of texts; ``None`` when embeddings are unavailable."""
    model = _get_model()
    if model is None or not texts:
        return None if model is None else []
    return [vec.tolist() for vec in model.embed(texts)]


def pack_vector(vector: list[float]) -> bytes:
    """float32 little-endian blob for SQLite storage."""
    return struct.pack(f"<{len(vector)}f", *vector)


def unpack_vector(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"<{dim}f", blob))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity without numpy (vectors are short; hot path is SQL)."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
