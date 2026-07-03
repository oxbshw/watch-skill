"""Vision layer: registry-driven providers, cost guard, response parsing (mocked)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("PIL", reason="perceive extra not installed")

import httpx  # noqa: E402

from agentvision.config import reset_settings  # noqa: E402
from agentvision.errors import VisionError  # noqa: E402
from agentvision.vision import client as client_mod  # noqa: E402
from agentvision.vision.client import VisionClient  # noqa: E402
from agentvision.vision.cost import estimate_call_tokens, guard_cost  # noqa: E402
from agentvision.vision.model import ClientVisionModel, get_vision  # noqa: E402


@pytest.fixture()
def frame(tmp_path: Path) -> Path:
    from PIL import Image

    path = tmp_path / "frames dir" / "frame.jpg"
    path.parent.mkdir(parents=True)
    Image.new("RGB", (512, 288), color=(200, 30, 30)).save(path)
    return path


def _mock_post(monkeypatch: pytest.MonkeyPatch, payload: dict, capture: dict) -> None:
    def fake_post(url, headers=None, json=None, timeout=None):
        capture["url"] = url
        capture["headers"] = headers or {}
        capture["body"] = json
        request = httpx.Request("POST", url)
        return httpx.Response(200, json=payload, request=request)

    monkeypatch.setattr(client_mod.httpx, "post", fake_post)


def test_anthropic_wire_format(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTVISION_ANTHROPIC_API_KEY", "test-key")
    reset_settings()
    capture: dict = {}
    _mock_post(monkeypatch, {"content": [{"type": "text", "text": "a red frame"}]}, capture)

    out = VisionClient("anthropic", "claude-haiku-4-5-20251001").generate("describe", [frame])
    assert out == "a red frame"
    assert capture["headers"]["x-api-key"] == "test-key"
    blocks = capture["body"]["messages"][0]["content"]
    assert blocks[0]["type"] == "image"
    assert blocks[-1]["type"] == "text"


def test_openai_wire_format(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTVISION_OPENAI_API_KEY", "test-key")
    reset_settings()
    capture: dict = {}
    _mock_post(
        monkeypatch, {"choices": [{"message": {"content": "hello"}}]}, capture
    )
    out = VisionClient("openai", "gpt-4o-mini").generate("describe", [frame])
    assert out == "hello"
    assert capture["headers"]["Authorization"] == "Bearer test-key"
    assert capture["body"]["messages"][0]["content"][0]["type"] == "image_url"


def test_ollama_needs_no_key(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    capture: dict = {}
    _mock_post(monkeypatch, {"message": {"content": "local answer"}}, capture)
    out = VisionClient("ollama", "qwen2.5-vl").generate("describe", [frame])
    assert out == "local answer"
    assert "11434" in capture["url"]


def test_missing_key_is_structured(frame: Path) -> None:
    with pytest.raises(VisionError) as excinfo:
        VisionClient("anthropic", "claude-sonnet-5").generate("x", [frame])
    assert excinfo.value.code == "vision.no_api_key"


def test_cost_guard_estimates_and_blocks(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tokens = estimate_call_tokens([frame])
    assert tokens > (512 * 288) // 750  # image + text allowance
    monkeypatch.setenv("AGENTVISION_COST_CEILING_USD", "0.000001")
    reset_settings()
    with pytest.raises(VisionError) as excinfo:
        guard_cost("anthropic", "claude-fable-5", [frame])
    assert excinfo.value.code == "vision.cost_ceiling"


def test_cost_guard_free_for_local() -> None:
    assert guard_cost("ollama", "llava", []) == 0.0


def test_describe_frames_parses_numbered_lines(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AGENTVISION_ANTHROPIC_API_KEY", "k")
    reset_settings()
    capture: dict = {}
    _mock_post(
        monkeypatch,
        {"content": [{"type": "text", "text": "1: red slide\n2: blue chart"}]},
        capture,
    )
    model = ClientVisionModel(VisionClient("anthropic", "m"))
    out = model.describe_frames([frame, frame])
    assert out == ["red slide", "blue chart"]


def test_tier_selection_from_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTVISION_VISION_CHEAP_PROVIDER", "ollama")
    monkeypatch.setenv("AGENTVISION_VISION_CHEAP_MODEL", "llava")
    reset_settings()
    model = get_vision("cheap")
    assert model.client.provider == "ollama"
    assert model.client.model == "llava"
    override = get_vision("cheap", provider="openai", model="gpt-4o-mini")
    assert override.client.provider == "openai"


def test_http_error_is_structured(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENTVISION_ANTHROPIC_API_KEY", "k")
    reset_settings()

    def fake_post(url, headers=None, json=None, timeout=None):
        request = httpx.Request("POST", url)
        return httpx.Response(429, json={"error": "rate"}, request=request)

    monkeypatch.setattr(client_mod.httpx, "post", fake_post)
    with pytest.raises(VisionError) as excinfo:
        VisionClient("anthropic", "m").generate("x", [frame])
    assert excinfo.value.code == "vision.http_error"
    assert excinfo.value.details["body"] == json.dumps({"error": "rate"}).replace(" ", "")
