"""The interactive contract: a follow-up ask answers, or abstains, in bounded time.

This file exists because of a real acceptance failure. On a caption-rich
7-minute video with no vision backend reachable, `ask_video` took **113s** and
then abstained. Two MCP calls timed out before anyone saw a result, and the
measured breakdown said why:

    escalation/dense_resample      53.6s
    escalation/zoom_crops_reocr    48.3s
    verify (vision probe)           2.4s
    retrieval                       0.9s

Both escalation rungs are model-free, so they are charged **0 tokens** — which
means `answer_token_budget`, the documented "hard ceiling on top", provably
could not bound them. And they bought nothing: retrieval-only confidence was
0.330 / 0.486 on two questions, and after 104s of escalation it was *still*
0.330 / 0.486. A hundred seconds for a 0.000 gain.

So the rules asserted here:

- transcript evidence alone answers, with **no** vision backend reachable —
  vision is documented as optional ("Cloud vision models are optional and only
  improve answer verification"), and an ask that can be grounded in captions
  must not be held hostage to a VLM;
- an ask stays inside its wall-clock deadline;
- and none of that is bought by lowering the bar: a shortened ask still faces
  the same confidence floor, still reports `verified=False` when nothing
  verified it, and still abstains when the evidence is not there.

Nothing here mocks the answer path. The engine, retrieval, confidence scoring,
the ladder and the honest floor all run for real; only the *environment* is
arranged — the vision server is genuinely absent, which is the condition under
test.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

import pytest

pytest.importorskip("scenedetect", reason="perceive extra not installed")

from watch_skill.answer import (
    answer_question,  # noqa: E402
    ladder,  # noqa: E402
)
from watch_skill.index import index_watch_result  # noqa: E402
from watch_skill.index.store import get_video  # noqa: E402
from watch_skill.transcribe.types import Segment, Transcript  # noqa: E402
from watch_skill.watch import watch  # noqa: E402

_TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

# What an interactive MCP client will sit through. Claude Desktop gives a tool
# call far less than this; the ceiling is deliberately loose so the test fails
# on a *regression* (the 113s ladder coming back) rather than on a slow CI box.
INTERACTIVE_CEILING_SECONDS = 45.0


@pytest.fixture()
def captioned(sample_video: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """A caption-rich indexed video: real frames, real index, real transcript.

    OCR stays off so the suite never downloads model weights — which also
    mirrors the failing case, where the answer had to come from captions.
    """
    monkeypatch.setenv("WATCHSKILL_OCR_ENABLED", "false")
    from watch_skill.config import reset_settings

    reset_settings()
    result = watch(
        str(sample_video), out_dir=tmp_path / "deadline work",
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


@pytest.fixture()
def no_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    """No VLM anywhere: a dead local endpoint and no binary to revive it.

    This is the acceptance condition, reproduced rather than simulated — the
    engine really does raise `vision.server_down` out of the real client.
    Port 9 (discard) refuses immediately; pinning the binary lookup to None is
    what keeps `ensure_ollama` from spending 25s trying to start a server that
    is not installed, which is exactly what it does on a machine without one.
    """
    from watch_skill.config import reset_settings
    from watch_skill.vision import local_health

    monkeypatch.setenv("WATCHSKILL_OLLAMA_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_PROVIDER", "ollama")
    monkeypatch.setenv("WATCHSKILL_VISION_STRONG_PROVIDER", "ollama")
    reset_settings()
    monkeypatch.setattr(local_health, "_ollama_binary", lambda: None)
    local_health.forget_liveness()
    ladder.reset_cost_model()


def _stamps(text: str) -> list[str]:
    return _TS.findall(text)


# --- the acceptance case ----------------------------------------------------

def test_transcript_question_answers_without_any_vision_backend(
    captioned: str, no_vision: None
) -> None:
    """The headline regression: caption evidence is enough, and it is fast.

    Asserted together on purpose. Bounded-but-useless (always abstain) and
    useful-but-unbounded (the 113s ladder) are both failures of the same
    contract, and a test that checked only one would pass on the other.
    """
    started = time.monotonic()
    answer = answer_question(captioned, "what are the two folders?", use_cache=False)
    elapsed = time.monotonic() - started

    assert elapsed < INTERACTIVE_CEILING_SECONDS, (
        f"the ask took {elapsed:.1f}s; an interactive client will not wait "
        f"that long. This is the 113s escalation regression.")
    assert answer.honest_floor is False, (
        "the transcript states the answer outright — abstaining here means "
        "transcript-grounded asks now require a vision backend, which the "
        "architecture says they must not")
    assert answer.evidence, "an answer must carry the evidence it stands on"
    assert _stamps(answer.text), "evidence must be cited with timestamps"


def test_answer_without_verification_says_so(captioned: str, no_vision: None) -> None:
    """Honesty is not traded for the answer.

    No model looked at anything, so nothing may claim it did — the answer is
    allowed to stand on retrieval, and required to admit that is all it has.
    """
    answer = answer_question(captioned, "what are the two folders?", use_cache=False)

    assert answer.verified is False, (
        "no vision provider was reachable, so no verify pass ran; reporting "
        "verified=True here would be the one thing worse than being slow")
    assert 0.0 <= answer.confidence <= 1.0


def test_absent_content_still_abstains_under_the_deadline(
    captioned: str, no_vision: None
) -> None:
    """The floor survives the fix.

    A bounded ladder must not become a lenient one: asking about something the
    video never mentions still refuses, and still invents no timestamp.
    """
    answer = answer_question(
        captioned, "what does the giraffe on the unicycle say?", use_cache=False
    )

    assert answer.honest_floor is True, "absent content must not produce an answer"
    assert answer.verified is False
    legal = {round(e.timestamp, 2) for e in answer.evidence if e.timestamp is not None}
    for token in _stamps(answer.text):
        parts = [int(p) for p in token.split(":")]
        seconds = parts[-1] + parts[-2] * 60 + (parts[-3] * 3600 if len(parts) == 3 else 0)
        assert any(abs(seconds - ts) <= 2.0 for ts in legal), (
            f"fabricated timestamp {token} in a refusal")


def test_ask_does_not_reprocess_the_video(
    captioned: str, no_vision: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A follow-up reads the index; it does not re-watch the source.

    The escalation rung calls `acquire(use_cache=True)`, which is a cache read
    — but on a cold media cache that same call re-fetches, so the guard is
    worth holding: nothing here may run the watch pipeline again.
    """
    import watch_skill.watch as watch_mod

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("ask re-ran the watch pipeline")

    monkeypatch.setattr(watch_mod, "watch", refuse)
    before = get_video(captioned)

    answer = answer_question(captioned, "what are the two folders?", use_cache=False)

    after = get_video(captioned)
    assert after["last_analyzed_at"] == before["last_analyzed_at"], (
        "last_analyzed_at moved — the video was processed again")
    assert after["content_digest"] == before["content_digest"], (
        "the indexed content changed identity under a read-only follow-up")
    assert answer.video_id == captioned


# --- the mechanism the fix rests on -----------------------------------------

def test_deadline_skips_the_ladder_rather_than_overrunning(
    captioned: str, no_vision: None
) -> None:
    """With no time to spend, the rungs are skipped and the answer says so."""
    started = time.monotonic()
    answer = answer_question(
        captioned, "what are the two folders?", use_cache=False, deadline_seconds=0.05
    )
    elapsed = time.monotonic() - started

    assert answer.deadline_stopped is True, (
        "a ladder cut short must report it, not look like a complete one")
    assert elapsed < INTERACTIVE_CEILING_SECONDS
    # Skipped work never masquerades as done work.
    assert not any(
        name in answer.escalations_used for name in ("dense_resample", "zoom_crops_reocr")
    ), f"a skipped rung was reported as run: {answer.escalations_used}"


def test_zero_deadline_opts_out_for_batch_callers(captioned: str, no_vision: None) -> None:
    """Batch/offline callers keep the old unbounded behaviour."""
    answer = answer_question(
        captioned, "what are the two folders?", use_cache=False, deadline_seconds=0
    )
    assert answer.deadline_stopped is False


def test_affordable_frames_shrinks_the_window_to_fit() -> None:
    """One window cannot start work it has no time to finish.

    The bug this encodes: the deadline was checked only *between* windows, so
    a window that legitimately cleared the check then ran 24s past it.
    """
    ladder.reset_cost_model()
    now = time.monotonic()

    # Cold: the OCR engine load alone (~40s) does not fit a 25s ask.
    assert ladder.affordable_frames(now + 25.0, 6.0, 12) == 0

    # Warm, generous: the full window fits.
    ladder._cost_model["warm"] = True
    ladder._cost_model["per_frame"] = 2.0
    assert ladder.affordable_frames(now + 600.0, 6.0, 12) == 12

    # Warm, tight: shrink rather than overrun. 20s - 6s reserve = 14s, at
    # 2.0s/frame that is 7 frames, less whatever this test itself has spent.
    assert ladder.affordable_frames(time.monotonic() + 20.0, 6.0, 12) in (6, 7)

    # No deadline at all: unchanged, uncapped behaviour.
    assert ladder.affordable_frames(None, 6.0, 12) == 12
    ladder.reset_cost_model()


def test_cost_model_learns_the_warm_per_frame_cost() -> None:
    """The estimate is measured on this machine, not assumed."""
    ladder.reset_cost_model()
    ladder._record_window(4, 40.0)  # first window: pays the OCR load, teaches nothing
    assert ladder._cost_model["warm"] is True
    assert ladder._cost_model["per_frame"] is None

    ladder._record_window(4, 8.0)  # warm: 2.0s/frame
    assert ladder._cost_model["per_frame"] == pytest.approx(2.0)
    ladder._record_window(4, 16.0)  # 4.0s/frame, EWMA-blended to 3.0
    assert ladder._cost_model["per_frame"] == pytest.approx(3.0)
    ladder.reset_cost_model()


def test_verify_call_is_capped_by_the_remaining_deadline(
    captioned: str, no_vision: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A local model that decides to load cannot outlive the ask.

    `vision_local_timeout_seconds` defaults to 900 — correct for batch
    indexing, and a fifteen-minute hang for an interactive follow-up. Only the
    HTTP boundary is intercepted here; the engine picks the number itself.
    """
    seen: list[float | None] = []

    from watch_skill.vision.client import VisionClient

    def record(self: VisionClient, prompt: str, images: object = None,
               timeout: float | None = None) -> str:
        seen.append(timeout)
        return '{"supported": true, "certainty": 0.9, "answer": "two folders"}'

    monkeypatch.setattr(VisionClient, "generate", record)

    answer_question(
        captioned, "what are the two folders?", use_cache=False, deadline_seconds=20.0
    )

    assert seen, "the verify pass never reached the client"
    assert seen[0] is not None, "the verify call inherited the 900s local default"
    assert seen[0] <= 20.0, f"verify timeout {seen[0]}s exceeds the ask's own deadline"
