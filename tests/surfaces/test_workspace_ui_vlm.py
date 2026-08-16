"""The real model's reading, on screen, in the production Next.js build.

The inherited UI proof drives the whole broken -> approved -> verified
scenario, but its semantic backend is deterministic: it sees nothing. This
file exists for one claim that cannot be made any other way — that a genuine
SmolVLM observation reaches the rendered interface, carrying the timestamp of
the frame it actually describes, the model that produced it, how long it took,
and what it is therefore still allowed to be used for.

Opt-in and slow for the same reasons as the live gate: the fixture plays for
150 seconds in real time and one interpretation costs roughly 50 of them.

    WATCHSKILL_TEST_REAL_VLM_LIVE=1
    WATCHSKILL_VLM_PYTHON=<python.exe with torch>
    WATCHSKILL_VLM_REVISION=<the commit in the cache>

`file_replay` rather than a browser source, deliberately. A Chromium capture,
a Playwright Chromium and a gigabyte of model weights do not fit in the memory
this machine has, and the browser-source path is already proven by
`test_workspace_ui.py`. What is under test here is the vision panel.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

from watch_skill.live import session as live_session
from watch_skill.surfaces.mcp.devhost import DevHost
from watch_skill.surfaces.mcp.workspace_app import bundle_available

REPO = Path(__file__).resolve().parents[2]
ARTIFACTS = REPO / "docs" / "assets" / "workspace"

pytestmark = [
    pytest.mark.real_model,
    pytest.mark.timeout(1200),
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_TEST_REAL_VLM_LIVE"),
        reason="real-model rendered gate; set WATCHSKILL_TEST_REAL_VLM_LIVE=1 "
               "(see docs/testing.md)",
    ),
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_VLM_PYTHON"),
        reason="no external VLM interpreter configured",
    ),
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_VLM_REVISION"),
        reason="no model revision pinned; an unpinned load resolves 'main' "
               "over the network",
    ),
]


@pytest.fixture(scope="module")
def fixture_clip(tmp_path_factory: pytest.TempPathFactory) -> dict:
    pytest.importorskip("PIL")
    sys.path.insert(0, str(REPO / "scripts"))
    from make_live_vlm_fixture import build  # noqa: PLC0415

    out = tmp_path_factory.mktemp("ui vlm fixture")
    manifest = build(out)
    manifest["path"] = out / manifest["video"]
    return manifest


def _wait(predicate, timeout: float, interval: float = 0.5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def test_the_real_models_reading_is_visible_in_the_rendered_workspace(
    fixture_clip: dict, isolated_settings: Path, record_property,
) -> None:
    from playwright.sync_api import sync_playwright

    if not bundle_available():
        pytest.skip("the workspace bundle is not built; run "
                    "`npm --prefix app install && npm --prefix app run build`")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    session = live_session.start_live(
        target=str(fixture_clip["path"]), kind="file_replay",
        fps=1.0, audio=False,
        detail={"semantic_vlm": True, "semantic_budget": 20},
    )
    session_id = session.session_id

    try:
        with DevHost() as host, sync_playwright() as play:
            browser = play.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            console_errors: list[str] = []
            page.on("console", lambda m: console_errors.append(m.text)
                    if m.type == "error" else None)

            page.goto(host.base_url, wait_until="domcontentloaded")
            page.wait_for_selector("header.header", timeout=60_000)

            # --- 1. the preview is continuous, and says which kind ----------
            label = page.locator('[data-testid="transport-label"]')
            assert _wait(lambda: label.count() > 0, 60), "no transport label"
            transport = label.inner_text().strip()
            assert transport in ("LIVE FRAMES", "LIVE VIDEO", "SNAPSHOT"), \
                f"unexpected transport label {transport!r}"
            # A running session on this host must never be labelled REPLAY.
            assert transport != "REPLAY"

            # Frames actually change on screen. Read from the driver's own
            # counters rather than diffing pixels: the question is whether the
            # transport delivered distinct frames, not whether the video moved.
            stats = _wait(
                lambda: page.evaluate(
                    "() => window.__watchSkillPreview || null") or None, 90)
            assert stats is not None, "the preview driver never reported"
            advanced = _wait(
                lambda: (page.evaluate(
                    "() => (window.__watchSkillPreview||{}).framesDrawn || 0")
                    or 0) >= 2, 120)
            assert advanced, "the preview never drew a second frame"

            final_stats = page.evaluate("() => window.__watchSkillPreview")
            record_property("preview_stats", json.dumps(final_stats))
            page.screenshot(path=str(ARTIFACTS / "workspace-live-preview.png"))

            # --- 2. the model is visibly working ---------------------------
            # PROCESSING WITH VLM is a real state, not a spinner: it means a
            # call is in flight. Captured opportunistically because on this
            # backend it lasts ~50s and then stops being true.
            processing = _wait(
                lambda: page.locator(
                    '[data-testid="vlm-processing"]').count() > 0, 120)
            if processing:
                page.screenshot(
                    path=str(ARTIFACTS / "workspace-vlm-processing.png"))
            record_property("saw_processing_state", str(bool(processing)))

            # --- 3. a real reading arrives and is fully attributed ---------
            observation = page.locator('[data-testid="vlm-observation"]')
            assert _wait(lambda: observation.count() > 0, 300), (
                "no model reading reached the interface within 300s")

            text = observation.inner_text().strip()
            assert text, "the observation rendered empty"

            model = page.locator('[data-testid="vlm-model"]').inner_text()
            assert "SmolVLM" in model, f"model identity missing: {model!r}"
            assert "@" in model, "the pinned revision is not shown"

            latency = page.locator('[data-testid="vlm-latency"]').inner_text()
            assert "of inference" in latency
            # The measured latency is shown rather than hidden. Anything under
            # a second would mean this was not the real model.
            seconds = float(latency.split("s of inference")[0].strip())
            assert seconds > 1.0, f"implausibly fast for a real model: {latency}"

            frame_ts = page.locator('[data-testid="vlm-frame-ts"]').inner_text()
            assert "media" in frame_ts, frame_ts
            frame_hash = page.locator(
                '[data-testid="vlm-frame-hash"]').inner_text()
            assert frame_hash and "not recorded" not in frame_hash

            # --- 4. freshness is stated, and it is not flattering ----------
            panel = page.locator("div.observation")
            freshness = panel.get_attribute("data-freshness")
            assert freshness in ("current_state", "stale_for_action",
                                 "historical_evidence"), freshness
            shown = panel.inner_text()
            expected_label = {
                "current_state": "CURRENT STATE",
                "stale_for_action": "STALE FOR ACTION",
                "historical_evidence": "HISTORICAL VLM RESULT",
            }[freshness]
            assert expected_label in shown, (
                f"freshness {freshness} was not labelled in the UI")

            # The reading is fenced as untrusted, because it is a
            # transcription of whatever the observed screen said. Compared
            # case-insensitively: the label is upper-cased in CSS, so
            # `inner_text` returns it shouted.
            assert "evidence, not instruction" in shown.lower()

            record_property("rendered_observation", json.dumps({
                "text": text[:300], "model": model, "latency": latency,
                "frame": frame_ts, "freshness": freshness,
                "transport": transport,
            }))

            page.screenshot(
                path=str(ARTIFACTS / "workspace-vlm-historical.png"))

            assert not [e for e in console_errors if "favicon" not in e], (
                f"the workspace logged errors: {console_errors[:3]}")
            browser.close()
    finally:
        live_session.stop_live(session_id)
