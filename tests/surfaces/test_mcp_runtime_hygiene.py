"""Two ways the stdio MCP server hung forever, pinned so they cannot return.

Both were invisible to every in-process test, because both need the two
conditions only the real server has: tools running in FastMCP worker threads,
and a process whose stdin/stdout *are* the JSON-RPC channel.

1. Lazy native import on a worker thread. The embedding stack
   (fastembed -> numpy -> onnxruntime) was imported at its call sites, so in
   the server the first import landed in a worker thread and deadlocked in the
   numpy C-extension load — two faulthandler dumps 35s apart showed the
   identical ``create_module`` frame. ``search_videos`` and ``ask_video`` hung
   past 180s while ``list_videos``, which never embeds, answered in 0.01s.
   Warming on the main thread before serving took ``search_videos`` to 2.0s.

2. Children inheriting the protocol stdin. ``doctor`` finished in 5.7s on the
   main thread and 2.5s in a worker thread, but hung past 90s in
   ``subprocess.communicate`` once the server's stdio were pipes. ffmpeg in
   particular reads stdin for keyboard commands, so a child on the escalation
   path can block on — or eat bytes from — the MCP stream. 0.50s once stdin
   was detached.
"""
from __future__ import annotations

import ast
import subprocess
import threading
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "watch_skill"

# Every spawn on a path an MCP tool can reach. ffprobe/ffmpeg/tesseract all run
# during ask_video escalation; doctor's _run backs every health check.
HOT_PATH_SPAWN_SITES = [
    SRC / "perceive" / "media.py",
    SRC / "perceive" / "ocr_backends.py",
    SRC / "perceive" / "scenes.py",
    SRC / "health" / "doctor.py",
]


def test_serve_warms_native_imports_on_the_main_thread_before_running() -> None:
    """The warmup must happen on the main thread, and before the event loop."""
    from watch_skill.surfaces.mcp import server

    warmed_on: list[str] = []
    order: list[str] = []

    def fake_warm(model_name: str | None = None) -> bool:
        warmed_on.append(threading.current_thread().name)
        order.append("warm")
        return True

    def fake_run(*args: object, **kwargs: object) -> None:
        order.append("run")

    from watch_skill.index import embeddings

    original_warm, original_run = embeddings.warm_up, server.mcp.run
    embeddings.warm_up, server.mcp.run = fake_warm, fake_run
    try:
        server.main()
    finally:
        embeddings.warm_up, server.mcp.run = original_warm, original_run

    assert order[0] == "warm", "the import must be warmed before serving starts"
    assert "run" in order, "serving must still start after the warmup"
    assert warmed_on, "serving must not begin without warming the native stack"
    assert warmed_on[0] == threading.main_thread().name, (
        "warming on a worker thread reintroduces the deadlock it exists to prevent"
    )


def test_warmup_failure_does_not_block_serving() -> None:
    """A box without fastembed must still serve, keyword-only."""
    from watch_skill.surfaces.mcp import server

    started: list[str] = []

    def exploding_warm(model_name: str | None = None) -> bool:
        raise RuntimeError("no fastembed on this box")

    from watch_skill.index import embeddings

    original_warm, original_run = embeddings.warm_up, server.mcp.run
    embeddings.warm_up = exploding_warm
    server.mcp.run = lambda *a, **k: started.append("run")
    try:
        server.main()
    finally:
        embeddings.warm_up, server.mcp.run = original_warm, original_run

    assert started == ["run"]


def test_warmup_also_covers_the_model_the_index_actually_uses() -> None:
    """An index built by an older release records a different model name.

    Retrieval embeds with the recorded model, so warming only the current
    default leaves a second native load to happen lazily — on a worker thread,
    which is the deadlock. This index really does record all-MiniLM-L6-v2
    while the default is the multilingual model, so the gap is not theoretical.
    """
    from watch_skill.index import embeddings
    from watch_skill.index.db import connect, set_meta
    from watch_skill.surfaces.mcp import server

    conn = connect()
    try:
        with conn:
            set_meta(conn, "embedding_model", "sentence-transformers/all-MiniLM-L6-v2")
    finally:
        conn.close()

    warmed: list[str | None] = []
    original_warm, original_run = embeddings.warm_up, server.mcp.run
    embeddings.warm_up = lambda model_name=None: (warmed.append(model_name), True)[1]
    server.mcp.run = lambda *a, **k: None
    try:
        server.main()
    finally:
        embeddings.warm_up, server.mcp.run = original_warm, original_run

    assert "sentence-transformers/all-MiniLM-L6-v2" in [w for w in warmed if w], (
        f"the index's own embedding model was never warmed (warmed: {warmed})"
    )


@pytest.mark.parametrize("path", HOT_PATH_SPAWN_SITES, ids=lambda p: p.name)
def test_hot_path_children_never_inherit_the_protocol_stdin(path: Path) -> None:
    """Under stdio MCP, an inherited stdin is the JSON-RPC channel itself."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in {"run", "Popen"}):
            continue
        if not (isinstance(func.value, ast.Name) and func.value.id == "subprocess"):
            continue
        if not any(kw.arg == "stdin" for kw in node.keywords):
            offenders.append(node.lineno)

    assert not offenders, (
        f"{path.name}: subprocess spawn without an explicit stdin= at "
        f"line(s) {offenders}; a child inheriting the server's stdin can block "
        f"on or steal bytes from the MCP protocol stream"
    )


def test_detached_stdin_child_cannot_read_the_parent_stream() -> None:
    """The behaviour the flag buys: the child sees EOF, not our protocol."""
    result = subprocess.run(
        ["python", "-c", "import sys; sys.stdout.write(repr(sys.stdin.read()))"],
        capture_output=True, text=True, timeout=60,
        stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 0
    assert result.stdout == "''", "a detached child must read EOF immediately"
