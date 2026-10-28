"""The embedding model loads on first use and is released when idle.

A long-lived server spends most of its life not embedding, and the model is
most of its memory. These tests use a stand-in model so they need neither
fastembed nor a download.
"""
from __future__ import annotations

import sys
import threading
import time
import types

import pytest

from watch_skill.index import embeddings

np = pytest.importorskip("numpy")


class _FakeModel:
    constructed = 0
    construct_lock = threading.Lock()

    def __init__(self, model_name: str) -> None:
        time.sleep(0.05)  # widen the window two first calls could race in
        with _FakeModel.construct_lock:
            _FakeModel.constructed += 1
        self.model_name = model_name

    def embed(self, texts: list[str]):
        return [np.zeros(2, dtype=np.float32) for _ in texts]


@pytest.fixture(autouse=True)
def fake_fastembed(monkeypatch: pytest.MonkeyPatch):
    """Swap in the stand-in model and reset process-global embedding state."""
    _FakeModel.constructed = 0
    monkeypatch.setitem(sys.modules, "fastembed", types.SimpleNamespace(TextEmbedding=_FakeModel))
    models, unavailable = dict(embeddings._models), embeddings._unavailable
    embeddings._models.clear()
    embeddings._unavailable = False
    yield
    if embeddings._idle_timer is not None:
        embeddings._idle_timer.cancel()
    embeddings._models.clear()
    embeddings._models.update(models)
    embeddings._unavailable = unavailable


def _idle(monkeypatch: pytest.MonkeyPatch, seconds: float) -> None:
    monkeypatch.setattr(embeddings, "_idle_seconds", lambda: seconds)


def test_concurrent_first_calls_load_the_model_once(monkeypatch: pytest.MonkeyPatch) -> None:
    _idle(monkeypatch, 0)
    results: list[object] = []
    threads = [
        threading.Thread(target=lambda: results.append(embeddings._get_model("m")))
        for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert _FakeModel.constructed == 1
    assert len({id(r) for r in results}) == 1


def test_an_idle_model_is_released_and_reloads_on_the_next_call(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    _idle(monkeypatch, 0.6)
    assert embeddings.embed_texts(["hello"], "m") is not None
    assert "m" in embeddings._models

    time.sleep(1.0)
    assert embeddings._models == {}
    assert "released after idle" in capsys.readouterr().err

    assert embeddings.embed_texts(["again"], "m") is not None
    assert _FakeModel.constructed == 2


def test_use_postpones_the_release(monkeypatch: pytest.MonkeyPatch) -> None:
    _idle(monkeypatch, 0.8)
    for _ in range(4):
        embeddings.embed_texts(["keep"], "m")
        time.sleep(0.4)
    assert "m" in embeddings._models
    assert _FakeModel.constructed == 1


def test_zero_keeps_the_model_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    _idle(monkeypatch, 0)
    embeddings.embed_texts(["hello"], "m")
    assert embeddings._idle_timer is None
    assert "m" in embeddings._models


def test_the_idle_setting_defaults_to_five_minutes() -> None:
    from watch_skill.config import Settings

    assert Settings().embedding_idle_seconds == 300
