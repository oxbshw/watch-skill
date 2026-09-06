"""Every server that answers on worker threads warms the native stack first.

The embedding stack (fastembed -> numpy -> onnxruntime) is imported lazily at
its call sites. Loading the numpy C extension from a worker thread deadlocks:
the thread parks in ``create_module`` and never returns. The MCP server has
warmed on its main thread since that was found there.

The Bridge has the same shape — a bounded worker pool — and did not warm.
Measured against 1.4.0 in the acceptance room, on a fresh Core process:

    search 1: 900008ms  (client gave up; the request never settled)
    search 2:  50807ms  ok
    search 3:   1191ms  ok

and with the warm-up in place, on an equally fresh process:

    search 1:    677ms  ok
    search 2:    507ms  ok
    search 3:    506ms  ok

So `watch_search_sources` — the tool an agent reaches for to find which source
mentioned something — hung forever the first time it was used in DeepWatch,
while every Bridge method that does not embed answered instantly and the engine
looked healthy.

These tests hold the invariant at the place it broke: not "warming works", but
"every one of these servers does it", because the defect was one of two servers
having the call.
"""
from __future__ import annotations

from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "watch_skill"

# Every module that runs request handlers on threads it does not own.
THREADED_SERVERS = [
    SRC / "surfaces" / "bridge" / "server.py",
    SRC / "surfaces" / "mcp" / "server.py",
]


@pytest.mark.parametrize("module", THREADED_SERVERS, ids=lambda p: p.stem + "-" + p.parent.name)
def test_a_threaded_server_warms_the_native_stack(module: Path) -> None:
    source = module.read_text(encoding="utf-8")
    assert "warm_native_imports" in source, (
        f"{module.relative_to(SRC)} answers requests on worker threads and never "
        "imports the embedding stack on a thread it owns. The first search will "
        "deadlock. See watch_skill.index.embeddings.warm_native_imports.")


def test_the_bridge_warms_before_it_starts_serving(monkeypatch: pytest.MonkeyPatch) -> None:
    """Order matters: warming after the pool is up is warming too late."""
    from watch_skill.index import embeddings
    from watch_skill.surfaces.bridge import server as bridge_server

    order: list[str] = []
    monkeypatch.setattr(embeddings, "warm_native_imports", lambda: order.append("warm"))

    class _Stub:
        def __init__(self, *args: object, **kwargs: object) -> None:
            order.append("construct")

        def run(self) -> int:
            order.append("run")
            return 0

    monkeypatch.setattr(bridge_server, "BridgeServer", _Stub)
    monkeypatch.setattr(bridge_server.logging, "basicConfig", lambda **_: None)

    assert bridge_server.serve() == 0
    assert order[0] == "warm", f"the pool was up before the stack was warmed: {order}"
    assert "run" in order


def test_the_warm_up_never_stops_a_server_from_starting(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """A box that cannot load the model still serves, keyword-only, and says so."""
    from watch_skill.index import embeddings

    def _explode(_model: str | None = None) -> bool:
        raise RuntimeError("no onnxruntime for this CPU")

    monkeypatch.setattr(embeddings, "warm_up", _explode)
    embeddings.warm_native_imports()
    assert "warmup skipped" in capsys.readouterr().err


def test_the_shared_warm_up_has_exactly_one_implementation() -> None:
    """A second copy is a second place to forget it.

    Discriminated by what the implementation actually does — call `warm_up`,
    which is the load — rather than by how long it is. A delegating wrapper
    imports the shared one and calls it; only the owner touches `warm_up`.
    """
    owners = [
        py.relative_to(SRC).as_posix()
        for py in sorted(SRC.rglob("*.py"))
        if "warm_up(" in py.read_text(encoding="utf-8-sig")
    ]
    assert owners == ["index/embeddings.py"], (
        f"the load is performed in more than one place: {owners}")
