"""Bounded pipelines. Nothing here is allowed to grow without a limit.

The failure this design prevents: a slow analysis stage silently becoming a
memory leak, or — worse — becoming backpressure that stalls capture and loses
audio. Every queue has a fixed capacity and a declared behaviour when full.

Two behaviours, chosen per stage by what the data is worth:

``DROP_OLDEST``
    Live perception. A frame from four seconds ago has been superseded by the
    one in hand; keeping it would make the view lag further behind reality.
    Drops are counted, never hidden.
``BLOCK``
    Anything that must not be lost — pinned evidence, persistence. These
    stages are fast by construction, so blocking is bounded in practice.

Audio never shares a queue with vision. That is the whole reason they are
separate pipelines: speech is continuous and unrepeatable, while a dropped
frame costs one sample of a scene that is still there.
"""
from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Overflow(str, Enum):  # noqa: UP042 — matches SourceKind
    DROP_OLDEST = "drop_oldest"
    BLOCK = "block"


@dataclass
class BoundedStage:
    """One named, capacity-limited stage with observable pressure."""

    name: str
    capacity: int
    overflow: Overflow = Overflow.DROP_OLDEST
    _queue: queue.Queue = field(init=False)
    dropped: int = 0
    accepted: int = 0

    def __post_init__(self) -> None:
        self._queue = queue.Queue(maxsize=max(1, self.capacity))

    def put(self, item: Any, timeout: float = 5.0) -> bool:
        """Offer an item. False means it was dropped rather than queued."""
        if self.overflow is Overflow.BLOCK:
            try:
                self._queue.put(item, timeout=timeout)
            except queue.Full:
                self.dropped += 1
                return False
            self.accepted += 1
            return True

        while True:
            try:
                self._queue.put_nowait(item)
                self.accepted += 1
                return True
            except queue.Full:
                try:
                    self._queue.get_nowait()
                    self.dropped += 1
                except queue.Empty:  # pragma: no cover - drained concurrently
                    continue

    def get(self, timeout: float = 0.2) -> Any | None:
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain_latest(self) -> Any | None:
        """Take the newest item and discard what it superseded.

        Live perception wants the current frame, not a backlog: catching up
        by analysing four stale frames leaves the answer four frames behind.
        """
        latest = None
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return latest
            if latest is not None:
                self.dropped += 1
            latest = item

    @property
    def depth(self) -> int:
        return self._queue.qsize()


class Pipeline:
    """A named set of bounded stages and the threads that drain them."""

    def __init__(self) -> None:
        self.stages: dict[str, BoundedStage] = {}
        self._threads: list[threading.Thread] = []
        self._stop = threading.Event()
        self.errors: list[dict[str, Any]] = []

    def stage(
        self, name: str, capacity: int, overflow: Overflow = Overflow.DROP_OLDEST
    ) -> BoundedStage:
        stage = BoundedStage(name=name, capacity=capacity, overflow=overflow)
        self.stages[name] = stage
        return stage

    def consume(
        self,
        stage: BoundedStage,
        handler: Callable[[Any], None],
        *,
        latest_only: bool = False,
        name: str | None = None,
    ) -> None:
        """Run ``handler`` over a stage on its own thread.

        A handler that raises is recorded and the loop continues. One bad
        frame must not take down the pipeline that is still watching
        everything else.
        """

        def loop() -> None:
            while not self._stop.is_set():
                item = stage.drain_latest() if latest_only else stage.get()
                if item is None:
                    if latest_only:
                        time.sleep(0.02)
                    continue
                try:
                    handler(item)
                except Exception as exc:  # noqa: BLE001
                    self.errors.append({"stage": stage.name, "error": str(exc)})
                    del self.errors[:-50]

        thread = threading.Thread(
            target=loop, name=name or f"ws-live-{stage.name}", daemon=True
        )
        thread.start()
        self._threads.append(thread)

    def depths(self) -> dict[str, int]:
        return {name: stage.depth for name, stage in self.stages.items()}

    def dropped(self) -> dict[str, int]:
        return {name: stage.dropped for name, stage in self.stages.items()
                if stage.dropped}

    def stop(self, timeout: float = 5.0) -> None:
        """Stop every stage within ``timeout`` *in total*.

        The timeout used to be applied per thread, so a pipeline with three
        stages took up to three times the budget its caller asked for. Stage
        loops poll their queue every 200 ms and notice the stop flag promptly;
        what actually consumes the budget is a handler already running — an
        OCR pass on the frame in hand — and with one deadline that cost is
        paid once rather than once per stage.

        Measured: this took live-session teardown from about 15 s to about 5 s.
        """
        self._stop.set()
        deadline = time.monotonic() + max(0.0, timeout)
        for thread in self._threads:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # Out of budget. The threads are daemons polling a stop flag,
                # so they exit on their own; waiting longer only delays the
                # caller who asked for a bounded stop.
                break
            thread.join(timeout=remaining)

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()


class CircuitBreaker:
    """Stop calling a provider that keeps failing, and say so.

    Without this, a degraded cloud provider turns every frame into a timeout
    and the live view stops being live while looking like it is working.
    """

    def __init__(self, threshold: int = 3, cooldown: float = 30.0) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self.failures = 0
        self.opened_at: float | None = None

    @property
    def open(self) -> bool:
        if self.opened_at is None:
            return False
        if time.time() - self.opened_at >= self.cooldown:
            self.failures, self.opened_at = 0, None
            return False
        return True

    def record_success(self) -> None:
        self.failures, self.opened_at = 0, None

    def record_failure(self) -> bool:
        """Returns True when this failure opened the circuit."""
        self.failures += 1
        if self.failures >= self.threshold and self.opened_at is None:
            self.opened_at = time.time()
            return True
        return False
