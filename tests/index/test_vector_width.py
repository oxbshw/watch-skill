"""The reader accepts either vector width; storage stays float32.

float16 halves the index (197 MB to 80 MB at 100k) and costs nothing in
ranking, so it looked like a clear win — until the read side was measured.
Widening it back dominates the scan: 115 ms becomes ~310 ms per 100k, and
chunking or a native float16 matmul make no difference. Two hundred
milliseconds on every query is not worth 118 MB of disk on a search path.

What stays is the tolerant reader. An index written during that experiment
must keep working, and the hazard there is silence: a float16 blob read as
float32 returns plausible numbers rather than an error, so a wrong guess
scores wrong instead of failing loudly.
"""
from __future__ import annotations

import struct

import pytest

from watch_skill.index.embeddings import pack_vector, unpack_vector
from watch_skill.index.retrieval import _batch_cosine

VEC = [0.1, -0.25, 0.5, 0.75]
DIM = len(VEC)


def float16_blob(vector: list[float]) -> bytes:
    """What the narrow-storage experiment wrote, and must still read."""
    return struct.pack(f"<{len(vector)}e", *vector)


def float32_blob(vector: list[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *vector)


def test_storage_is_float32() -> None:
    """Measured: the widening cost on read outweighs the disk saved."""
    assert len(pack_vector(VEC)) == DIM * 4


def test_both_widths_round_trip() -> None:
    assert unpack_vector(float16_blob(VEC), DIM) == pytest.approx(VEC, abs=1e-3)
    assert unpack_vector(float32_blob(VEC), DIM) == pytest.approx(VEC, abs=1e-6)


@pytest.mark.parametrize(
    ("label", "blobs"),
    [
        ("all float16", [float16_blob(VEC)]),
        ("all float32", [float32_blob(VEC)]),
        # The case a migration would miss: rows written on both sides of the
        # change, in one index, read in one batch.
        ("mixed", [float16_blob(VEC), float32_blob(VEC)]),
        ("mixed, other order", [float32_blob(VEC), float16_blob(VEC)]),
    ],
)
def test_a_vector_matches_itself_whatever_the_width(label: str, blobs: list[bytes]) -> None:
    rows = [{"vector": b, "dim": DIM} for b in blobs]
    scores = _batch_cosine(VEC, rows)
    assert scores == pytest.approx([1.0] * len(blobs), abs=1e-3), label


def test_ranking_survives_the_narrower_width() -> None:
    """The point of the storage is retrieval order; that must not move."""
    import numpy as np

    rng = np.random.default_rng(7)
    vectors = rng.standard_normal((60, 128)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    query = vectors[0].tolist()

    wide = [{"vector": float32_blob(v.tolist()), "dim": 128} for v in vectors]
    narrow = [{"vector": float16_blob(v.tolist()), "dim": 128} for v in vectors]

    top_wide = sorted(range(60), key=lambda i: -_batch_cosine(query, wide)[i])[:10]
    top_narrow = sorted(range(60), key=lambda i: -_batch_cosine(query, narrow)[i])[:10]
    assert top_wide == top_narrow, "the narrow width would have reordered the top 10"


def test_the_pure_python_fallback_agrees_with_numpy() -> None:
    """The loop runs where numpy is absent; it must not score differently."""
    from watch_skill.index import embeddings as emb

    row = {"vector": float16_blob(VEC), "dim": DIM}
    numpy_score = _batch_cosine(VEC, [row])[0]
    loop_score = emb.cosine_similarity(VEC, unpack_vector(row["vector"], DIM))
    assert numpy_score == pytest.approx(loop_score, abs=1e-4)
