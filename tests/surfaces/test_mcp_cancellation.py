"""What a client timeout does, and does not, do to work already running.

Measured against a real `uv run watch-skill serve` over stdio: a client that
gave up on `ask_video` after 8s left the engine running for ~20s more (+35.7s
CPU) before its own deadline stopped it, and three stacked timed-out asks ran
concurrently for ~118s of CPU. Throughout both, `list_videos` answered in
0.02-0.06s and `search_videos` in 0.08-0.17s.

So the rules are: cancellation cannot stop the work, which is why the answer
deadline is load-bearing rather than a nicety; and a stuck tool must not make
the cheap read tools wait behind it. Both are pinned here in-process, against
the same FastMCP threadpool entry point the server uses.
"""
from __future__ import annotations

import threading
import time

import anyio
import pytest
from fastmcp.utilities.async_utils import call_sync_fn_in_threadpool

SLOW = 1.5
CLIENT_PATIENCE = 0.2


@pytest.mark.anyio
async def test_client_timeout_cannot_stop_work_already_running() -> None:
    """anyio's default is abandon_on_cancel=False: the thread is never killed.

    FastMCP runs sync tools through this helper without overriding that, so a
    cancelled request abandons its *result*, not its work. Nothing in the
    transport can bound a sync tool — only the tool itself can.
    """
    finished = threading.Event()

    def slow_tool() -> str:
        time.sleep(SLOW)
        finished.set()
        return "done"

    started = time.monotonic()
    with anyio.move_on_after(CLIENT_PATIENCE):
        await call_sync_fn_in_threadpool(slow_tool)
    elapsed = time.monotonic() - started

    assert finished.is_set(), (
        "the worker thread ran to completion despite the cancellation — if this "
        "ever flips, cancellation became real and the deadline could relax"
    )
    assert elapsed >= SLOW * 0.8, (
        f"cancel scope returned after {elapsed:.2f}s, before the {SLOW}s thread "
        "finished; that would mean the work was truly abandoned"
    )


@pytest.mark.anyio
async def test_a_stuck_tool_does_not_delay_the_cheap_read_tools() -> None:
    """The acceptance requirement, in miniature.

    Three abandoned asks were running when `list_videos` answered in 0.06s.
    Sync tools must keep going to separate threads rather than queueing behind
    each other, or one wedged ask would take every read tool down with it.
    """
    release = threading.Event()

    def wedged_tool() -> None:
        release.wait(10)

    def cheap_tool() -> str:
        return "videos"

    async with anyio.create_task_group() as tg:
        for _ in range(3):  # matches the three stacked asks from the incident
            tg.start_soon(call_sync_fn_in_threadpool, wedged_tool)
        await anyio.sleep(0.1)  # let them occupy their threads

        started = time.monotonic()
        result = await call_sync_fn_in_threadpool(cheap_tool)
        cheap_latency = time.monotonic() - started

        release.set()

    assert result == "videos"
    assert cheap_latency < 1.0, (
        f"a cheap read took {cheap_latency:.2f}s behind three wedged tools; "
        "lightweight tools must stay responsive while work is abandoned"
    )


@pytest.mark.anyio
async def test_abandoned_work_is_bounded_by_the_tool_itself() -> None:
    """A tool that watches its own clock stops on time even with no listener.

    This is the shape `answer_question` relies on: the caller is long gone, so
    the only thing that can end the work is the work's own deadline check.
    """
    deadline_seconds = 0.4
    stopped_at: list[float] = []

    def self_bounding_tool() -> None:
        started = time.monotonic()
        while time.monotonic() - started < deadline_seconds:
            time.sleep(0.02)
        stopped_at.append(time.monotonic() - started)

    with anyio.move_on_after(0.05):  # caller gives up almost immediately
        await call_sync_fn_in_threadpool(self_bounding_tool)

    assert stopped_at, "the tool must finish on its own terms"
    assert stopped_at[0] < deadline_seconds * 4, (
        f"work ran {stopped_at[0]:.2f}s against a {deadline_seconds}s budget"
    )
