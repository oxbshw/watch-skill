"""Pillar 4 — local vision robustness: a dead or empty server fails
LOUDLY and structured, never as an empty string an agent mistakes for
'nothing to see'.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from watch_skill.errors import VisionError
from watch_skill.vision import local_health
from watch_skill.vision.client import VisionClient
from watch_skill.vision.local_health import ensure_ollama, forget_liveness, ollama_alive


@pytest.fixture(autouse=True)
def _fresh_liveness_cache():
    forget_liveness()
    yield
    forget_liveness()


def test_alive_probe_caches_positive_results(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def fake_get(url, timeout):
        calls["n"] += 1
        return SimpleNamespace(raise_for_status=lambda: None)

    monkeypatch.setattr(httpx, "get", fake_get)
    assert ollama_alive("http://127.0.0.1:11434")
    assert ollama_alive("http://127.0.0.1:11434")
    assert calls["n"] == 1, "second probe inside the TTL must be free"


def test_dead_server_no_binary_raises_server_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(local_health, "ollama_alive", lambda base, timeout=3.0: False)
    monkeypatch.setattr(local_health, "_ollama_binary", lambda: None)
    with pytest.raises(VisionError) as excinfo:
        ensure_ollama("http://127.0.0.1:11434")
    assert excinfo.value.code == "vision.server_down"
    assert "ollama serve" in excinfo.value.fix
    assert excinfo.value.details["restart_attempted"] is False


def test_dead_server_restarts_once_and_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    states = iter([False, True])  # dead on first probe, alive after restart
    monkeypatch.setattr(local_health, "ollama_alive", lambda base, timeout=3.0: next(states))
    launched = {"n": 0}

    def fake_restart():
        launched["n"] += 1
        return True

    monkeypatch.setattr(local_health, "restart_ollama_detached", fake_restart)
    ensure_ollama("http://127.0.0.1:11434")  # no raise = recovered
    assert launched["n"] == 1


def test_restart_that_never_comes_up_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(local_health, "ollama_alive", lambda base, timeout=3.0: False)
    monkeypatch.setattr(local_health, "restart_ollama_detached", lambda: True)
    monkeypatch.setattr(local_health, "_RESTART_WAIT_SECONDS", 0.05)
    with pytest.raises(VisionError) as excinfo:
        ensure_ollama("http://127.0.0.1:11434")
    assert excinfo.value.code == "vision.server_down"
    assert excinfo.value.details["restart_attempted"] is True


# ---- the empty-response path (regression: this used to come back as "") ----

def test_empty_model_output_is_a_structured_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        "watch_skill.vision.client.httpx.post",
        lambda *a, **k: SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"message": {"content": "   "}},
        ),
    )
    monkeypatch.setattr(local_health, "ollama_alive", lambda base, timeout=3.0: True)
    client = VisionClient(provider="ollama", model="moondream")
    with pytest.raises(VisionError) as excinfo:
        client.generate("describe", [])
    assert excinfo.value.code == "vision.empty"


def test_connect_error_during_call_becomes_server_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def dead_post(*args, **kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr("watch_skill.vision.client.httpx.post", dead_post)
    # pre-call health check passes (stale liveness), the post-mortem one
    # tells the truth — the client imports ensure_ollama lazily, so the
    # patch goes on local_health itself
    alive_once = {"first": True}

    def ensure_first_ok(base):
        if alive_once["first"]:
            alive_once["first"] = False
            return
        raise VisionError("down", code="vision.server_down", fix="start it")

    monkeypatch.setattr(local_health, "ensure_ollama", ensure_first_ok)
    client = VisionClient(provider="ollama", model="moondream")
    with pytest.raises(VisionError) as excinfo:
        client.generate("describe", [])
    assert excinfo.value.code == "vision.server_down"
