"""`ask_video` over the MCP wire, against the clock.

The acceptance failure this defends was invisible in-process: `answer_question`
returned a correct, honest refusal — it just took 113 seconds to do it, and the
MCP host gave up first. From Claude Desktop the symptom was not "wrong answer",
it was *no answer twice*, which is indistinguishable from a broken server.

So the assertion that matters here is wall-clock, measured on the same call
path the host uses: tool dispatch, the real engine, and serialization back
through the protocol. `tests/answer/test_ask_deadline.py` covers the engine's
behaviour; this covers the thing the host actually experiences.

The ceiling is generous on purpose. It is not a performance target — it is a
tripwire for the unbounded escalation ladder coming back.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastmcp", reason="mcp extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

from fastmcp import Client  # noqa: E402

from watch_skill.answer import ladder  # noqa: E402
from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.surfaces.mcp.server import mcp  # noqa: E402
from watch_skill.transcribe.types import Segment, Transcript  # noqa: E402
from watch_skill.watch import watch  # noqa: E402

_TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

# An interactive follow-up that takes longer than this has stopped being a
# follow-up. Claude Desktop's own tool timeout is tighter; the headroom here
# absorbs a loaded CI box without letting the 113s regression through.
MCP_CALL_CEILING_SECONDS = 45.0


@pytest.fixture()
def captioned_no_vision(
    sample_video: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> str:
    """A caption-rich indexed video on a machine with no reachable VLM."""
    from watch_skill.config import reset_settings
    from watch_skill.vision import local_health

    monkeypatch.setenv("WATCHSKILL_OCR_ENABLED", "false")
    monkeypatch.setenv("WATCHSKILL_OLLAMA_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_PROVIDER", "ollama")
    monkeypatch.setenv("WATCHSKILL_VISION_STRONG_PROVIDER", "ollama")
    reset_settings()
    monkeypatch.setattr(local_health, "_ollama_binary", lambda: None)
    local_health.forget_liveness()
    ladder.reset_cost_model()

    result = watch(
        str(sample_video), out_dir=tmp_path / "wire work",
        run_ocr=False, allow_local_whisper=False, allow_cloud_stt=False,
    )
    result.transcript = Transcript(
        segments=[
            Segment(0.5, 3.5, "a second brain is just two folders on disk"),
            Segment(4.5, 7.5, "the raw folder holds captures and the wiki holds pages"),
            Segment(8.5, 11.5, "nothing is written until you approve the proposed page"),
        ],
        source="captions",
    )
    return index_watch_result(result, describe_scenes=False)


def _call(video: str, question: str) -> tuple[dict[str, Any], float]:
    """One `tools/call ask_video`, timed, returned as the wire sees it."""

    async def _run() -> tuple[dict[str, Any], float]:
        async with Client(mcp) as client:
            started = time.monotonic()
            called = await client.call_tool_mcp(
                "ask_video", {"video": video, "question": question}
            )
            elapsed = time.monotonic() - started
            return json.loads(called.model_dump_json(by_alias=True)), elapsed

    return asyncio.run(_run())


def _text(payload: dict[str, Any]) -> str:
    return "\n".join(
        block["text"] for block in payload.get("content", []) if block["type"] == "text"
    )


def test_ask_video_answers_within_the_host_timeout(captioned_no_vision: str) -> None:
    """The headline: a real tool call comes back, grounded, before the host quits."""
    payload, elapsed = _call(captioned_no_vision, "what are the two folders?")

    assert elapsed < MCP_CALL_CEILING_SECONDS, (
        f"tools/call ask_video took {elapsed:.1f}s. This is the timeout that "
        f"made the server look dead from Claude Desktop.")
    assert not payload.get("isError"), payload

    text = _text(payload)
    assert text.strip(), "the tool returned nothing"
    assert _TS.search(text), "an answer must cite timestamps from the index"
    assert "raw" in text.lower() or "wiki" in text.lower(), (
        f"the transcript states the answer and it is not in the result: {text[:400]}")


def test_wire_result_reports_its_verification_state(captioned_no_vision: str) -> None:
    """The host is told what did and did not happen.

    No VLM was reachable, so the meta line must say `verified: false` rather
    than quietly omitting it — an unverified answer that does not look
    unverified is the failure mode the honest floor exists to prevent.
    """
    payload, _ = _call(captioned_no_vision, "what are the two folders?")
    text = _text(payload)

    assert "verified: false" in text.lower(), (
        f"the result does not state its verification state: {text[-300:]}")
    assert "confidence:" in text.lower()


def test_absent_content_refuses_over_the_wire(captioned_no_vision: str) -> None:
    """Bounded did not become lenient, measured at the surface the host uses."""
    payload, elapsed = _call(
        captioned_no_vision, "what does the giraffe on the unicycle say?"
    )

    assert elapsed < MCP_CALL_CEILING_SECONDS
    text = _text(payload)
    assert "does not clearly show" in text.lower(), (
        f"absent content produced something other than a refusal: {text[:400]}")
