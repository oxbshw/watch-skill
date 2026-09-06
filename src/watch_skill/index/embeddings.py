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
            '(install with `pip install "watch-skill[index]"`, or `uv sync --extra '
            'index` from a checkout)',
            file=sys.stderr,
        )
    except Exception as exc:  # noqa: BLE001
        # Installed but unloadable: out of memory, a truncated model cache, a
        # runtime the CPU cannot use. Semantic search is a ranking
        # improvement, not a precondition for retrieval, so degrade to
        # keyword-only rather than taking every query down with it. Announced
        # once, on stderr, because silently worse results are their own bug.
        _unavailable = True
        print(
            f"[watch-skill] embedding model unavailable ({type(exc).__name__}: "
            f"{exc}) — falling back to keyword-only search",
            file=sys.stderr,
        )
    return _models.get(name)


def warm_up(model_name: str | None = None) -> bool:
    """Load the embedding stack on the CALLING thread. Returns availability.

    Import this chain — fastembed, then numpy's and onnxruntime's native
    extensions — on a long-lived server's main thread, before any request can
    reach it. Every call site is otherwise lazy, so in the stdio MCP server the
    first import lands inside a FastMCP worker thread, where loading the numpy
    C extension deadlocks: the thread parks in ``create_module`` and never
    returns. Two consecutive faulthandler dumps 35s apart showed the identical
    frame, and the tools that need vectors (``search_videos``, ``ask_video``)
    hung forever while ``list_videos``, which never embeds, stayed instant.

    Warming costs a few seconds of startup once and is best-effort: a box
    without fastembed degrades to keyword-only search exactly as before.
    """
    return _get_model(model_name or MODEL_NAME) is not None


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
    """float32 little-endian blob for SQLite storage.

    float16 was tried and measured, and rejected. It does halve the index —
    100k vectors go from 197 MB to 80 MB — and costs nothing in ranking
    (largest cosine error on this model's output: 2.3e-5, top-20 identical).
    But every read has to widen it back, and that dominates the scan: 115 ms
    becomes ~310 ms per 100k, the same whether the conversion is done in one
    astype, in cache-sized blocks, or by letting numpy handle a float16
    matmul. Trading 200 ms on every query for 118 MB of disk is the wrong way
    round for a search path.

    :func:`unpack_vector` still reads either width, so an index written
    during that experiment keeps working.
    """
    return struct.pack(f"<{len(vector)}f", *vector)


def unpack_vector(blob: bytes, dim: int) -> list[float]:
    """Decode a stored vector, float16 or the float32 an older index wrote.

    The width is inferred from the blob rather than recorded, so an index
    built before the switch keeps working without a migration and without a
    rewrite of every row.
    """
    if len(blob) == dim * 2:
        return list(struct.unpack(f"<{dim}e", blob))
    return list(struct.unpack(f"<{dim}f", blob))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity without numpy (vectors are short; hot path is SQL)."""
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def release_models() -> int:
    """Drop cached embedding models and return how many were released.

    Same reasoning as the OCR engine cache: shared deliberately at runtime,
    but inherited accidentally between tests.
    """
    count = len(_models)
    _models.clear()
    return count
