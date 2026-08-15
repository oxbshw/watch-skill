"""Semantic vision on *selected* frames — never on the stream.

A model that runs once per frame is unaffordable within a minute and slower
than the video it is watching. So the expensive question is not "what does
this frame show" but "which handful of frames are worth asking about", and
most of this module is that selector.

A frame earns an interpretation when something changed (a new scene, new
on-screen text), when a question is waiting for one, or when the cadence floor
says it has simply been too long. Everything else is handled by the free local
detectors that already run.

Two rules carried over from fusion, because a model makes them matter more:

* **Observation and inference never share a sentence.** A VLM's reading of a
  picture is an inference about a picture, and the schema keeps it labelled.
* **A model verdict is never deterministic verification.** Semantic output is
  advisory. It informs; it does not decide.
"""
from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, Field, ValidationError

from watch_skill.errors import WatchSkillError
from watch_skill.live.pipeline import CircuitBreaker
from watch_skill.live.types import LIVE_SCHEMA_VERSION

MIN_INTERVAL_SECONDS = 3.0
"""Never interpret two frames closer together than this, however much
changes. Without a floor, a flickering page becomes a per-frame model call
through the side door."""

MAX_INTERVAL_SECONDS = 30.0
"""Interpret at least this often even when nothing appears to change — a
static screen is itself worth one observation, and a session that reports
nothing for minutes is indistinguishable from a broken one."""


class SemanticUnavailable(WatchSkillError):
    """No semantic backend could be used. Callers degrade; they do not fail."""

    default_code = "live.semantic_unavailable"


class SemanticObservation(BaseModel):
    """A model's structured reading of one moment.

    Every field is explicitly *what the model said*, not what is true. The
    caller decides what to do with that; nothing here is a verdict.
    """

    schema_version: int = LIVE_SCHEMA_VERSION
    media_ts: float
    scene: str = ""
    """A plain description of what is visible."""

    entities: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    ui_state: str = ""
    anomaly: str = ""
    """Something the model considered wrong. Advisory — an anomaly here has
    not been verified by anything."""

    uncertainty: str = ""
    """What the model said it could not tell. Kept because "I cannot see the
    total" is more useful than a confident guess about the total."""

    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    provider: str = ""
    model: str = ""
    evidence_artifact_ids: list[str] = Field(default_factory=list)
    degraded: bool = False
    degraded_reason: str = ""

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "media_ts": round(self.media_ts, 3),
            "observation": self.scene,
            "entities": self.entities,
            "actions": self.actions,
            "ui_state": self.ui_state,
            "anomaly": self.anomaly,
            "uncertainty": self.uncertainty,
            "confidence": round(self.confidence, 3),
            "provenance": {"provider": self.provider, "model": self.model,
                           "kind": "model_inference"},
            "evidence": self.evidence_artifact_ids,
            "advisory": True,
            "degraded": self.degraded,
            "degraded_reason": self.degraded_reason,
        }


class SemanticBackend(Protocol):
    """Anything that can interpret a small set of frames."""

    name: str

    def interpret(
        self, frames: list[Path], media_ts: float, question: str = ""
    ) -> SemanticObservation:
        ...


# --- selection ----------------------------------------------------------------


@dataclass
class SelectionState:
    """What the selector remembers between frames. Deliberately tiny."""

    last_interpreted_ts: float = -1e9
    last_signature: str = ""
    interpreted: int = 0
    considered: int = 0
    skipped_cadence: int = 0
    skipped_duplicate: int = 0
    skipped_budget: int = 0


@dataclass
class FrameCandidate:
    """A frame the local detectors already had a reason to notice."""

    path: Path
    media_ts: float
    artifact_id: str = ""
    scene_changed: bool = False
    text_changed: bool = False
    visible_text: str = ""
    question_pending: bool = False
    trigger_interest: bool = False

    @property
    def signature(self) -> str:
        """A cheap identity for "we have already interpreted this view".

        Built from the on-screen text rather than the pixels: two frames of a
        blinking cursor differ pixel-wise and mean the same thing, and paying
        a model to say so twice is the waste this prevents.
        """
        return re.sub(r"\s+", " ", self.visible_text.lower()).strip()[:400]


def should_interpret(
    candidate: FrameCandidate,
    state: SelectionState,
    budget_remaining: int,
    min_interval: float = MIN_INTERVAL_SECONDS,
    max_interval: float = MAX_INTERVAL_SECONDS,
) -> tuple[bool, str]:
    """Decide whether one frame is worth a model call. Returns (decision, why).

    **Commits its own bookkeeping on a positive decision.** The decision and
    the state it depends on belong together: when the caller was responsible
    for advancing `last_interpreted_ts`, any path that decided without
    committing left the cadence floor permanently open.

    The reason is returned rather than logged so status can explain a quiet
    session — "nothing changed" and "the budget ran out" look identical from
    the outside and are very different problems.
    """
    state.considered += 1
    since = candidate.media_ts - state.last_interpreted_ts

    def accept(reason: str) -> tuple[bool, str]:
        state.last_interpreted_ts = candidate.media_ts
        state.last_signature = candidate.signature
        state.interpreted += 1
        return True, reason

    if budget_remaining <= 0:
        state.skipped_budget += 1
        return False, "budget_exhausted"

    # The cadence floor wins over every interest signal, including a pending
    # question: an agent asking repeatedly must not become a way to bypass it.
    if since < min_interval:
        state.skipped_cadence += 1
        return False, "min_interval"

    if candidate.scene_changed or candidate.text_changed:
        signature = candidate.signature
        if signature and signature == state.last_signature:
            state.skipped_duplicate += 1
            return False, "unchanged_view"
        return accept("scene_change" if candidate.scene_changed else "text_change")

    if candidate.question_pending:
        return accept("question_pending")
    if candidate.trigger_interest:
        return accept("trigger_interest")

    # Checked last: a change is a better explanation than "it has been a
    # while", and the first frame of a session reaches here with `since`
    # effectively infinite.
    if since >= max_interval:
        return accept("max_interval")

    return False, "no_change"


# --- backends -----------------------------------------------------------------


_PROMPT = """You are observing one moment of a screen or video recording.

Reply with ONLY a JSON object, no prose, using exactly these keys:
{
  "scene": "one sentence describing what is visible",
  "entities": ["named things visible, at most 6"],
  "actions": ["what appears to be happening, at most 3"],
  "ui_state": "the state of the interface, or empty",
  "anomaly": "anything that looks wrong, or empty",
  "uncertainty": "what you cannot determine from this image, or empty",
  "confidence": 0.0
}

Describe only what is visible. Do not speculate about causes."""


class ProviderSemanticBackend:
    """Interprets frames through the configured vision provider.

    Local (Ollama, a custom OpenAI-compatible server) or cloud — the choice is
    the existing provider configuration, and the egress policy is enforced
    inside the client rather than here, so this cannot become a way around it.
    """

    def __init__(self, tier: str = "cheap", provider: str | None = None,
                 model: str | None = None, timeout: float = 25.0) -> None:
        self.tier = tier
        self.provider = provider
        self.model = model
        self.timeout = timeout
        self.name = f"vision:{provider or 'configured'}"

    def interpret(
        self, frames: list[Path], media_ts: float, question: str = ""
    ) -> SemanticObservation:
        from watch_skill.vision.model import get_vision  # noqa: PLC0415

        vision = get_vision(tier=self.tier, provider=self.provider,
                            model=self.model, phase="live_semantic")
        prompt = _PROMPT
        if question:
            prompt += f"\n\nThe viewer is asking: {question}"
        raw = vision.client.generate(prompt, images=frames[:2])
        return parse_observation(
            raw, media_ts,
            provider=getattr(vision.client, "provider", self.provider or ""),
            model=getattr(vision.client, "model", self.model or ""),
        )


class DeterministicSemanticBackend:
    """A scripted backend for testing the pipeline, not the understanding.

    Returns observations from a fixture keyed by time. It sees nothing — it
    names itself in every observation it produces, and a test using it proves
    selection, ordering, timeout handling and schema validation, never that a
    model understood a picture.
    """

    name = "deterministic-semantic"

    def __init__(self, script: list[dict[str, Any]] | None = None,
                 delay: float = 0.0) -> None:
        self.script = script or []
        self.delay = delay
        self.calls: list[float] = []

    def interpret(
        self, frames: list[Path], media_ts: float, question: str = ""
    ) -> SemanticObservation:
        self.calls.append(media_ts)
        if self.delay:
            time.sleep(self.delay)
        for entry in self.script:
            if float(entry.get("start", 0)) <= media_ts <= float(entry.get("end", 1e9)):
                return SemanticObservation(
                    media_ts=media_ts, provider="deterministic",
                    model=self.name, confidence=float(entry.get("confidence", 1.0)),
                    scene=str(entry.get("scene", "")),
                    entities=list(entry.get("entities", [])),
                    actions=list(entry.get("actions", [])),
                    ui_state=str(entry.get("ui_state", "")),
                    anomaly=str(entry.get("anomaly", "")),
                    uncertainty=str(entry.get("uncertainty", "")),
                )
        return SemanticObservation(
            media_ts=media_ts, provider="deterministic", model=self.name,
            scene="nothing scripted for this moment", confidence=0.0,
        )


def parse_observation(
    raw: str, media_ts: float, provider: str = "", model: str = ""
) -> SemanticObservation:
    """Validate model output against the schema.

    Malformed output becomes a *degraded* observation rather than an
    exception or, worse, a plausible-looking guess. A model that returns prose
    where JSON was asked for has told us something useful — that it is not
    usable here — and that belongs in the record.
    """
    text = (raw or "").strip()
    # Try the whole response first so a bare array reports "not an object"
    # rather than "no JSON" — the two say different things about the model.
    payload: Any = None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if match is None:
            return SemanticObservation(
                media_ts=media_ts, provider=provider, model=model,
                degraded=True, degraded_reason="no_json_in_response",
                uncertainty=text[:200], confidence=0.0,
            )
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            return SemanticObservation(
                media_ts=media_ts, provider=provider, model=model,
                degraded=True, degraded_reason=f"invalid_json: {exc.msg}",
                confidence=0.0,
            )
    if not isinstance(payload, dict):
        return SemanticObservation(
            media_ts=media_ts, provider=provider, model=model,
            degraded=True, degraded_reason="json_was_not_an_object",
            confidence=0.0,
        )

    def as_list(value: Any, cap: int) -> list[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        return [str(item)[:120] for item in value[:cap] if str(item).strip()]

    try:
        return SemanticObservation(
            media_ts=media_ts, provider=provider, model=model,
            scene=str(payload.get("scene", ""))[:600],
            entities=as_list(payload.get("entities"), 6),
            actions=as_list(payload.get("actions"), 3),
            ui_state=str(payload.get("ui_state", ""))[:200],
            anomaly=str(payload.get("anomaly", ""))[:300],
            uncertainty=str(payload.get("uncertainty", ""))[:300],
            confidence=max(0.0, min(1.0, float(payload.get("confidence", 0.5)))),
        )
    except (ValidationError, TypeError, ValueError) as exc:
        return SemanticObservation(
            media_ts=media_ts, provider=provider, model=model,
            degraded=True, degraded_reason=f"schema_violation: {exc}",
            confidence=0.0,
        )


# --- the runtime --------------------------------------------------------------


class SemanticRuntime:
    """Runs a semantic backend over selected frames, without blocking capture."""

    def __init__(
        self,
        backend: SemanticBackend | None,
        on_observation: Any,
        budget: int = 60,
        timeout: float = 25.0,
    ) -> None:
        self.backend = backend
        self.on_observation = on_observation
        self.budget = budget
        self.timeout = timeout
        self.state = SelectionState()
        self.breaker = CircuitBreaker(threshold=3, cooldown=60.0)
        self._lock = threading.Lock()
        self._inflight = False
        self._latest_applied_ts = -1.0
        self.failures = 0
        self.degraded_reason = "" if backend else "no_semantic_backend"
        self.last_skip_reason = ""

    @property
    def budget_remaining(self) -> int:
        return max(0, self.budget - self.state.interpreted)

    def consider(self, candidate: FrameCandidate) -> bool:
        """Offer a frame. Returns True when it was sent for interpretation.

        Never blocks: if a call is already in flight the frame is skipped
        rather than queued, because by the time a backlog cleared its answer
        would describe a screen that has moved on.
        """
        if self.backend is None or self.breaker.open:
            self.last_skip_reason = (
                "circuit_open" if self.breaker.open else "no_backend"
            )
            return False
        with self._lock:
            if self._inflight:
                self.last_skip_reason = "already_running"
                return False
            # should_interpret commits its own bookkeeping on a yes.
            decide, reason = should_interpret(
                candidate, self.state, self.budget_remaining
            )
            self.last_skip_reason = reason
            if not decide:
                return False
            self._inflight = True

        threading.Thread(
            target=self._run, args=(candidate, reason),
            name="ws-live-semantic", daemon=True,
        ).start()
        return True

    def _run(self, candidate: FrameCandidate, reason: str) -> None:
        try:
            observation = self.backend.interpret(
                [candidate.path], candidate.media_ts
            )
            self.breaker.record_success()
        except Exception as exc:  # noqa: BLE001 - a bad provider degrades only itself
            self.failures += 1
            self.degraded_reason = str(exc)[:160]
            if self.breaker.record_failure():
                self.degraded_reason = (
                    f"provider failed {self.breaker.threshold}x; paused for "
                    f"{self.breaker.cooldown:.0f}s"
                )
            return
        finally:
            with self._lock:
                self._inflight = False

        with self._lock:
            # A slow answer about an old frame must not overwrite a newer
            # reading. Out-of-order completion is the normal case when the
            # provider's latency varies, and publishing it would make the
            # session's "current" state go backwards in time.
            if observation.media_ts < self._latest_applied_ts:
                return
            self._latest_applied_ts = observation.media_ts

        if candidate.artifact_id:
            observation.evidence_artifact_ids = [candidate.artifact_id]
        observation.degraded = observation.degraded or bool(self.degraded_reason)
        self.on_observation(observation, reason)

    def status(self) -> dict[str, Any]:
        if self.backend is None:
            return {"status": "degraded", "reason": "no_semantic_backend"}
        if self.breaker.open:
            return {"status": "degraded", "reason": self.degraded_reason
                    or "circuit_open", "backend": self.backend.name}
        return {
            "status": "ready",
            "backend": self.backend.name,
            "interpreted": self.state.interpreted,
            "considered": self.state.considered,
            "budget_remaining": self.budget_remaining,
            "last_skip_reason": self.last_skip_reason,
            "failures": self.failures,
        }

    def stats(self) -> dict[str, Any]:
        return {
            "considered": self.state.considered,
            "interpreted": self.state.interpreted,
            "skipped_cadence": self.state.skipped_cadence,
            "skipped_duplicate": self.state.skipped_duplicate,
            "skipped_budget": self.state.skipped_budget,
            "budget_remaining": self.budget_remaining,
            "failures": self.failures,
        }


def build_semantic_backend(
    enabled: bool = False, provider: str | None = None, model: str | None = None
) -> SemanticBackend | None:
    """Choose a semantic backend, or None when live semantics are off.

    Off by default, and deliberately so: interpreting frames costs money or
    GPU on every session, and a feature that quietly starts spending is one
    nobody consented to.
    """
    if not enabled:
        return None
    from watch_skill.policy import Channel, get_policy  # noqa: PLC0415

    decision = get_policy().check(Channel.FRAMES, provider=provider)
    if not decision.allowed:
        return None
    return ProviderSemanticBackend(provider=provider, model=model)
