"""Local text embeddings via fastembed (ONNX MiniLM-class; no torch).

The default model is multilingual: same 384 dims and interface as the
English-only all-MiniLM-L6-v2 it replaced, but it actually retrieves
Arabic/Russian/Hindi/Chinese — including cross-lingual (English question
over an Arabic transcript). Benchmark in docs/DECISIONS.md.

Degrades loudly: when fastembed is not installed, the index still works with
FTS5 keyword search only — hybrid retrieval just loses its vector half.
"""
from __future__ import annotations

import gc
import struct
import sys
import threading
import time

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_models: dict[str, object] = {}
_unavailable = False
# Guards _models: a load, a use and the idle unload never interleave, and two
# first searches arriving together construct the model once.
_lock = threading.Lock()
_last_used = 0.0
_idle_timer: threading.Timer | None = None


def _idle_seconds() -> float:
    """Seconds without an embedding call before the model is released; 0 keeps it."""
    from watch_skill.config import get_settings  # noqa: PLC0415

    return get_settings().embedding_idle_seconds


def _touch() -> None:
    """Record a use and re-arm the idle release. The caller holds ``_lock``."""
    global _last_used, _idle_timer
    _last_used = time.monotonic()
    if _idle_timer is not None:
        _idle_timer.cancel()
        _idle_timer = None
    idle = _idle_seconds()
    if idle <= 0:
        return
    _idle_timer = threading.Timer(idle, _unload_if_idle, args=(idle,))
    _idle_timer.daemon = True
    _idle_timer.start()


def _unload_if_idle(idle: float) -> None:
    """Release every loaded model if none was used for ``idle`` seconds.

    The model is most of a server's memory (about 580 MB of ~680 MB for the
    default), and a long-lived server spends most of its life not embedding.
    The native libraries stay imported, so the next load happens on whatever
    thread needs it without the import deadlock described in
    :func:`warm_native_imports`.
    """
    with _lock:
        if _models and time.monotonic() - _last_used >= idle - 0.5:
            _models.clear()
            gc.collect()
            print("[watch-skill] embedding model released after idle", file=sys.stderr)


def _get_model(name: str):
    """The loaded model for ``name``, loading it first if needed; ``None`` if unavailable."""
    with _lock:
        model = _load_locked(name)
        if model is not None:
            _touch()
        return model


def _load_locked(name: str):
    """Load ``name`` into ``_models`` once. The caller holds ``_lock``."""
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


def warm_native_imports() -> None:
    """Import the native-extension stack on the calling thread, before serving.

    Both servers in this project answer requests on worker threads: FastMCP
    runs sync tools in a pool, and the Bridge owns a bounded pool of its own.
    The embedding stack (fastembed -> numpy -> onnxruntime) is imported lazily
    at its call sites, so the first import lands inside a worker — where
    loading the numpy C extension deadlocks and never returns.

    The symptom is asymmetric and misleading in both. Measured on the Bridge
    against 1.4.3: the first ``watch.library.search`` in a fresh Core did not
    answer in fifteen minutes; a second search issued afterwards, in the same
    process, answered in 51 seconds, and a third in 1.2. Everything that does
    not embed stayed instant throughout, so the engine looked healthy and the
    one tool an agent reaches for to find a source hung forever.

    The MCP server has had this call since the deadlock was first found there.
    The Bridge did not, which is the whole of the defect: two servers with the
    same shape and one of them warmed. It lives here now so a third cannot be
    written without it.

    Only the imports happen here, not the model: the native extensions are
    what must load on a thread the server owns, while the model itself loads
    on first use and is released after ``embedding_idle_seconds`` without one.
    That keeps an idle server at about 100 MB instead of about 680 MB.

    Best-effort by design: a box where fastembed is missing or unloadable
    degrades to keyword-only search, and serving must start either way.
    """
    try:
        import_native_stack()
    except Exception as exc:  # noqa: BLE001 - never block serving on a warmup
        print(f"[watch-skill] embedding warmup skipped ({exc})", file=sys.stderr)


def import_native_stack() -> None:
    """Import fastembed and the numpy and onnxruntime extensions it loads."""
    import fastembed  # noqa: F401, PLC0415
    import numpy  # noqa: F401, PLC0415
    import onnxruntime  # noqa: F401, PLC0415


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
