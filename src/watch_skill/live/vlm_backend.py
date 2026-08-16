"""The external vision model, wearing the semantic-backend interface.

`VlmWorker` proves a model can read a picture. This is what makes that useful
during a live session: it hashes the frame it sent, records when the answer
started and finished, and hands back an observation that can still be pinned
to the right moment a minute later.

Two things this module refuses to pretend about.

**The model writes prose, not JSON.** A 256M model asked for a schema will
sometimes produce one and sometimes produce a sentence, and — measured, not
guessed — when given an example object it copies the example's *contents*.
Asked for `{"scene": "a login page", ...}` as a format sample it replied
`{"scene": "a login page"}` about a checkout screen. So it is asked the
question it can answer, in prose, and the structure around that prose is
derived here by deterministic code that cannot hallucinate. The schema is
honest about which half is which: `scene` is the model's, everything derived
is marked as such.

**Late is not wrong.** Interpretation costs tens of seconds on this hardware.
The answer is still a true statement about the frame it was given, so it is
timestamped against that frame and published. What lateness costs it is the
right to speak in the present tense, and that is decided by `Freshness`, not
here.
"""
from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path
from typing import Any

from watch_skill.live.semantic import SemanticObservation
from watch_skill.live.vlm_worker import PROTOCOL_VERSION, VlmWorker

MAX_EDGE = 512
"""The accuracy floor, not a performance setting.

Measured on this model: at 384 px it read a red "Order Status Failed" banner
as a button labelled "Submitter" — it did not fail, it produced a confident
wrong answer. Downscaling is the cheapest latency lever available and also the
one that silently costs comprehension, so this does not move."""

MAX_NEW_TOKENS = 32
"""Decode length, and the only latency lever that does not cost accuracy.

Measured: the receipt's 47.1 s p50 was taken at 32 tokens. Raising it to 64
roughly doubles decode time for output this backend never uses — the answer
wanted here is one sentence, which lands in about 20 tokens. In a live session
the model also shares a four-thread CPU with capture and OCR, and at 64 tokens
not one inference completed inside a 130-second source. At 32 they do.

Unlike `MAX_EDGE`, lowering this does not make the model read the screen worse;
it only stops it writing more than was asked for."""

_QUESTION = (
    "Describe this screen in one short sentence. "
    "Include any large or highlighted text exactly as it appears."
)
"""No example answer, deliberately. This model parrots sample values."""

_ANOMALY_WORDS = (
    "fail", "failed", "failure", "error", "exception", "crash", "denied",
    "invalid", "timeout", "timed out", "offline", "unavailable", "nan",
    "undefined", "null", "not found", "500", "404", "refused",
)

_SUCCESS_WORDS = (
    "success", "succeeded", "complete", "completed", "confirmed", "approved",
    "ok", "done", "ready", "delivered", "paid",
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def derive_structure(prose: str) -> dict[str, Any]:
    """Turn one sentence of model prose into schema fields, deterministically.

    Every field here is produced by code reading the model's words — never by
    the model filling in a field directly. That distinction is the whole
    point: a hallucinated `anomaly` would be a model inventing an alarm, while
    a derived one is only ever "the description it wrote contains this word".

    Confidence is deliberately unflattering. The model supplies none, and a
    256M model reading downscaled text does not earn a high one.
    """
    text = (prose or "").strip()
    lowered = text.lower()

    anomaly_hits = [word for word in _ANOMALY_WORDS
                    if re.search(rf"\b{re.escape(word)}\b", lowered)]
    success_hits = [word for word in _SUCCESS_WORDS
                    if re.search(rf"\b{re.escape(word)}\b", lowered)]

    # Quoted or capitalised runs are the model's attempt at on-screen text.
    # Kept as entities because "what words did it think it saw" is exactly
    # what a later question wants to search.
    quoted = re.findall(r'"([^"]{2,60})"', text)
    shouted = re.findall(r"\b[A-Z][A-Z0-9 ]{3,40}\b", text)
    entities = []
    for item in [*quoted, *shouted]:
        cleaned = item.strip()
        if cleaned and cleaned.lower() not in {e.lower() for e in entities}:
            entities.append(cleaned[:120])

    return {
        "scene": text[:600],
        "entities": entities[:6],
        "anomaly": (f"description mentions {', '.join(anomaly_hits[:4])}"
                    if anomaly_hits else ""),
        "ui_state": ("apparent_failure" if anomaly_hits
                     else "apparent_success" if success_hits else ""),
        "uncertainty": ("" if text else "the model returned no text"),
        # Low on purpose. This is a small model reading a downscaled image,
        # and a number that flattered it would be the most misleading field
        # in the record.
        "confidence": 0.4 if text else 0.0,
        "derived_signals": {
            "anomaly_words": anomaly_hits[:8],
            "success_words": success_hits[:8],
        },
    }


class SmolVlmSemanticBackend:
    """A real local vision model on the live semantic path.

    Single-flight by construction — `VlmWorker` serialises on its own lock —
    so this never needs its own concurrency control. The queue and the
    backpressure live one level up in `SemanticRuntime`, where they can see
    which frame is worth the slot.
    """

    def __init__(self, worker: VlmWorker | None = None, *,
                 interpreter: str | None = None,
                 model: str = "", revision: str = "",
                 max_edge: int = MAX_EDGE,
                 max_new_tokens: int = MAX_NEW_TOKENS,
                 question: str = _QUESTION) -> None:
        self.worker = worker or VlmWorker(
            interpreter, model=model, revision=revision,
            max_edge=max_edge, max_new_tokens=max_new_tokens,
        )
        self.question = question
        self.name = f"vlm:{self.worker.model.split('/')[-1]}"
        self.latencies_ms: list[float] = []

    def warm(self) -> dict[str, Any]:
        """Load the model. Slow, blocking, and called on a warming thread."""
        return self.worker.ensure_loaded()

    def close(self) -> None:
        self.worker.stop()

    def interpret(
        self, frames: list[Path], media_ts: float, question: str = ""
    ) -> SemanticObservation:
        frame = Path(frames[0])
        digest = _sha256(frame)
        started = time.time()
        try:
            reply = self.worker.interpret(frame, question=question or self.question)
        except Exception as exc:  # noqa: BLE001 - degrade, never fail the session
            completed = time.time()
            return SemanticObservation(
                media_ts=media_ts, provider="vlm-worker",
                model=self.worker.model, revision=self.worker.revision,
                worker_protocol_version=PROTOCOL_VERSION,
                frame_sha256=digest,
                inference_started_wall_ts=started,
                inference_completed_wall_ts=completed,
                latency_ms=(completed - started) * 1000.0,
                degraded=True,
                degraded_reason=f"{type(exc).__name__}: {str(exc)[:160]}",
                confidence=0.0,
            )
        completed = time.time()
        latency_ms = (completed - started) * 1000.0
        self.latencies_ms.append(latency_ms)

        text = str(reply.get("text") or "")
        derived = derive_structure(text)
        observation = SemanticObservation(
            media_ts=media_ts,
            provider="vlm-worker",
            # Reported by the worker rather than assumed from configuration:
            # what actually answered is the thing worth recording.
            model=str(reply.get("model") or self.worker.model),
            revision=str(reply.get("revision") or self.worker.revision),
            worker_protocol_version=int(
                reply.get("protocol_version") or PROTOCOL_VERSION),
            frame_sha256=digest,
            inference_started_wall_ts=started,
            inference_completed_wall_ts=completed,
            latency_ms=latency_ms,
            scene=derived["scene"],
            entities=derived["entities"],
            anomaly=derived["anomaly"],
            ui_state=derived["ui_state"],
            uncertainty=derived["uncertainty"],
            confidence=derived["confidence"],
            degraded=not text,
            degraded_reason="" if text else "the model returned no text",
        )
        return observation

    def diagnostics(self) -> dict[str, Any]:
        data = self.worker.diagnostics()
        if self.latencies_ms:
            ordered = sorted(self.latencies_ms)
            data["latency_ms"] = {
                "count": len(ordered),
                "p50": round(ordered[len(ordered) // 2], 1),
                "p95": round(ordered[min(len(ordered) - 1,
                                         int(len(ordered) * 0.95))], 1),
                "max": round(ordered[-1], 1),
            }
        return data


def build_vlm_backend(interpreter: str | None = None, *, model: str = "",
                      revision: str = "") -> SmolVlmSemanticBackend | None:
    """Build the real-model backend, or None when none is configured.

    Returns None rather than raising: a session with no model configured is a
    normal session that captures everything else.
    """
    import os  # noqa: PLC0415

    if not (interpreter or os.environ.get("WATCHSKILL_VLM_PYTHON")):
        return None
    try:
        return SmolVlmSemanticBackend(
            interpreter=interpreter, model=model, revision=revision)
    except Exception:  # noqa: BLE001 - a bad interpreter is a degraded session
        return None


__all__ = [
    "MAX_EDGE",
    "MAX_NEW_TOKENS",
    "SmolVlmSemanticBackend",
    "build_vlm_backend",
    "derive_structure",
]
