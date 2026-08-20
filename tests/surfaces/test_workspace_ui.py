"""The workspace, driven end to end through the rendered UI.

This is the test that decides whether the MCP App is real. It runs the whole
broken → observed → approved → corrected → independently-verified scenario
against the actual React bundle in a real browser, and asserts on what a
person would see.

Everything it looks at is generated locally: the fixture app is written in
this repository, the frames come from Watch Skill's own capture pipeline, and
no part of the operator's desktop is ever in shot.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from watch_skill import workspace
from watch_skill.live import session as live_session
from watch_skill.live.browser_pool import available_memory_mb
from watch_skill.live.browser_pool import diagnostics as pool_diagnostics
from watch_skill.live.capabilities import capability_for
from watch_skill.live.fixture_app import FIXED_STATUS, FixtureApp
from watch_skill.observer import Budgets, CorrectionSpec, ObserverState, advance, start_run
from watch_skill.surfaces.mcp.devhost import DevHost
from watch_skill.surfaces.mcp.workspace_app import bundle_available
from watch_skill.verify.contract import Check, VerificationContract

pytestmark = pytest.mark.timeout(900)

REPO = Path(__file__).resolve().parents[2]


def _artifacts_dir() -> Path:
    """Where proof screenshots go.

    A build directory by default, not `docs/`. These are PNGs re-encoded on
    every run, so writing them into a tracked path made the working tree dirty
    after any test run — which quietly destroys "the tree is clean" as a
    release gate, because you can no longer tell a real edit from a rerun.

    Set `WATCHSKILL_REFRESH_DOCS_ASSETS=1` to publish them into `docs/` on
    purpose, which is what a season that intends to update the committed
    deliverables does.
    """
    import os  # noqa: PLC0415

    explicit = os.environ.get("WATCHSKILL_PROOF_ARTIFACTS")
    if explicit:
        # One directory per attempt, so a repeated-run hunt keeps each run's
        # trace and screenshots instead of overwriting the evidence it needs.
        return Path(explicit)
    if os.environ.get("WATCHSKILL_REFRESH_DOCS_ASSETS"):
        return REPO / "docs" / "assets" / "workspace"
    return REPO / "build" / "proof-artifacts" / "workspace"


ARTIFACTS = _artifacts_dir()


def _require_ui() -> None:
    if capability_for("browser").status != "available":
        pytest.skip("browser capture is unavailable")
    if not bundle_available():
        pytest.skip("the workspace bundle is not built; run "
                    "`npm --prefix app install && npm --prefix app run build`")


def _require_two_browsers() -> None:
    """The shared precondition. See `tests/conftest.require_verification_browser`."""
    from tests.conftest import require_verification_browser  # noqa: PLC0415

    # Higher than the Observer loop's allowance: this scenario also runs a
    # Playwright driver browser and the dev host. Measured consuming about
    # 1233 MB before its second verification, so 1400 covers it.
    require_verification_browser(2, scenario_mb=1400.0)


def _wait(predicate, timeout: float, interval: float = 0.25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


@pytest.fixture
def app():
    _require_ui()
    _require_two_browsers()
    with FixtureApp(splash_delay_ms=500) as running:
        yield running


@pytest.fixture
def host():
    with DevHost() as running:
        yield running


def _postcondition(app) -> VerificationContract:
    return VerificationContract(
        contract_id="order-confirmed",
        title="the order reaches confirmed",
        created_by="ui-proof",
        checks=[
            Check(id="dom-status", type="browser_dom", required=True,
                  timeout_seconds=120.0,
                  description="the status element reads 'confirmed'",
                  params={"url": f"{app.base_url}/app",
                          "selector": "#order-status", "mode": "text",
                          "expected": FIXED_STATUS, "timeout_ms": 8000}),
            Check(id="server-state", type="http_request", required=True,
                  description="the server agrees",
                  params={"url": f"{app.base_url}/api/state",
                          "status": 200, "body_contains": FIXED_STATUS}),
        ],
    ).freeze(created_by="ui-proof")


def _open_workspace(page, host: DevHost) -> None:
    page.goto(host.base_url, wait_until="domcontentloaded")
    page.wait_for_selector("header.header", timeout=30_000)


FIRST_RENDER_BUDGET_MS = 4000
"""How long the workspace may take to draw something a person can read.

Unchanged. What changed is where it is checked: in an isolated gate with
nothing else running, rather than at the end of a scenario whose own work
determines the answer."""


def test_first_render_meets_its_budget(host, record_property) -> None:
    """The performance gate, measured with nothing competing.

    Three samples, and the *median* is judged. A single cold sample measures
    whatever the machine was doing at that instant, which is the property that
    made this budget unreliable when it lived inside the scenario test.
    """
    _require_ui()
    from playwright.sync_api import sync_playwright

    samples: list[float] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--disable-background-networking", "--no-first-run",
            "--disable-component-update", "--disable-sync"])
        try:
            for _ in range(3):
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                started = time.monotonic()
                page.goto(host.base_url, wait_until="domcontentloaded")
                page.wait_for_selector("header.header", timeout=30_000)
                samples.append((time.monotonic() - started) * 1000)
                page.close()
        finally:
            browser.close()

    samples.sort()
    median = samples[len(samples) // 2]
    record_property("first_render_ms_samples", str([round(s) for s in samples]))
    record_property("first_render_ms_median", round(median, 1))
    assert median < FIRST_RENDER_BUDGET_MS, (
        f"first render median {median:.0f} ms exceeds the "
        f"{FIRST_RENDER_BUDGET_MS} ms budget (samples: "
        f"{[round(s) for s in samples]})")


def test_the_whole_scenario_is_visible_in_the_rendered_workspace(
    app, host, isolated_settings: Path, record_property
) -> None:
    from playwright.sync_api import sync_playwright

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    contract = _postcondition(app)

    session = live_session.start_live(
        f"{app.base_url}/", kind="browser", fps=3.0, audio=False,
        allow_local=True)
    run = None
    try:
        # Evidence must be arriving before the UI is even opened, so that what
        # the workspace shows is a live session rather than a replay.
        assert _wait(
            lambda: [e for e in live_session.observe(session.session_id,
                                                     limit=300)["events"]
                     if e["type"] == "error"] or None, timeout=90.0)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=[
                "--disable-background-networking", "--no-first-run",
                "--disable-component-update", "--disable-sync"])
            try:
                context = browser.new_context(
                    viewport={"width": 1440, "height": 900})
                # Traced, so a failure leaves something to read afterwards
                # rather than a message about a list that no longer exists.
                context.tracing.start(screenshots=True, snapshots=True,
                                      sources=False)
                page = context.new_page()
                console_errors: list[str] = []
                page.on("pageerror", lambda e: console_errors.append(str(e)))
                page.on("console", lambda m: console_errors.append(m.text)
                        if m.type == "error" else None)

                # Network failures are recorded with their URL and reason.
                # "Failed to load resource" on its own names neither, which is
                # what made the intermittent failure here impossible to read.
                net_failures: list[str] = []
                page.on("requestfailed", lambda r: net_failures.append(
                    f"{r.method} {r.url} :: "
                    f"{(r.failure or 'unknown')}"))
                page.on("response", lambda r: net_failures.append(
                    f"HTTP {r.status} {r.url}") if r.status >= 400 else None)

                started = time.monotonic()
                _open_workspace(page, host)
                first_render_ms = (time.monotonic() - started) * 1000

                # 1. The session is shown as LIVE while the browser source is
                #    genuinely still running.
                assert live_session.get_session(session.session_id).state.value \
                    == "running"
                page.wait_for_selector("text=LIVE", timeout=30_000)

                # 2. Browser evidence is on screen.
                page.get_by_role("tab", name="browser").click()
                page.wait_for_selector("article.card", timeout=30_000)
                cards = page.locator("article.card").count()
                assert cards > 0, "no browser evidence rendered"

                # 3. The page's injection banner appears as *quoted untrusted
                #    evidence*, never as prose the workspace is asserting.
                page.get_by_role("tab", name="observed").click()
                # It arrives via OCR or the DOM channel; either way it must be
                # fenced when present.
                untrusted = page.locator(".untrusted")
                if untrusted.count() > 0:
                    label = untrusted.first.locator(".untrusted-label")
                    assert "Untrusted" in (label.inner_text() or "")

                # 4. Observations and inferences never share a card.
                page.get_by_role("tab", name="browser").click()
                observed_cards = page.locator(
                    'article.card[data-provenance="observation"]').count()
                assert observed_cards > 0
                assert page.locator(
                    'article.card[data-provenance="inference"]').count() == 0, (
                    "an inference was rendered in the observed/browser tab")

                # The header must be a single row. It stacked into a tall
                # centred column when `.panel` won the flex-direction, which
                # no assertion would have caught — only looking at it did.
                header_box = page.locator("header.header").bounding_box()
                assert header_box is not None and header_box["height"] < 120, (
                    f"the header is {header_box and header_box['height']}px tall; "
                    "it has wrapped into a column")

                page.screenshot(path=str(ARTIFACTS / "workspace-light.png"),
                                full_page=False)

                # 5. Verification has not been declared yet, and the UI says so
                #    rather than showing a neutral-looking blank.
                assert "No Observer run" in page.locator(
                    'section[aria-label="Verification"]').inner_text()

                # --- run the Observer Loop -------------------------------
                run = start_run(
                    contract=contract, working_dir=isolated_settings,
                    allowed_origins=[app.base_url],
                    correction=CorrectionSpec(
                        kind="http_request",
                        summary="POST /api/fix to move the order to confirmed",
                        inputs={"url": f"{app.base_url}/api/fix",
                                "method": "POST",
                                "headers": {"X-Approval-Token": app.approval_token},
                                "expect_status": 200,
                                "allowed_origins": [app.base_url]},
                        reobserve_url=f"{app.base_url}/app"),
                    budgets=Budgets(max_iterations=4, deadline_seconds=420.0),
                    session_id=session.session_id)
                run = advance(run.run_id, contract)
                assert run.state is ObserverState.AWAITING_APPROVAL, (
                    # The enum alone says nothing. A run that failed here
                    # has a reason, and reporting only "FAILED is not
                    # AWAITING_APPROVAL" leaves an intermittent failure with
                    # no evidence to diagnose it from.
                    f"observer run {run.run_id} is {run.state.value}, not "
                    f"awaiting approval.\n"
                    f"  stop_reason: {run.stop_reason!r}\n"
                    f"  attempts   : "
                    f"{[(a.iteration, a.verdict, a.failure_signature) for a in run.attempts]}\n"
                    f"  browser pool: {json.dumps(pool_diagnostics())}\n"
                    f"  free RAM MB : {available_memory_mb()}")
                assert app.state.fix_attempts == 0

                # 6. The UI shows the failed verification and the exact effect
                #    awaiting a human, picked up by its own polling.
                observer_panel = page.locator('section[aria-label="Verification"]')
                page.wait_for_function(
                    """() => {
                        const el = document.querySelector('section[aria-label="Verification"]');
                        return el && el.innerText.includes('awaiting approval');
                    }""", timeout=30_000)
                panel_text = observer_panel.inner_text()
                assert "order-confirmed" in panel_text
                assert "/api/fix" in panel_text, (
                    "the approval did not display the exact proposed effect")
                # The token must never be rendered.
                assert app.approval_token not in page.content(), (
                    "a secret reached the UI")

                page.screenshot(path=str(ARTIFACTS / "workspace-approval.png"))

                # 7. Approve through the UI. This is the governed path — the
                #    click reaches the real approvals store.
                approve_button = page.get_by_role(
                    "button", name="Approve this exact effect")
                approve_button.click()
                # A double click must not spend the approval twice.
                page.wait_for_timeout(150)
                if approve_button.is_visible():
                    approve_button.click(timeout=2000)

                if not _wait(lambda: _approval_granted(run.approval_id),
                             timeout=30.0):
                    # Say why. "The click did not reach the store" names a
                    # symptom and leaves every candidate cause open — a
                    # detached node, a re-render mid-click, an error the UI
                    # swallowed into its banner, or a different approval id
                    # than the one being watched.
                    from watch_skill.actions import approval_state  # noqa: PLC0415

                    banner = page.locator(".banner")
                    raise AssertionError(
                        "the UI click did not reach the approvals store\n"
                        f"  watching approval_id : {run.approval_id}\n"
                        f"  its state            : "
                        f"{approval_state(run.approval_id) if run.approval_id else None}\n"
                        f"  approvals in snapshot: "
                        f"{json.dumps(workspace.snapshot(session.session_id).get('approvals'), default=str)}\n"
                        f"  error banner         : "
                        f"{banner.inner_text() if banner.count() else '(none)'}\n"
                        f"  approve button       : "
                        f"visible={approve_button.is_visible()} "
                        f"text={approve_button.inner_text() if approve_button.count() else '(gone)'}\n"
                        f"  console              : {console_errors[-5:]}\n"
                        f"  network              : {net_failures[-10:]}")

                # 8. The loop applies it exactly once and re-verifies.
                run = advance(run.run_id, contract)
                assert run.state is ObserverState.VERIFIED, run.stop_reason
                assert app.state.fix_attempts == 1, "the effect happened twice"

                # 9. Success names the oracle and the assurance level.
                page.wait_for_function(
                    """() => {
                        const el = document.querySelector('section[aria-label="Verification"]');
                        return el && el.innerText.includes('Verified by a deterministic oracle');
                    }""", timeout=40_000)
                verdict = observer_panel.inner_text()
                assert "isolated_local" in verdict, (
                    "a green state was shown without naming the assurance level")
                assert "deterministic oracle" in verdict

                # Scroll the centre column back to the top: the verified
                # screenshot exists to show the verdict, and a shot of the
                # timeline with the verdict scrolled away proves nothing.
                page.evaluate(
                    """() => { const c = document.querySelector('.center');
                               if (c) c.scrollTop = 0; }""")
                page.wait_for_timeout(150)
                page.screenshot(path=str(ARTIFACTS / "workspace-verified.png"))

                # 10. Reconnect: reload the host and recover from canonical
                #     state, with no duplicated timeline markers.
                before_markers = page.locator("button.marker").count()
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector('section[aria-label="Verification"]',
                                       timeout=30_000)
                page.wait_for_function(
                    """() => document.querySelectorAll('button.marker').length > 0""",
                    timeout=30_000)
                after_markers = page.locator("button.marker").count()
                assert after_markers <= before_markers * 2 + 10, (
                    f"reconnect duplicated markers: {before_markers} -> "
                    f"{after_markers}")
                assert "Verified by a deterministic oracle" in observer_panel.inner_text()

                # 11. Dark theme and a narrow embedded host.
                page.emulate_media(color_scheme="dark")
                page.wait_for_timeout(200)
                page.screenshot(path=str(ARTIFACTS / "workspace-dark.png"))

                page.set_viewport_size({"width": 420, "height": 820})
                page.wait_for_timeout(250)
                page.screenshot(path=str(ARTIFACTS / "workspace-narrow.png"))

                # Every console error, with the network failures that
                # explain them. Truncating the list hides the one entry that
                # explains an intermittent failure.
                logged = [e for e in console_errors if "favicon" not in e]
                assert not logged, (
                    f"the workspace logged {len(logged)} error(s):\n"
                    + "\n".join(f"  console: {e}" for e in logged)
                    + "\nnetwork events:\n"
                    + "\n".join(f"  {n}" for n in net_failures[-25:]))
                # Recorded, not asserted. The 4000 ms budget is real and is
                # still enforced — in `test_first_render_meets_its_budget`,
                # which measures it with nothing else running. Asserting it
                # at the end of a scenario that has just driven two browsers,
                # an Observer run and a full verification measures the
                # machine's spare capacity, not the workspace's render cost,
                # and that is how a functional proof came to fail on a
                # stopwatch.
                record_property("first_render_ms", round(first_render_ms, 1))
            finally:
                # The trace is written whatever happened. A trace kept only on
                # success is a trace kept for the case that needed no trace.
                try:
                    ARTIFACTS.mkdir(parents=True, exist_ok=True)
                    context.tracing.stop(
                        path=str(ARTIFACTS / "workspace-ui-trace.zip"))
                except Exception:  # noqa: BLE001 - never mask the real failure
                    pass
                browser.close()
    finally:
        live_session.stop_live(session.session_id)

    # 12. Reopen the finished session from canonical storage, in a fresh
    #     process, and confirm the workspace would draw the same thing.
    probe = isolated_settings.parent / "probe_workspace.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {str(REPO / "src")!r})
        from watch_skill import workspace

        state = workspace.snapshot({session.session_id!r})
        observer = state["observer"] or {{}}
        print(json.dumps({{
            "state": state["session"]["state"],
            "events": len(state["events"]),
            "observer_state": observer.get("state"),
            "assurance": observer.get("assurance"),
            "receipt_complete": (state["receipt"] or {{}}).get("complete"),
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr[-2000:]
    reopened = json.loads(result.stdout.strip().splitlines()[-1])
    assert reopened["observer_state"] == "verified"
    assert reopened["assurance"] == "isolated_local"
    assert reopened["events"] > 0

    for name in ("workspace-light.png", "workspace-approval.png",
                 "workspace-verified.png", "workspace-dark.png",
                 "workspace-narrow.png"):
        artifact = ARTIFACTS / name
        assert artifact.is_file() and artifact.stat().st_size > 8000, name


def _approval_granted(approval_id: str | None) -> bool:
    if not approval_id:
        return False
    from watch_skill.actions import approval_state

    state = approval_state(approval_id)
    return bool(state and state["status"] in ("approved", "expired"))


def test_the_workspace_renders_an_empty_state_without_a_session(host) -> None:
    """A workspace with nothing to show is a state, not a blank page."""
    _require_ui()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1200, "height": 800})
            _open_workspace(page, host)
            page.wait_for_selector("text=No session", timeout=20_000)
            assert "assurance:" in page.locator("header.header").inner_text()
        finally:
            browser.close()


def test_keyboard_reaches_every_control(app, host) -> None:
    """Keyboard-only operation, asserted rather than assumed."""
    _require_ui()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            _open_workspace(page, host)
            reached: set[str] = set()
            for _ in range(40):
                page.keyboard.press("Tab")
                info = page.evaluate(
                    """() => {
                        const el = document.activeElement;
                        if (!el) return null;
                        const style = getComputedStyle(el);
                        return {
                            tag: el.tagName,
                            label: el.getAttribute('aria-label') || el.textContent?.slice(0, 30),
                            outline: style.outlineStyle,
                        };
                    }""")
                if info and info["tag"] in ("BUTTON", "INPUT", "SUMMARY", "A"):
                    reached.add(f"{info['tag']}:{info['label']}")
            assert len(reached) >= 5, f"only reached {reached}"
        finally:
            browser.close()
