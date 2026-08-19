"""Record one genuine Watch Skill session and encode it afterwards.

The value proposition this has to show is not "it summarises video". It is:
Watch Skill keeps timestamped evidence of what happened, and independently
verifies whether an agent's work actually succeeded — including when it did
not, and including the correction that fixed it.

So the scenario is the real one: a deliberately broken app, success declared as
a frozen postcondition, live observation, a failing verdict, a correction that
stops for a human, an explicit approval, the fix applied exactly once, and an
independent re-verification naming its assurance level.

Encoding happens **after** the session and every worker have stopped. An
earlier attempt ran the video encoder alongside live capture and model
inference and starved the machine, which is why the previous demo showed a
processing state and never a result. Frames here are cheap PNG screenshots
taken inline; ffmpeg runs at the end, when nothing else is competing.

Every frame records the session id and the wall clock at capture, and the
manifest keeps the beats, the persisted event count and the final verdict — so
each displayed state can be traced back to the session rather than taken on
trust.

    python scripts/make_demo.py --out build/demo
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

AWAITING_JS = (
    "() => { const el = document.querySelector("
    "'section[aria-label=\"Verification\"]');"
    " return el && el.innerText.includes('awaiting approval'); }"
)
VERIFIED_JS = (
    "() => { const el = document.querySelector("
    "'section[aria-label=\"Verification\"]');"
    " return el && el.innerText.includes("
    "'Verified by a deterministic oracle'); }"
)
SCROLL_JS = (
    "() => { const c = document.querySelector('.center');"
    " if (c) c.scrollTop = 0; }"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=REPO / "build" / "demo")
    parser.add_argument("--fps", type=float, default=2.0,
                        help="screenshot rate during the session")
    args = parser.parse_args()
    args.out = args.out.resolve()

    from playwright.sync_api import sync_playwright

    from watch_skill.actions import approve
    from watch_skill.health.binaries import require_binary
    from watch_skill.live import session as live_session
    from watch_skill.live.fixture_app import FIXED_STATUS, FixtureApp
    from watch_skill.observer import (
        Budgets,
        CorrectionSpec,
        ObserverState,
        advance,
        start_run,
    )
    from watch_skill.surfaces.mcp.devhost import DevHost
    from watch_skill.verify.contract import Check, VerificationContract

    frames_dir = args.out / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    # The verifier runs as a subprocess with this as its cwd, so it has to
    # exist before the run starts or CreateProcess fails with a message
    # about a directory rather than about verification.
    run_dir = args.out / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    for stale in frames_dir.glob("*.png"):
        stale.unlink()

    manifest: dict = {"frames": [], "beats": []}
    shots = {"n": 0}

    with FixtureApp(splash_delay_ms=500) as app, DevHost() as host:
        contract = VerificationContract(
            contract_id="order-confirmed",
            title="the order reaches confirmed",
            created_by="demo",
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
        ).freeze(created_by="demo")

        session = live_session.start_live(
            f"{app.base_url}/", kind="browser", fps=3.0, audio=False,
            allow_local=True)
        session_id = session.session_id
        print(f"session {session_id}", flush=True)

        with sync_playwright() as play:
            browser = play.chromium.launch(headless=True, args=[
                "--disable-background-networking", "--no-first-run"])
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(host.base_url, wait_until="domcontentloaded")
            page.wait_for_selector("header.header", timeout=60_000)

            def beat(label: str) -> None:
                manifest["beats"].append(
                    {"label": label, "frame": shots["n"], "at": time.time()})
                print(f"  beat: {label}", flush=True)

            def shoot() -> None:
                """One screenshot, on the calling thread.

                Playwright's sync API binds its objects to a single thread, so
                a timer thread taking screenshots while the main thread drives
                the page raises `TargetClosedError` at teardown. Capture is
                therefore interleaved with the waits instead.
                """
                path = frames_dir / f"f{shots['n'] + 1:05d}.png"
                try:
                    page.screenshot(path=str(path))
                except Exception:  # noqa: BLE001 - a dropped frame is fine
                    return
                shots["n"] += 1
                manifest["frames"].append({
                    "n": shots["n"],
                    "wall_ts": time.time(),
                    "session_id": session_id,
                })

            def hold(seconds: float) -> None:
                """Wait, filming. Replaces `time.sleep` in the scenario."""
                deadline = time.monotonic() + seconds
                interval = 1.0 / args.fps
                while time.monotonic() < deadline:
                    shoot()
                    time.sleep(max(0.0, min(interval,
                                            deadline - time.monotonic())))

            try:
                beat("live session observing the broken app")
                hold(12)

                run = start_run(
                    contract=contract, working_dir=run_dir,
                    allowed_origins=[app.base_url],
                    correction=CorrectionSpec(
                        kind="http_request",
                        summary="POST /api/fix to move the order to confirmed",
                        inputs={"url": f"{app.base_url}/api/fix",
                                "method": "POST",
                                "headers": {
                                    "X-Approval-Token": app.approval_token},
                                "expect_status": 200,
                                "allowed_origins": [app.base_url]},
                        reobserve_url=f"{app.base_url}/app"),
                    budgets=Budgets(max_iterations=4, deadline_seconds=420.0),
                    session_id=session_id)

                run = advance(run.run_id, contract)
                assert run.state is ObserverState.AWAITING_APPROVAL, \
                    run.stop_reason
                assert app.state.fix_attempts == 0
                beat("postcondition FAILED; correction awaiting a human")
                page.wait_for_function(AWAITING_JS, timeout=60_000)
                hold(4)

                approve(run.approval_id, actor="demo@watch-skill",
                        reason="approved for the release demo")
                beat("human approved the exact effect")
                hold(3)

                run = advance(run.run_id, contract)
                assert run.state is ObserverState.VERIFIED, run.stop_reason
                assert app.state.fix_attempts == 1, \
                    "the effect ran more than once"
                beat("correction applied exactly once; VERIFIED")
                page.wait_for_function(VERIFIED_JS, timeout=60_000)
                page.evaluate(SCROLL_JS)
                hold(6)
                beat("verified verdict on screen with its assurance level")

                # The assurance level lives on the attempt that established
                # it, not on the run: a run can have attempts verified at
                # different levels, and flattening that onto the run would
                # lose which verdict was reached how.
                final = run.attempts[-1] if run.attempts else None
                manifest["verdict"] = {
                    "state": run.state.value,
                    "assurance": getattr(final, "assurance", None),
                    "verified_by": getattr(final, "run_id", None),
                    "contract_id": run.contract_id,
                    "contract_digest": run.contract_digest,
                    "fix_attempts": app.state.fix_attempts,
                    "attempts": [(a.iteration, a.verdict, a.assurance)
                                 for a in run.attempts],
                }
            finally:
                browser.close()
                live_session.stop_live(session_id)

    # --- everything has stopped; only now does the encoder run ---------------
    events = live_session.observe(session_id, limit=500)["events"]
    manifest["session_id"] = session_id
    manifest["events_persisted"] = len(events)
    manifest["event_types"] = sorted({e["type"] for e in events})
    manifest["frames_captured"] = shots["n"]

    ffmpeg = str(require_binary("ffmpeg"))
    mp4 = args.out / "watch-skill-demo.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-framerate", str(args.fps),
         "-i", str(frames_dir / "f%05d.png"),
         "-vf", "scale=1152:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-crf", "30", "-movflags", "+faststart", str(mp4)],
        check=True, timeout=900)
    try:
        manifest["mp4"] = str(mp4.relative_to(REPO))
    except ValueError:
        manifest["mp4"] = str(mp4)
    manifest["mp4_bytes"] = mp4.stat().st_size

    (args.out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, default=str), encoding="utf-8")

    summary = {k: v for k, v in manifest.items() if k != "frames"}
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
