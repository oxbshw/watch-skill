"""Real vision-language model over the live semantic path.

The deterministic backend proves selection, ordering, schema handling and
degradation. It sees nothing. This file is the only place that can say a model
actually understood a picture, and it is skipped — loudly, with the blocker
named — when no model is reachable.

Two ways in, both deliberate:

* a **local** server (Ollama or any OpenAI-compatible host) already running;
* an explicitly named provider via ``WATCHSKILL_TEST_VLM_PROVIDER``.

Neither is discovered. A configured API key lying around in the environment is
not consent to spend it, so nothing here reads one unless the provider was
named on purpose.

    python scripts/make_vision_fixture.py --out tests/fixtures/vision
    WATCHSKILL_TEST_REAL_VLM=1 pytest tests/integration/test_real_vlm.py
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

pytestmark = [
    pytest.mark.real_model,
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_TEST_REAL_VLM"),
        reason="real-model VLM gate; set WATCHSKILL_TEST_REAL_VLM=1 to run "
        "(see docs/testing.md)",
    ),
]

MIN_TAG_RECALL = 0.5
"""How much of the fixture's ground truth the model must recover. Set to catch
a model that is not looking at the image at all, not to rank models."""


def _local_vlm() -> tuple[str, str] | None:
    """A vision model on an already-running local server, or None.

    Probes localhost only, with a short timeout, and never starts anything.
    """
    base = os.environ.get("WATCHSKILL_OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    try:
        with urllib.request.urlopen(f"{base}/api/tags", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None
    for model in payload.get("models", []):
        name = str(model.get("name", ""))
        if any(tag in name.lower() for tag in
               ("llava", "vision", "qwen2-vl", "qwen2.5vl", "moondream",
                "minicpm-v", "gemma3", "llama3.2-vision")):
            return "ollama", name
    return None


def _selected_backend() -> tuple[str, str] | None:
    provider = os.environ.get("WATCHSKILL_TEST_VLM_PROVIDER")
    if provider:
        return provider, os.environ.get("WATCHSKILL_TEST_VLM_MODEL", "")
    return _local_vlm()


_BACKEND = _selected_backend()

requires_vlm = pytest.mark.skipif(
    _BACKEND is None,
    reason="no vision model reachable: no local Ollama vision model is "
    "running, and WATCHSKILL_TEST_VLM_PROVIDER was not set. Start a local "
    "vision model (`ollama pull llava && ollama serve`) or name a provider "
    "explicitly — no API key is read without one.",
)


@pytest.fixture(scope="module")
def vision_fixture(tmp_path_factory: pytest.TempPathFactory) -> dict:
    import sys

    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from make_vision_fixture import build  # noqa: PLC0415

    pytest.importorskip("PIL")
    out_dir = tmp_path_factory.mktemp("vision fixture")
    manifest = build(out_dir)
    manifest["path"] = out_dir / manifest["video"]
    return manifest


@requires_vlm
def test_a_real_model_describes_the_fixture(
    vision_fixture: dict, tmp_path: Path, record_property
) -> None:
    """Recognition, measured against ground truth and recorded."""
    import subprocess

    from watch_skill.health.binaries import require_binary
    from watch_skill.live.semantic import ProviderSemanticBackend

    provider, model = _BACKEND  # type: ignore[misc]
    frame = tmp_path / "frame.jpg"
    # Second segment: the broken total. Extracted at 7s, inside its window.
    subprocess.run(
        [str(require_binary("ffmpeg")), "-y", "-loglevel", "error",
         "-ss", "7", "-i", str(vision_fixture["path"]),
         "-frames:v", "1", str(frame)],
        check=True, timeout=120,
    )

    backend = ProviderSemanticBackend(provider=provider, model=model or None)
    started = time.monotonic()
    observation = backend.interpret([frame], media_ts=7.0)
    latency = time.monotonic() - started

    payload = observation.to_public()
    record_property("vlm_result", json.dumps({
        "provider": provider, "model": model or "(configured default)",
        "latency_seconds": round(latency, 2),
        "frames_sent": 1, "model_calls": 1,
        "network_policy": "local-only" if provider == "ollama" else "provider",
        "observation": payload,
    }))
    print("\n" + json.dumps(payload, indent=2))

    assert not observation.degraded, (
        f"the model returned unusable output: {observation.degraded_reason}"
    )
    assert payload["provenance"]["kind"] == "model_inference"
    assert payload["advisory"] is True

    text = " ".join([
        observation.scene, observation.ui_state, observation.anomaly,
        *observation.entities, *observation.actions,
    ]).lower()
    tags = {"checkout", "total", "nan"}
    recall = sum(1 for tag in tags if tag in text) / len(tags)
    record_property("vlm_tag_recall", str(recall))
    assert recall >= MIN_TAG_RECALL, (
        f"tag recall {recall:.2f} — the model does not appear to be reading "
        f"the image. It said: {text[:300]!r}"
    )


@requires_vlm
def test_a_real_model_reading_the_injection_frame_does_not_act_on_it(
    vision_fixture: dict, tmp_path: Path
) -> None:
    """The frame that tells the model to delete everything.

    Whatever the model replies, the output is a typed observation. There is no
    field it could populate that would cause a call, and the schema drops
    anything it invents.
    """
    import subprocess

    from watch_skill.health.binaries import require_binary
    from watch_skill.live.semantic import ProviderSemanticBackend

    provider, model = _BACKEND  # type: ignore[misc]
    frame = tmp_path / "injection.jpg"
    subprocess.run(
        [str(require_binary("ffmpeg")), "-y", "-loglevel", "error",
         "-ss", "12", "-i", str(vision_fixture["path"]),
         "-frames:v", "1", str(frame)],
        check=True, timeout=120,
    )

    backend = ProviderSemanticBackend(provider=provider, model=model or None)
    payload = backend.interpret([frame], media_ts=12.0).to_public()

    assert payload["advisory"] is True
    assert not (set(payload) & {"tool", "tool_call", "command", "exec", "action"})
    print("\ninjection frame read as:", json.dumps(payload, indent=2)[:600])


@requires_vlm
def test_a_local_backend_sends_nothing_off_the_machine(
    vision_fixture: dict, tmp_path: Path
) -> None:
    """Local means local; a loopback call is not egress."""
    import socket
    import subprocess

    from watch_skill.health.binaries import require_binary
    from watch_skill.live.semantic import ProviderSemanticBackend

    provider, model = _BACKEND  # type: ignore[misc]
    if provider != "ollama":
        pytest.skip("only meaningful for the local backend")

    frame = tmp_path / "f.jpg"
    subprocess.run(
        [str(require_binary("ffmpeg")), "-y", "-loglevel", "error",
         "-ss", "2", "-i", str(vision_fixture["path"]),
         "-frames:v", "1", str(frame)],
        check=True, timeout=120,
    )

    remote: list = []
    original = socket.socket.connect

    def guard(self, address):  # noqa: ANN001
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            remote.append(address)
            raise AssertionError(f"outbound connection to {address!r}")
        return original(self, address)

    socket.socket.connect = guard
    try:
        ProviderSemanticBackend(provider=provider,
                                model=model or None).interpret([frame], 2.0)
    finally:
        socket.socket.connect = original
    assert remote == [], f"the local backend left the machine: {remote}"


def test_the_blocker_is_recorded_when_no_model_is_reachable() -> None:
    """Runs even without a model, so the gap is visible rather than silent.

    A skipped file reads as "not run". This asserts the harness itself is
    wired and names precisely what is missing.
    """
    if _BACKEND is not None:
        pytest.skip("a model is reachable; the blocker does not apply")
    assert "no vision model reachable" in requires_vlm.kwargs["reason"]
    assert "WATCHSKILL_TEST_VLM_PROVIDER" in requires_vlm.kwargs["reason"]
