"""Vision layer: registry-driven providers, cost guard, response parsing (mocked)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("PIL", reason="perceive extra not installed")

import httpx  # noqa: E402

from watch_skill.config import reset_settings  # noqa: E402
from watch_skill.errors import VisionError  # noqa: E402
from watch_skill.vision import client as client_mod  # noqa: E402
from watch_skill.vision.client import VisionClient  # noqa: E402
from watch_skill.vision.cost import estimate_call_tokens, guard_cost  # noqa: E402
from watch_skill.vision.model import ClientVisionModel, get_vision  # noqa: E402


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
    monkeypatch.setenv("WATCHSKILL_ANTHROPIC_API_KEY", "test-key")
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
    monkeypatch.setenv("WATCHSKILL_OPENAI_API_KEY", "test-key")
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
    from watch_skill.vision import local_health

    monkeypatch.setattr(local_health, "ensure_ollama", lambda base_url: None)
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
    monkeypatch.setenv("WATCHSKILL_COST_CEILING_USD", "0.000001")
    reset_settings()
    with pytest.raises(VisionError) as excinfo:
        guard_cost("anthropic", "claude-fable-5", [frame])
    assert excinfo.value.code == "vision.cost_ceiling"


def test_cost_guard_free_for_local() -> None:
    assert guard_cost("ollama", "llava", []) == 0.0


def test_describe_frames_parses_numbered_lines(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WATCHSKILL_ANTHROPIC_API_KEY", "k")
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


def test_describe_single_frame_uses_plain_prompt(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lone frame (how small local models are driven) gets a plain prompt and
    is returned verbatim — the rigid numbered 'Format:' makes moondream reply
    with nothing at all."""
    monkeypatch.setenv("WATCHSKILL_ANTHROPIC_API_KEY", "k")
    reset_settings()
    capture: dict = {}
    _mock_post(monkeypatch, {"content": [{"type": "text", "text": "red banner: BUILD FAILED"}]}, capture)
    out = ClientVisionModel(VisionClient("anthropic", "m")).describe_frames([frame])
    assert out == ["red banner: BUILD FAILED"]  # verbatim, not numbered-parsed
    prompt = capture["body"]["messages"][0]["content"][-1]["text"]
    assert "Format:" not in prompt and "telegraphic" not in prompt
    assert "Describe this image" in prompt


def test_tier_selection_from_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_PROVIDER", "ollama")
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_MODEL", "llava")
    reset_settings()
    model = get_vision("cheap")
    assert model.client.provider == "ollama"
    assert model.client.model == "llava"
    override = get_vision("cheap", provider="openai", model="gpt-4o-mini")
    assert override.client.provider == "openai"


def test_http_error_is_structured(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_ANTHROPIC_API_KEY", "k")
    reset_settings()

    def fake_post(url, headers=None, json=None, timeout=None):
        request = httpx.Request("POST", url)
        return httpx.Response(429, json={"error": "rate"}, request=request)

    monkeypatch.setattr(client_mod.httpx, "post", fake_post)
    with pytest.raises(VisionError) as excinfo:
        VisionClient("anthropic", "m").generate("x", [frame])
    assert excinfo.value.code == "vision.http_error"
    assert excinfo.value.details["body"] == json.dumps({"error": "rate"}).replace(" ", "")


def test_openrouter_wire_format(frame: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_OPENROUTER_API_KEY", "or-test-key")
    reset_settings()
    capture: dict = {}
    _mock_post(
        monkeypatch,
        {"choices": [{"message": {"content": "a red frame via openrouter"}}]},
        capture,
    )

    out = VisionClient("openrouter", "qwen/qwen2.5-vl-72b-instruct:free").generate(
        "describe", [frame]
    )
    assert out == "a red frame via openrouter"
    assert capture["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert capture["headers"]["Authorization"] == "Bearer or-test-key"
    assert capture["headers"]["X-Title"] == "Watch Skill"  # attribution headers
    # OpenAI-compatible body shape
    assert capture["body"]["model"] == "qwen/qwen2.5-vl-72b-instruct:free"
    assert capture["body"]["messages"][0]["content"][0]["type"] == "image_url"


def test_openrouter_free_model_costs_nothing() -> None:
    from watch_skill.vision.registry import price_for

    assert price_for("openrouter", "qwen/qwen2.5-vl-72b-instruct:free") == 0.0


def test_describe_frames_batches_by_setting(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """24 frames with batch size 8 -> 3 calls, order preserved (small local
    models cannot handle 24 images in one prompt)."""
    monkeypatch.setenv("WATCHSKILL_VISION_BATCH_SIZE", "8")
    monkeypatch.setenv("WATCHSKILL_ANTHROPIC_API_KEY", "k")
    reset_settings()
    calls: list[int] = []

    class FakeClient:
        def generate(self, prompt: str, images: list) -> str:
            calls.append(len(images))
            return "\n".join(f"{i + 1}: frame {len(calls)}-{i + 1}" for i in range(len(images)))

    model = ClientVisionModel(FakeClient())
    out = model.describe_frames([frame] * 24)
    assert calls == [8, 8, 8]
    assert len(out) == 24
    assert out[0] == "frame 1-1" and out[8] == "frame 2-1" and out[23] == "frame 3-8"


def test_local_provider_gets_longer_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: 180s cloud timeout killed Ollama CPU calls mid model-load."""
    from watch_skill.vision.client import _timeout_for

    reset_settings()
    assert _timeout_for("ollama") == 900.0
    assert _timeout_for("anthropic") == 180.0
    monkeypatch.setenv("WATCHSKILL_VISION_LOCAL_TIMEOUT_SECONDS", "120")
    reset_settings()
    assert _timeout_for("ollama") == 120.0


def test_parse_numbered_tolerates_sloppy_models() -> None:
    """Regression: qwen2.5vl:3b echoed the literal placeholder `N: ...`,
    which the strict parser dropped -> empty descriptions."""
    from watch_skill.vision.model import _parse_numbered

    assert _parse_numbered("1: a red frame\n2: a blue frame", 2) == [
        "a red frame", "a blue frame",
    ]
    # literal placeholder echo (the live bug)
    assert _parse_numbered("N: A red screen with black bars.", 1) == [
        "A red screen with black bars.",
    ]
    # no numbering at all -> lines in order
    assert _parse_numbered("- a cat\n- a dog", 2) == ["a cat", "a dog"]
    # partial numbering still respects positions
    assert _parse_numbered("2: only the second", 2) == ["", "only the second"]
    assert _parse_numbered("", 2) == ["", ""]


def test_describe_batch_retries_transient_then_degrades(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: one timed-out describe call (swapped machine) killed the
    whole indexing pass. A batch retries once, then yields empty strings
    while OTHER batches still run."""
    monkeypatch.setenv("WATCHSKILL_VISION_BATCH_SIZE", "2")
    reset_settings()
    calls: list[int] = []

    class FlakyClient:
        def generate(self, prompt: str, images: list) -> str:
            calls.append(len(images))
            if len(calls) <= 2:  # first batch fails twice (initial + retry)
                raise VisionError("timed out", code="vision.call_failed")
            return "\n".join(f"{i + 1}: ok {len(calls)}" for i in range(len(images)))

    model = ClientVisionModel(FlakyClient())
    out = model.describe_frames([frame] * 4)
    assert calls == [2, 2, 2]              # batch1, batch1-retry, batch2
    assert out[:2] == ["", ""]             # degraded batch
    assert out[2] and out[3]               # second batch survived


def test_describe_batch_config_error_still_raises(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-transient failures (no API key) must NOT be swallowed."""
    reset_settings()

    class KeylessClient:
        def generate(self, prompt: str, images: list) -> str:
            raise VisionError("no key", code="vision.no_api_key")

    with pytest.raises(VisionError):
        ClientVisionModel(KeylessClient()).describe_frames([frame])


def test_ollama_request_pins_memory_and_determinism_options(
    frame: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The local request carries num_ctx (RAM ceiling), temperature 0
    (reproducible loop verdicts), and keep_alive (no mid-pipeline reloads)."""
    from watch_skill.vision.client import _ollama_request

    monkeypatch.setenv("WATCHSKILL_OLLAMA_NUM_CTX", "768")
    reset_settings()
    endpoint, headers, body = _ollama_request("moondream", "", "hi", [frame])
    assert endpoint.endswith("/api/chat")
    assert body["options"]["num_ctx"] == 768
    assert body["options"]["temperature"] == 0
    assert body["keep_alive"] == "30m"
