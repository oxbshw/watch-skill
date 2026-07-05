"""Local text embeddings via fastembed (ONNX MiniLM-class; no torch).

The default model is multilingual: same 384 dims and interface as the
English-only all-MiniLM-L6-v2 it replaced, but it actually retrieves
Arabic/Russian/Hindi/Chinese — including cross-lingual (English question
over an Arabic transcript). Benchmark in docs/DECISIONS.md.

Degrades loudly: when fastembed is not installed, the index still works with
FTS5 keyword search only — hybrid retrieval just loses its vector half.
"""
from __future__ import annotations

import struct
import sys

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_models: dict[str, object] = {}
_unavailable = False


def _get_model(name: str):
    global _unavailable
    if name in _models or _unavailable:
        return _models.get(name)
    try:
        import warnings  # noqa: PLC0415

        from fastembed import TextEmbedding  # noqa: PLC0415

        with warnings.catch_warnings():
            # informational pooling-change notice; the multilingual bench in
            # docs/DECISIONS.md was measured on the current (mean) pooling
            warnings.filterwarnings("ignore", message=".*mean pooling.*")
            _models[name] = TextEmbedding(model_name=name)
    except ImportError:
        _unavailable = True
        print(
            "[watch-skill] fastembed not installed — keyword-only search "
            '(install with `uv sync --extra index`)',
            file=sys.stderr,
        )
    return _models.get(name)


def embed_texts(texts: list[str], model_name: str | None = None) -> list[list[float]] | None:
    """Embed a batch of texts; ``None`` when embeddings are unavailable.

    ``model_name`` overrides the default — the index read/write paths pass
    the model recorded in the index meta so stored vectors and query vectors
    always come from the same model.
    """
    model = _get_model(model_name or MODEL_NAME)
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
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
