"""Model lifecycle: load once, degrade alone, release when idle."""
from __future__ import annotations

import threading
import time

import pytest

from watch_skill.models.lifecycle import (
    ModelRegistry,
    ModelState,
    ModelUnavailable,
    lifecycle_reset_for_tests,
)


@pytest.fixture
def registry() -> ModelRegistry:
    return ModelRegistry()


# --- single flight ------------------------------------------------------------


def test_concurrent_callers_load_a_model_exactly_once(
    registry: ModelRegistry,
) -> None:
    """The headline guarantee.

    A plain dict cache checked before a slow constructor is a race: every
    thread misses, every thread builds. The loader counts its own calls, so
    a regression here is unmissable.
    """
    loads = []
    barrier = threading.Barrier(8)

    def slow_loader() -> object:
        loads.append(1)
        time.sleep(0.3)
        return object()

    registry.register("slow", slow_loader)
    results: list[object] = []

    def worker() -> None:
        barrier.wait()
        results.append(registry.load("slow"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert len(loads) == 1, f"the model was constructed {len(loads)} times"
    assert len(results) == 8
    assert len({id(r) for r in results}) == 1, "callers got different instances"


def test_a_loading_model_reports_initializing_not_missing(
    registry: ModelRegistry,
) -> None:
    release = threading.Event()
    registry.register("slow", lambda: (release.wait(5), object())[1])
    threading.Thread(target=lambda: registry.try_load("slow"), daemon=True).start()

    deadline = time.time() + 5
    while time.time() < deadline:
        if registry.status("slow").state is ModelState.INITIALIZING:
            break
        time.sleep(0.02)
    assert registry.status("slow").state is ModelState.INITIALIZING
    release.set()


# --- failure is isolated ------------------------------------------------------


def test_a_failed_model_degrades_only_itself(registry: ModelRegistry) -> None:
    registry.register("broken", lambda: (_ for _ in ()).throw(RuntimeError("nope")))
    registry.register("fine", lambda: "loaded")

    with pytest.raises(ModelUnavailable) as raised:
        registry.load("broken")
    assert raised.value.fix
    assert registry.status("broken").state is ModelState.FAILED
    assert registry.load("fine") == "loaded", "one failure took down another model"
    assert registry.status("fine").state is ModelState.READY


def test_try_load_returns_none_rather_than_raising(registry: ModelRegistry) -> None:
    """Detectors must degrade, not crash the pipeline they run in."""
    registry.register("broken", lambda: (_ for _ in ()).throw(RuntimeError("nope")))
    assert registry.try_load("broken") is None


def test_a_failed_load_is_not_retried_on_every_call(
    registry: ModelRegistry,
) -> None:
    """A per-frame detector must not turn a missing model into a busy loop."""
    attempts = []

    def loader() -> object:
        attempts.append(1)
        raise RuntimeError("still missing")

    registry.register("broken", loader)
    for _ in range(20):
        registry.try_load("broken")
    assert len(attempts) == 1, f"retried {len(attempts)} times inside the cooldown"


def test_a_degraded_model_is_announced_once(registry: ModelRegistry) -> None:
    model = registry.register("broken", lambda: (_ for _ in ()).throw(OSError("x")))
    assert model.announce_once("missing") is True
    for _ in range(50):
        assert model.announce_once("missing") is False


def test_an_unknown_model_names_what_is_registered(registry: ModelRegistry) -> None:
    registry.register("known", lambda: 1)
    with pytest.raises(ModelUnavailable) as raised:
        registry.load("nope")
    assert raised.value.code == "models.unknown"
    assert "known" in raised.value.fix


# --- release ------------------------------------------------------------------


def test_release_drops_the_backend_reference(registry: ModelRegistry) -> None:
    registry.register("m", lambda: {"weights": "big"})
    registry.load("m")
    assert registry.status("m").state is ModelState.READY
    assert registry.release("m") is True
    assert registry.status("m").state is ModelState.UNLOADED
    assert registry.release("m") is False, "releasing twice should be a no-op"


def test_a_released_model_reloads_on_demand(registry: ModelRegistry) -> None:
    loads = []
    registry.register("m", lambda: (loads.append(1), "x")[1])
    registry.load("m")
    registry.release("m")
    assert registry.load("m") == "x"
    assert len(loads) == 2


def test_idle_models_are_swept_and_busy_ones_are_not(
    registry: ModelRegistry,
) -> None:
    registry.register("idle", lambda: "a", idle_seconds=0.0)
    registry.register("busy", lambda: "b", idle_seconds=3600.0)
    registry.load("idle")
    registry.load("busy")

    swept = registry.sweep_idle()
    assert swept == ["idle"]
    assert registry.status("busy").state is ModelState.READY


def test_release_all_frees_everything(registry: ModelRegistry) -> None:
    """What a process calls before handing work to another one."""
    for name in ("a", "b", "c"):
        registry.register(name, lambda: object())
        registry.load(name)
    assert registry.release_all() == 3
    assert all(
        registry.status(name).state is ModelState.UNLOADED for name in ("a", "b", "c")
    )


# --- diagnostics --------------------------------------------------------------


def test_the_snapshot_is_the_shape_live_status_publishes(
    registry: ModelRegistry,
) -> None:
    registry.register("ocr", lambda: "engine")
    registry.register("asr", lambda: (_ for _ in ()).throw(RuntimeError("no model")))
    registry.load("ocr")
    registry.try_load("asr")

    snapshot = registry.snapshot()
    assert snapshot["ocr"]["status"] == "ready"
    assert snapshot["asr"]["status"] == "failed"
    assert snapshot["asr"]["reason"]


def test_warm_returns_immediately_and_loads_in_the_background(
    registry: ModelRegistry,
) -> None:
    """The whole point: slow models load *beside* fast detectors."""
    registry.register("slow", lambda: (time.sleep(0.4), "ready")[1])
    started = time.monotonic()
    threads = registry.warm("slow")
    elapsed = time.monotonic() - started
    assert elapsed < 0.2, f"warm() blocked for {elapsed:.2f}s"
    for thread in threads:
        thread.join(timeout=10)
    assert registry.status("slow").state is ModelState.READY


def test_warming_an_already_ready_model_does_nothing(
    registry: ModelRegistry,
) -> None:
    loads = []
    registry.register("m", lambda: (loads.append(1), "x")[1])
    registry.load("m")
    for thread in registry.warm("m"):
        thread.join(timeout=5)
    assert len(loads) == 1


def test_a_load_timeout_is_structured(registry: ModelRegistry) -> None:
    release = threading.Event()
    registry.register("slow", lambda: (release.wait(30), "x")[1])
    threading.Thread(target=lambda: registry.try_load("slow"), daemon=True).start()
    time.sleep(0.2)
    with pytest.raises(ModelUnavailable) as raised:
        registry.load("slow", timeout=0.3)
    assert raised.value.code == "models.load_timeout"
    release.set()


def test_builtin_registration_does_not_load_anything() -> None:
    """Registering must cost an import, not a model.

    A process that never OCRs must never pay for RapidOCR — that is what
    makes the registry safe to initialise on every session start.
    """
    lifecycle_reset_for_tests()
    from watch_skill.models import get_registry, register_builtin_models

    register_builtin_models()
    registry = get_registry()
    assert "ocr" in registry.registered()
    for name in registry.registered():
        assert registry.status(name).state is ModelState.UNLOADED
    lifecycle_reset_for_tests()
