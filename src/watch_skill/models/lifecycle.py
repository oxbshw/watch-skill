"""Model lifecycle: load once, report honestly, release when idle.

A live session runs several models with wildly different costs. Perceptual
hashing is free; OCR loads weights for tens of seconds; ASR and embeddings are
hundreds of megabytes each. Three failures follow from treating them alike,
and this module exists to prevent all three:

**Loading the same model twice.** A plain dict cache checked before a slow
constructor is a race, not a cache: two threads both miss, both construct, and
the machine pays twice for one model. Loading is single-flight — the second
caller waits for the first rather than starting its own.

**A slow model making everything look broken.** A detector that is still
warming is `initializing`, not absent and not failed. The distinction is what
lets a live session say "OCR is coming" instead of silently producing no text
events, which is indistinguishable from a screen with no text on it.

**Holding memory nobody is using.** Models are released after an idle period
and reloaded on demand, because the previous end-to-end run proved the
alternative: a parent process holding OCR and embedding weights it had
finished with, while a child process trying to answer a question was refused
the allocation.
"""
from __future__ import annotations

import gc
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from watch_skill.errors import WatchSkillError


class ModelState(str, Enum):  # noqa: UP042 — matches SourceKind
    UNLOADED = "unloaded"
    INITIALIZING = "initializing"
    READY = "ready"
    DEGRADED = "degraded"
    """Usable, but not as intended — a fallback is answering instead."""

    FAILED = "failed"
    UNLOADING = "unloading"


class ModelUnavailable(WatchSkillError):
    """A model could not be loaded. Callers degrade; they do not crash."""

    default_code = "models.unavailable"


DEFAULT_LOAD_TIMEOUT = 300.0
DEFAULT_IDLE_SECONDS = 600.0
_RETRY_COOLDOWN = 60.0
"""How long a failed model waits before anyone tries again. Without it, a
per-frame detector retries a missing model at the frame rate and turns one
missing dependency into a busy loop."""


@dataclass
class ModelStatus:
    """What a caller — or an operator reading live status — gets to know."""

    name: str
    state: ModelState = ModelState.UNLOADED
    reason: str = ""
    loaded_at: float | None = None
    last_used_at: float | None = None
    load_seconds: float | None = None
    failures: int = 0
    fallback: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"status": self.state.value}
        if self.reason:
            payload["reason"] = self.reason
        if self.state is ModelState.READY and self.load_seconds is not None:
            payload["load_seconds"] = round(self.load_seconds, 2)
        if self.fallback:
            payload["fallback"] = self.fallback
        if self.failures:
            payload["failures"] = self.failures
        return payload


@dataclass
class ManagedModel:
    """One named model and the machinery that keeps its loading honest."""

    name: str
    loader: Callable[[], Any]
    idle_seconds: float = DEFAULT_IDLE_SECONDS
    estimated_mb: int = 0
    fallback: str | None = None
    _instance: Any = None
    _status: ModelStatus = field(init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _ready: threading.Event = field(default_factory=threading.Event)
    _loading: bool = False
    _failed_at: float | None = None
    _announced: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._status = ModelStatus(name=self.name)

    @property
    def status(self) -> ModelStatus:
        return self._status

    def announce_once(self, key: str) -> bool:
        """True the first time a given condition is worth reporting.

        A degraded model must say so once, not on every frame. Repeating it
        at the frame rate buries the one line that mattered.
        """
        with self._lock:
            if key in self._announced:
                return False
            self._announced.add(key)
            return True

    def get(self, timeout: float = DEFAULT_LOAD_TIMEOUT) -> Any:
        """Return the loaded model, loading it if necessary.

        Single-flight: whichever caller arrives first performs the load and
        everyone else waits on the same event. The lock is released *before*
        the loader runs, so a thirty-second model load does not block callers
        that only wanted to read the status.
        """
        with self._lock:
            if self._instance is not None:
                self._status.last_used_at = time.time()
                return self._instance
            if self._failed_at is not None:
                if time.time() - self._failed_at < _RETRY_COOLDOWN:
                    raise ModelUnavailable(
                        f"{self.name} failed to load: {self._status.reason}",
                        code="models.load_failed",
                        fix=f"retrying is throttled for {_RETRY_COOLDOWN:.0f}s; "
                        "fix the underlying dependency and it will load again",
                        details={"model": self.name, "state": self._status.state.value},
                    )
                # Cooldown elapsed — a transient failure deserves another go.
                self._failed_at = None
                self._status.state = ModelState.UNLOADED
            if self._loading:
                waiter = self._ready
            else:
                self._loading = True
                self._ready = threading.Event()
                self._status.state = ModelState.INITIALIZING
                self._status.reason = ""
                waiter = None

        if waiter is not None:
            if not waiter.wait(timeout):
                raise ModelUnavailable(
                    f"{self.name} did not finish loading within {timeout:.0f}s",
                    code="models.load_timeout",
                    fix="the first load downloads weights; retry, or check "
                    "`watch-skill doctor` for disk and network problems",
                    details={"model": self.name},
                )
            with self._lock:
                if self._instance is None:
                    raise ModelUnavailable(
                        f"{self.name} failed to load: {self._status.reason}",
                        code="models.load_failed",
                        fix="see the reason above; other detectors continue "
                        "regardless",
                        details={"model": self.name},
                    )
                self._status.last_used_at = time.time()
                return self._instance

        started = time.monotonic()
        try:
            instance = self.loader()
        except Exception as exc:  # noqa: BLE001 - any load failure degrades
            with self._lock:
                self._loading = False
                self._failed_at = time.time()
                self._status.state = ModelState.FAILED
                self._status.reason = str(exc)[:200]
                self._status.failures += 1
                self._ready.set()
            raise ModelUnavailable(
                f"{self.name} failed to load: {exc}",
                code="models.load_failed",
                fix=getattr(exc, "fix", None)
                or "install the missing extra, or run `watch-skill doctor`",
                details={"model": self.name},
            ) from exc

        with self._lock:
            self._instance = instance
            self._loading = False
            self._status.state = ModelState.READY
            self._status.loaded_at = time.time()
            self._status.last_used_at = self._status.loaded_at
            self._status.load_seconds = time.monotonic() - started
            self._ready.set()
        return instance

    def release(self) -> bool:
        """Drop the reference and collect. True when something was freed.

        Only the reference is ours to drop; whether the memory actually
        returns is up to the runtime holding it. Native allocators sometimes
        keep their arenas, so this is a request, not a guarantee — and the
        docstring says so rather than the status implying otherwise.
        """
        with self._lock:
            if self._instance is None:
                return False
            self._status.state = ModelState.UNLOADING
            self._instance = None
            self._status.state = ModelState.UNLOADED
            self._status.loaded_at = None
            self._ready = threading.Event()
        gc.collect()
        return True

    def release_if_idle(self, now: float | None = None) -> bool:
        now = now or time.time()
        with self._lock:
            last = self._status.last_used_at
            idle = last is not None and (now - last) >= self.idle_seconds
            loaded = self._instance is not None
        return self.release() if (idle and loaded) else False


class ModelRegistry:
    """Every model this process knows how to load, and what state each is in."""

    def __init__(self) -> None:
        self._models: dict[str, ManagedModel] = {}
        self._lock = threading.Lock()

    def register(
        self,
        name: str,
        loader: Callable[[], Any],
        *,
        idle_seconds: float = DEFAULT_IDLE_SECONDS,
        estimated_mb: int = 0,
        fallback: str | None = None,
        replace: bool = False,
    ) -> ManagedModel:
        with self._lock:
            if name in self._models and not replace:
                return self._models[name]
            model = ManagedModel(
                name=name, loader=loader, idle_seconds=idle_seconds,
                estimated_mb=estimated_mb, fallback=fallback,
            )
            self._models[name] = model
            return model

    def get(self, name: str) -> ManagedModel:
        with self._lock:
            if name not in self._models:
                raise ModelUnavailable(
                    f"no model registered under {name!r}",
                    code="models.unknown",
                    fix=f"registered: {', '.join(sorted(self._models)) or '(none)'}",
                    details={"model": name},
                )
            return self._models[name]

    def load(self, name: str, timeout: float = DEFAULT_LOAD_TIMEOUT) -> Any:
        return self.get(name).get(timeout=timeout)

    def try_load(self, name: str, timeout: float = DEFAULT_LOAD_TIMEOUT) -> Any | None:
        """Load, or return None. For detectors that must degrade, not raise."""
        try:
            return self.load(name, timeout=timeout)
        except (ModelUnavailable, WatchSkillError):
            return None

    def warm(self, *names: str) -> list[threading.Thread]:
        """Start loading in the background and return immediately.

        The point of the whole module in one method: a session calls this at
        startup so slow models load *beside* the fast detectors rather than in
        front of them.
        """
        threads = []
        for name in names:
            model = self.get(name)
            if model.status.state in (ModelState.READY, ModelState.INITIALIZING):
                continue

            def warm_one(target: ManagedModel = model) -> None:
                try:
                    target.get()
                except WatchSkillError:
                    pass  # the status carries the reason; nothing to raise to

            thread = threading.Thread(
                target=warm_one, name=f"ws-warm-{name}", daemon=True
            )
            thread.start()
            threads.append(thread)
        return threads

    def status(self, name: str) -> ModelStatus:
        return self.get(name).status

    def snapshot(self, names: list[str] | None = None) -> dict[str, dict[str, Any]]:
        """The detector-readiness block that live status reports."""
        with self._lock:
            models = dict(self._models)
        selected = names or sorted(models)
        return {
            name: models[name].status.to_dict()
            for name in selected
            if name in models
        }

    def release(self, name: str) -> bool:
        return self.get(name).release()

    def release_all(self) -> int:
        """Free everything. Called before handing off to another process."""
        with self._lock:
            models = list(self._models.values())
        return sum(1 for model in models if model.release())

    def sweep_idle(self, now: float | None = None) -> list[str]:
        with self._lock:
            models = list(self._models.values())
        return [model.name for model in models if model.release_if_idle(now)]

    def registered(self) -> list[str]:
        with self._lock:
            return sorted(self._models)


_registry = ModelRegistry()


def get_registry() -> ModelRegistry:
    return _registry


def lifecycle_reset_for_tests() -> None:
    """Drop the process-wide registry.

    Model state is deliberately process-global — that is what makes loading
    single-flight across every caller — so tests need an explicit way to
    start clean rather than inheriting another test's loaded models.
    """
    global _registry
    _registry.release_all()
    _registry = ModelRegistry()


def register_builtin_models() -> ModelRegistry:
    """Register the models the engine ships, without loading any of them.

    Loaders are thunks: registering costs an import of this module and
    nothing else, so a process that never OCRs never pays for RapidOCR.
    """
    registry = get_registry()

    def load_ocr() -> Any:
        from watch_skill.perceive.ocr import _get_engine  # noqa: PLC0415

        return _get_engine()

    def load_embeddings() -> Any:
        from watch_skill.index.embeddings import MODEL_NAME, _get_model  # noqa: PLC0415

        model = _get_model(MODEL_NAME)
        if model is None:
            raise ModelUnavailable(
                "embeddings are unavailable",
                code="models.load_failed",
                fix="install the index extra: `uv sync --extra index`",
            )
        return model

    registry.register("ocr", load_ocr, estimated_mb=120)
    registry.register("visual_embedding", load_embeddings, estimated_mb=140)
    return registry
