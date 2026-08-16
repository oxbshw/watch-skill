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

CURRENT_STATE_WINDOW_SECONDS = 10.0
"""How late an answer may be and still be allowed to describe *now*.

On a CPU backend a keyframe interpretation takes tens of seconds, so almost
nothing clears this bar — which is the honest outcome, not a bug to tune away.
The window exists so that a faster backend is not punished for being fast, and
so that the slow one is visibly, measurably late rather than quietly pretending
to be current."""


class Freshness:
    """What an observation is still allowed to be used for.

    The three are not degrees of quality. A late reading is not a worse
    reading — it is an accurate statement about a moment that has passed, and
    the only thing it loses is the right to speak about the present.
    """

    CURRENT_STATE = "current_state"
    """Fresh enough to describe the source as it is now. May fire triggers."""

    STALE_FOR_ACTION = "stale_for_action"
    """True about its own timestamp, too late to act on. Queryable; inert."""

    HISTORICAL_EVIDENCE = "historical_evidence"
    """The source has ended, so there is no "now" left to be current about.
    Full-strength evidence about the frame it describes."""


def classify_freshness(
    late_by_seconds: float,
    source_running: bool,
    superseded: bool = False,
    window: float = CURRENT_STATE_WINDOW_SECONDS,
) -> str:
    """Decide what a finished interpretation may still be used for.

    A result is never discarded for arriving late. Lateness costs it the
    present tense and nothing else: it is persisted, queryable, and citable
    against the timestamp it actually describes.
    """
    if not source_running:
        return Freshness.HISTORICAL_EVIDENCE
    if superseded:
        # A newer reading has already been published. This one remains true
        # about its own frame, but the session's "current" state has moved on
        # and must not be walked backwards.
        return Freshness.STALE_FOR_ACTION
    if late_by_seconds <= window:
        return Freshness.CURRENT_STATE
    return Freshness.STALE_FOR_ACTION


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

    # --- provenance of the inference itself ---------------------------------
    # Not decoration. A reading that arrives 47 seconds after the frame it
    # describes is only usable if you can tell *which* frame that was and
    # *when* the answer showed up, so every one of these is persisted.

    revision: str = ""
    """The pinned model revision. "SmolVLM said so" is not reproducible; a
    forty-hex-character revision is."""

    worker_protocol_version: int = 0
    frame_sha256: str = ""
    frame_seq: int = -1
    capture_kind: str = ""
    captured_wall_ts: float = 0.0
    inference_started_wall_ts: float = 0.0
    inference_completed_wall_ts: float = 0.0
    latency_ms: float = 0.0

    freshness: str = Freshness.HISTORICAL_EVIDENCE
    late_by_seconds: float = 0.0
    superseded: bool = False
    selected_because: str = ""

    @property
    def may_trigger_current_state_action(self) -> bool:
        """Whether this reading is allowed to drive a present-tense action.

        The single question every trigger and action must ask. Kept as one
        property so the rule lives in one place rather than being re-derived,
        slightly differently, at each call site.
        """
        return self.freshness == Freshness.CURRENT_STATE and not self.degraded

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
            "provenance": {
                "provider": self.provider, "model": self.model,
                "kind": "model_inference", "revision": self.revision,
                "worker_protocol_version": self.worker_protocol_version,
                "capture_kind": self.capture_kind,
            },
            "frame": {
                "sha256": self.frame_sha256,
                "seq": self.frame_seq,
                "media_ts": round(self.media_ts, 3),
                "captured_wall_ts": round(self.captured_wall_ts, 3),
            },
            "timing": {
                "inference_started_wall_ts": round(
                    self.inference_started_wall_ts, 3),
                "inference_completed_wall_ts": round(
                    self.inference_completed_wall_ts, 3),
                "latency_ms": round(self.latency_ms, 1),
                "late_by_seconds": round(self.late_by_seconds, 3),
            },
            "freshness": self.freshness,
            "may_trigger_current_state_action":
                self.may_trigger_current_state_action,
            "superseded": self.superseded,
            "selected_because": self.selected_because,
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

    # Identity of the exact frame, carried so the answer can be pinned to it
    # tens of seconds later. Without these a late observation is a description
    # with nothing to attach it to.
    frame_seq: int = -1
    captured_wall_ts: float = 0.0
    capture_kind: str = ""

    @property
    def interest(self) -> int:
        """How much a model call on this frame is likely to be worth.

        Used only when frames are competing for one slot. A waiting question
        outranks a scene change because someone is blocked on the answer; the
        cadence floor ranks last because "it has been a while" is the weakest
        reason to spend forty seconds.
        """
        if self.question_pending:
            return 4
        if self.scene_changed:
            return 3
        if self.text_changed:
            return 2
        if self.trigger_interest:
            return 1
        return 0

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


QUEUE_LIMIT = 2
"""How many selected keyframes may wait for the model at once.

Two, not twenty. At tens of seconds per call a deep queue does not buy
throughput — it buys a backlog of answers about screens that are long gone,
and it does it while holding the frames on disk. When the queue is full the
*better* frame wins and the loser is recorded as dropped, which is strictly
more useful than either blocking capture or silently forgetting."""


class SemanticRuntime:
    """Runs a semantic backend over selected frames, without blocking capture.

    The capture path calls `consider` and gets an immediate answer. Everything
    slow happens on one worker thread behind a queue two frames deep, so a
    model that takes a minute per call can never stall video, audio, OCR,
    persistence or stop.
    """

    def __init__(
        self,
        backend: SemanticBackend | None,
        on_observation: Any,
        budget: int = 60,
        timeout: float = 25.0,
        queue_limit: int = QUEUE_LIMIT,
        source_running: Any = None,
    ) -> None:
        self.backend = backend
        self.on_observation = on_observation
        self.budget = budget
        self.timeout = timeout
        self.queue_limit = max(1, queue_limit)
        # Asked at completion time, not at submission time: whether the source
        # is still running is what separates "too late to act on" from
        # "historical evidence", and it can change during the call.
        self.source_running = source_running or (lambda: True)
        self.state = SelectionState()
        self.breaker = CircuitBreaker(threshold=3, cooldown=60.0)
        self._lock = threading.Lock()
        self._queue: list[tuple[FrameCandidate, str]] = []
        self._wake = threading.Condition(self._lock)
        self._inflight = False
        self._stopping = False
        self._worker: threading.Thread | None = None
        self._latest_applied_ts = -1.0
        self.failures = 0
        self.dropped_superseded = 0
        self.dropped_queue_full = 0
        self.published_late = 0
        self.drops: list[dict[str, Any]] = []
        self.degraded_reason = "" if backend else "no_semantic_backend"
        self.last_skip_reason = ""
        self.warm_state = "cold"
        self.warm_error = ""
        self.warm_seconds = 0.0

    @property
    def budget_remaining(self) -> int:
        return max(0, self.budget - self.state.interpreted)

    # --- lifetime ----------------------------------------------------------

    def warm(self) -> None:
        """Start loading the model now, on a thread, and return immediately.

        Called alongside source startup rather than at the first interesting
        frame. Loading is seconds of CPU; paying it lazily means the first
        thing worth interpreting is also the thing that waits for the loader.
        """
        if self.backend is None or not hasattr(self.backend, "warm"):
            self.warm_state = "unsupported"
            return
        self.warm_state = "warming"

        def run() -> None:
            started = time.monotonic()
            try:
                self.backend.warm()  # type: ignore[attr-defined]
                self.warm_state = "warm"
            except Exception as exc:  # noqa: BLE001 - warming is best-effort
                # A model that will not load must not stop a session that can
                # still capture video, audio, OCR and events without it.
                self.warm_state = "failed"
                self.warm_error = str(exc)[:200]
                self.degraded_reason = self.warm_error
            finally:
                self.warm_seconds = round(time.monotonic() - started, 2)

        threading.Thread(target=run, name="ws-vlm-warm", daemon=True).start()

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(
            target=self._drain, name="ws-live-semantic", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        """Stop accepting work and let the worker finish its current call."""
        with self._lock:
            self._stopping = True
            for candidate, reason in self._queue:
                self._record_drop(candidate, reason, "session_stopping")
            self._queue.clear()
            self._wake.notify_all()
        backend = self.backend
        if backend is not None and hasattr(backend, "close"):
            try:
                backend.close()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - shutdown is best-effort
                pass

    # --- submission --------------------------------------------------------

    def _record_drop(self, candidate: FrameCandidate, reason: str,
                     why: str) -> None:
        """Never silently. A frame that was selected and then not interpreted
        is a gap in the evidence, and a gap nobody can see is the worst kind."""
        self.drops.append({
            "media_ts": round(candidate.media_ts, 3),
            "frame_seq": candidate.frame_seq,
            "selected_because": reason,
            "dropped_because": why,
            "interest": candidate.interest,
        })
        del self.drops[:-200]
        if why == "superseded_by_better_frame":
            self.dropped_superseded += 1
        else:
            self.dropped_queue_full += 1

    def consider(self, candidate: FrameCandidate) -> bool:
        """Offer a frame. Returns True when it was queued for interpretation.

        Never blocks and never grows without bound. When the queue is full the
        most informative recent frame wins the slot and the loser is recorded.
        """
        if self.backend is None or self.breaker.open:
            self.last_skip_reason = (
                "circuit_open" if self.breaker.open else "no_backend"
            )
            return False
        with self._lock:
            if self._stopping:
                self.last_skip_reason = "stopping"
                return False
            # should_interpret commits its own bookkeeping on a yes.
            decide, reason = should_interpret(
                candidate, self.state, self.budget_remaining
            )
            self.last_skip_reason = reason
            if not decide:
                return False

            if len(self._queue) >= self.queue_limit:
                # Rank the incoming frame against what is already waiting.
                # Recency breaks ties: of two equally interesting frames the
                # newer one describes a screen closer to the present.
                worst_index = min(
                    range(len(self._queue)),
                    key=lambda i: (self._queue[i][0].interest,
                                   self._queue[i][0].media_ts),
                )
                worst = self._queue[worst_index][0]
                if (candidate.interest, candidate.media_ts) <= \
                        (worst.interest, worst.media_ts):
                    self._record_drop(candidate, reason, "queue_full")
                    self.last_skip_reason = "queue_full"
                    return False
                loser, loser_reason = self._queue.pop(worst_index)
                self._record_drop(loser, loser_reason,
                                  "superseded_by_better_frame")

            self._queue.append((candidate, reason))
            self._ensure_worker()
            self._wake.notify()
        return True

    # --- the slow half -----------------------------------------------------

    def _drain(self) -> None:
        """One frame at a time, forever. The single in-flight request."""
        while True:
            with self._lock:
                while not self._queue and not self._stopping:
                    self._wake.wait(timeout=1.0)
                if self._stopping and not self._queue:
                    return
                candidate, reason = self._queue.pop(0)
                self._inflight = True
            try:
                self._run(candidate, reason)
            finally:
                with self._lock:
                    self._inflight = False

    def _run(self, candidate: FrameCandidate, reason: str) -> None:
        started_wall = time.time()
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
        completed_wall = time.time()

        # Stamp the frame's identity onto the answer. Forty seconds after
        # capture this is the only thing tying the two together.
        observation.frame_seq = candidate.frame_seq
        observation.capture_kind = candidate.capture_kind
        observation.captured_wall_ts = candidate.captured_wall_ts
        observation.selected_because = reason
        if not observation.inference_started_wall_ts:
            observation.inference_started_wall_ts = started_wall
        observation.inference_completed_wall_ts = completed_wall
        if not observation.latency_ms:
            observation.latency_ms = (
                completed_wall - observation.inference_started_wall_ts) * 1000.0

        reference = candidate.captured_wall_ts or started_wall
        observation.late_by_seconds = max(0.0, completed_wall - reference)

        with self._lock:
            # A slow answer about an old frame is still true about that frame.
            # It is marked superseded so it cannot walk the session's current
            # state backwards, and then it is published anyway — discarding it
            # would throw away evidence for the sole crime of being late.
            superseded = observation.media_ts < self._latest_applied_ts
            observation.superseded = superseded
            if not superseded:
                self._latest_applied_ts = observation.media_ts

        observation.freshness = classify_freshness(
            observation.late_by_seconds,
            source_running=bool(self.source_running()),
            superseded=superseded,
        )
        if observation.freshness != Freshness.CURRENT_STATE:
            self.published_late += 1

        if candidate.artifact_id:
            observation.evidence_artifact_ids = [candidate.artifact_id]
        observation.degraded = observation.degraded or bool(
            observation.degraded_reason)
        self.on_observation(observation, reason)

    def status(self) -> dict[str, Any]:
        if self.backend is None:
            return {"status": "degraded", "reason": "no_semantic_backend"}
        if self.breaker.open:
            return {"status": "degraded", "reason": self.degraded_reason
                    or "circuit_open", "backend": self.backend.name}
        with self._lock:
            queued, inflight = len(self._queue), self._inflight
        return {
            "status": "ready",
            "backend": self.backend.name,
            "interpreted": self.state.interpreted,
            "considered": self.state.considered,
            "budget_remaining": self.budget_remaining,
            "last_skip_reason": self.last_skip_reason,
            "failures": self.failures,
            "queued": queued,
            "inflight": inflight,
            "warm_state": self.warm_state,
        }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            queued = len(self._queue)
        return {
            "considered": self.state.considered,
            "interpreted": self.state.interpreted,
            "skipped_cadence": self.state.skipped_cadence,
            "skipped_duplicate": self.state.skipped_duplicate,
            "skipped_budget": self.state.skipped_budget,
            "budget_remaining": self.budget_remaining,
            "failures": self.failures,
            "queued": queued,
            "queue_limit": self.queue_limit,
            "dropped_queue_full": self.dropped_queue_full,
            "dropped_superseded": self.dropped_superseded,
            "published_late": self.published_late,
            "warm_state": self.warm_state,
            "warm_seconds": self.warm_seconds,
            "warm_error": self.warm_error,
            "drops": list(self.drops[-20:]),
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
