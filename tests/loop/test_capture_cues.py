"""What a scripted capture is for: the states it was recorded to show survive.

The failure these exist for is measurable rather than theoretical. A checkout
page where a quantity edit moves three numbers produces frames whose perceptual
hashes are 4 apart, and the near-duplicate threshold is 6 -- so the frame that
carries the change is dropped and a report is written from the page before it.

Pinning the interaction fixes that only if the pin lands in the right place,
which is what most of this file is about. Two clocks are involved and they do
not share a length, a page does not finish reacting the instant a script step
returns, and a recording made twice into one directory overwrites the first.
"""
from __future__ import annotations

import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytest.importorskip("playwright", reason="loop extra not installed")

from watch_skill.loop.capture import capture  # noqa: E402
from watch_skill.perceive.cues import read_sidecar, sidecar_path_for  # noqa: E402
from watch_skill.watch import watch  # noqa: E402

#: A checkout whose total is recomputed a moment after the edit that causes it.
#:
#: The delay is the point. A cue taken the instant `page.fill` returns names a
#: frame that still shows the old total, so a test against an instant-updating
#: page would pass without the settle that makes the cue mean anything.
_CHECKOUT = """<!doctype html>
<html><head><meta charset="utf-8"><style>
  body {{ font: 44px/1.5 "DejaVu Sans Mono", monospace; background: #fff;
         color: #000; padding: 40px; }}
  input {{ font: 44px "DejaVu Sans Mono", monospace; width: 3em; }}
  .total {{ font-size: 64px; font-weight: bold; }}
</style></head>
<body>
  <div>QTY <input id="qty" value="0"></div>
  <div>SUBTOTAL <span id="subtotal">0.00</span></div>
  <div class="total">TOTAL <span id="total">0.00</span></div>
<script>
  const PRICE = 22
  const recompute = () => {{
    const q = Number(document.getElementById('qty').value) || 0
    document.getElementById('subtotal').textContent = (PRICE * q).toFixed(2)
    document.getElementById('total').textContent = (PRICE * q).toFixed(2)
  }}
  document.getElementById('qty')
    .addEventListener('input', () => setTimeout(recompute, {delay_ms}))
</script>
</body></html>
"""

#: Fill the quantity box twice. Two totals, both of which have to survive.
_SCRIPT = [
    {"action": "fill", "selector": "#qty", "value": "1"},
    {"action": "fill", "selector": "#qty", "value": "4"},
]
_FIRST_TOTAL = "22.00"
_SECOND_TOTAL = "88.00"


def _page(tmp_path: Path, delay_ms: int = 350) -> Path:
    page = tmp_path / "checkout dir" / "checkout.html"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(_CHECKOUT.format(delay_ms=delay_ms), encoding="utf-8")
    return page


def _ocr_text(result) -> str:
    """Everything OCR read, from the frames the cues pinned."""
    frames = [f for f in result.perception.frames if f.reason == "cue"]
    return " ".join(
        block.text for frame in frames for block in (frame.ocr_blocks or [])
    )


def _cue_frames(result) -> list:
    return [f for f in result.perception.frames if f.reason == "cue"]


class _SlowHandler(SimpleHTTPRequestHandler):
    """A server that takes its time over the document, and only the document."""

    delay_seconds = 2.0

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's name
        if self.path.endswith(".html") or self.path == "/":
            threading.Event().wait(self.delay_seconds)
        super().do_GET()

    def log_message(self, *_args: object) -> None:
        return


@pytest.fixture()
def slow_site(tmp_path: Path):
    """The checkout, served by something that answers in its own time."""
    root = _page(tmp_path).parent
    handler = partial(_SlowHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/checkout.html"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.timeout(300)
def test_both_numeric_states_survive_near_duplicate_selection(tmp_path: Path) -> None:
    """The measured failure, end to end: two totals, both readable afterwards.

    Without the cues these frames are 4 apart perceptually and the threshold
    is 6, so the second one is dropped and the report describes the first.
    """
    result = capture(_page(tmp_path).resolve().as_uri(), tmp_path / "cap two states",
                     script=_SCRIPT)
    assert result.meta["cues"], "a scripted capture recorded no interactions"

    watched = watch(str(result.video_path), use_cache=False, run_ocr=True)
    text = _ocr_text(watched)
    assert _FIRST_TOTAL in text, f"the first total was not kept: {text!r}"
    assert _SECOND_TOTAL in text, f"the second total was not kept: {text!r}"


@pytest.mark.timeout(300)
def test_a_slow_first_navigation_does_not_move_every_later_moment(
    slow_site: str, tmp_path: Path
) -> None:
    """The clock starts with the recording, not with the end of the navigation.

    Two seconds of this recording are the browser waiting for a document. A
    clock started after `page.goto` returns calls the first interaction
    "0.4 s", which in the recording is the blank page before the app rendered.
    """
    result = capture(slow_site, tmp_path / "cap slow", script=_SCRIPT)
    cues = read_sidecar(result.video_path)
    assert cues is not None
    assert cues[0] > _SlowHandler.delay_seconds, (
        f"the first interaction is recorded at {cues[0]:.2f}s, which is inside "
        f"the {_SlowHandler.delay_seconds}s navigation that preceded it"
    )

    watched = watch(str(result.video_path), use_cache=False, run_ocr=True)
    text = _ocr_text(watched)
    assert _SECOND_TOTAL in text, (
        f"the pinned frames are of the wrong moment: {text!r}")


@pytest.mark.timeout(300)
def test_the_cue_names_the_state_after_the_step_not_before_it(
    tmp_path: Path
) -> None:
    """A page that repaints late still gets pinned after it has repainted."""
    result = capture(_page(tmp_path, delay_ms=700).resolve().as_uri(),
                     tmp_path / "cap late", script=_SCRIPT[:1])
    watched = watch(str(result.video_path), use_cache=False, run_ocr=True)
    text = _ocr_text(watched)
    assert _FIRST_TOTAL in text, (
        f"pinned the frame before the page reacted to the edit: {text!r}")


@pytest.mark.timeout(300)
def test_a_wait_is_pinned_inside_the_wait_not_at_its_far_edge(
    tmp_path: Path
) -> None:
    """The far edge of a wait is the instant the next step runs.

    Measured: a cue stamped there caught a frame where the quantity box
    already read the *next* value and the totals had not been recomputed --
    a state that existed for about a tenth of a second and is the one frame
    in that window nobody wants pinned.
    """
    script = [{"action": "wait", "seconds": 1.5}, *_SCRIPT]
    result = capture(_page(tmp_path).resolve().as_uri(), tmp_path / "cap wait",
                     script=script)
    cues = read_sidecar(result.video_path) or []
    assert len(cues) == 3
    assert 0.4 < cues[0] < 1.4, (
        f"the wait's cue is at {cues[0]:.2f}s, not inside the 1.5s wait")
    assert cues[0] < cues[1], "the wait outlasted the interaction after it"


@pytest.mark.timeout(300)
def test_a_second_recording_into_the_same_place_leaves_no_stale_cues(
    tmp_path: Path
) -> None:
    """Capture writes a fixed name, so the second run replaces the first."""
    out = tmp_path / "cap twice"
    page = _page(tmp_path).resolve().as_uri()
    first = capture(page, out, script=_SCRIPT)
    assert sidecar_path_for(first.video_path).is_file()

    second = capture(page, out, duration_seconds=2.0)  # unscripted
    assert second.video_path == first.video_path
    assert not sidecar_path_for(second.video_path).exists(), (
        "the previous recording's interaction moments outlived it")
    assert read_sidecar(second.video_path) is None


@pytest.mark.timeout(300)
def test_an_explicit_timestamp_wins_over_a_recorded_one(tmp_path: Path) -> None:
    """`--timestamps` is the caller naming the moments that matter."""
    result = capture(_page(tmp_path).resolve().as_uri(), tmp_path / "cap explicit",
                     script=_SCRIPT)
    assert len(read_sidecar(result.video_path) or []) == 2

    watched = watch(str(result.video_path), use_cache=False, run_ocr=False,
                    cue_timestamps=[0.2])
    pinned = [round(f.timestamp_seconds, 3) for f in _cue_frames(watched)]
    assert pinned == [0.2], f"the sidecar overrode the caller: {pinned}"


@pytest.mark.timeout(300)
def test_the_whole_path_finds_the_total_at_the_moment_it_appeared(
    tmp_path: Path
) -> None:
    """Recording -> pinned frames -> OCR -> index -> retrieval, on real bytes.

    The claim being checked is narrow and worth stating: a recording that
    carries interaction cues keeps the states those interactions produced.
    It says nothing about an arbitrary uploaded video, which carries none.
    """
    from watch_skill.index import ask_video, get_moment, index_watch_result

    result = capture(_page(tmp_path).resolve().as_uri(), tmp_path / "cap indexed",
                     script=_SCRIPT)
    cues = read_sidecar(result.video_path) or []
    watched = watch(str(result.video_path), use_cache=False, run_ocr=True)
    video_id = index_watch_result(watched, describe_scenes=False)

    answer = ask_video(video_id, f"what was the total {_SECOND_TOTAL}?")
    carrying = [hit for hit in answer["hits"]
                if _SECOND_TOTAL in hit["text"] and hit["timestamp"] is not None]
    assert carrying, (
        f"retrieval cannot find {_SECOND_TOTAL} in what it just indexed: "
        f"{[h['text'] for h in answer['hits']]}")

    at = carrying[0]["timestamp"]
    assert any(abs(at - cue) < 1.0 for cue in cues), (
        f"{_SECOND_TOTAL} was found at {at:.2f}s, which is not one of the "
        f"moments the capture pinned: {cues}")
    moment = get_moment(video_id, at, window=1.0)
    read_there = " ".join(str(row.get("text", "")) for row in moment.ocr)
    assert re.search(re.escape(_SECOND_TOTAL), read_there), (
        f"the moment does not carry the reading it was retrieved for: "
        f"{read_there!r}")
