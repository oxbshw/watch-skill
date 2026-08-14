"""Semantic search degrades; retrieval does not disappear.

An installed-but-unloadable embedding model used to take every query down
with it — out of memory, a truncated model cache, an unusable runtime. Vector
scoring is a ranking improvement, not a precondition for finding anything, so
it now falls back to keyword search and says so once.
"""
from __future__ import annotations

import pytest

from watch_skill.index import embeddings


@pytest.fixture(autouse=True)
def reset_embedding_state():
    """The unavailable flag is process-global; do not leak it between tests."""
    models, unavailable = dict(embeddings._models), embeddings._unavailable
    embeddings._models.clear()
    embeddings._unavailable = False
    yield
    embeddings._models.clear()
    embeddings._models.update(models)
    embeddings._unavailable = unavailable


def test_a_model_that_cannot_load_falls_back_instead_of_raising(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    def explode(*_args, **_kwargs):
        raise MemoryError("bad allocation")

    monkeypatch.setattr(embeddings, "_get_model", embeddings._get_model)
    monkeypatch.setitem(
        __import__("sys").modules, "fastembed",
        type("M", (), {"TextEmbedding": explode})(),
    )

    assert embeddings.embed_texts(["hello"]) is None
    assert embeddings._unavailable is True
    assert "keyword-only" in capsys.readouterr().err


def test_the_failure_is_announced_once_not_per_query(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    def explode(*_args, **_kwargs):
        raise RuntimeError("runtime unusable")

    monkeypatch.setitem(
        __import__("sys").modules, "fastembed",
        type("M", (), {"TextEmbedding": explode})(),
    )
    embeddings.embed_texts(["one"])
    first = capsys.readouterr().err
    embeddings.embed_texts(["two"])
    second = capsys.readouterr().err
    assert "unavailable" in first
    assert second == "", "the warning repeated on every query"


def test_a_missing_dependency_still_reports_the_install_command(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "fastembed":
            raise ImportError("no module named fastembed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert embeddings.embed_texts(["hello"]) is None
    assert "uv sync --extra index" in capsys.readouterr().err
