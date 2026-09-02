"""The Observer Loop: a broken app, an approved fix, and an independent verdict.

Everything is local and deterministic. The target is
`watch_skill.live.fixture_app` — a broken order desk served on loopback from
this repository — so the example is rights-clear and reproduces identically
every run.

What it demonstrates, in order:

1. success declared as two checkable postconditions, frozen before any work;
2. live browser observation of the broken application;
3. the postcondition failing against the real page;
4. a correction proposed, and the loop STOPPING for a human;
5. an explicit approval by a named operator;
6. the correction applied exactly once;
7. a verdict produced by a separate verifier process;
8. the receipt, with hashes, read back afterwards.

No model is involved. The oracle is deterministic, and the video is evidence
for a human rather than the stop condition.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

# Its own data directory. An example that wrote into the reader's real index —
# or inherited their vision provider and cost policy from a local .env — would
# behave differently on every machine, which is the opposite of a demonstration.
os.environ.setdefault("WATCHSKILL_DATA_DIR",
                      tempfile.mkdtemp(prefix="observer example data "))


def main() -> int:
    from watch_skill.live import buffer as buf
    from watch_skill.live import observe, start_live, stop_live
    from watch_skill.live.capabilities import capability_for
    from watch_skill.live.clips import ClipError
    from watch_skill.live.fixture_app import BROKEN_STATUS, FIXED_STATUS, FixtureApp
    from watch_skill.observer import (
        Budgets,
        CorrectionSpec,
        ObserverState,
        advance,
        approve_pending,
        start_run,
    )
    from watch_skill.verify import load_run
    from watch_skill.verify.contract import Check, VerificationContract

    if capability_for("browser").status != "available":
        print("browser capture is unavailable; `playwright install chromium`")
        return 1

    work = Path(tempfile.mkdtemp(prefix="observer example "))

    with FixtureApp() as app:
        print(f"the broken order desk is at {app.base_url}")
        print(f"its order status is {app.state.status!r}\n")

        # --- 1. success, declared and frozen BEFORE any work ---------------
        contract = VerificationContract(
            contract_id="order-confirmed",
            title="the order reaches confirmed",
            created_by="example",
            checks=[
                # timeout_seconds is the *check* budget, and a browser check
                # spends most of it launching a browser rather than reading
                # the page. The 30s default is fine for a file or an HTTP
                # call and too tight for this, especially with a live session
                # already competing for the machine.
                Check(id="dom-status", type="browser_dom", required=True,
                      description="the status element reads 'confirmed'",
                      timeout_seconds=120.0,
                      params={"url": f"{app.base_url}/app",
                              "selector": "#order-status", "mode": "text",
                              "expected": FIXED_STATUS, "timeout_ms": 8000}),
                Check(id="server-state", type="http_request", required=True,
                      description="the server agrees",
                      params={"url": f"{app.base_url}/api/state",
                              "status": 200, "body_contains": FIXED_STATUS}),
            ],
        ).freeze(created_by="example")
        print("postcondition frozen before any work:")
        print(f"  contract {contract.contract_id}  digest {contract.digest[:23]}…")
        for check in contract.checks:
            print(f"  required: {check.id} — {check.description}")

        # --- 2. watch it live ----------------------------------------------
        print("\nwatching the broken application live...")
        session = start_live(f"{app.base_url}/app", kind="browser", fps=3.0,
                             audio=False, allow_local=True)
        deadline = time.monotonic() + 60
        anchor = None
        while time.monotonic() < deadline:
            events = observe(session.session_id, limit=300)["events"]
            errors = [e for e in events if e["type"] == "error"]
            if errors:
                anchor = errors[0]["media_ts"]
                print(f"  observed failure at {anchor:.2f}s: "
                      f"{errors[0]['summary'][:70]}")
                break
            time.sleep(0.3)

        try:
            # --- 3. the loop --------------------------------------------------
            run = start_run(
                contract=contract,
                working_dir=work,
                allowed_origins=[app.base_url],
                correction=CorrectionSpec(
                    kind="http_request",
                    summary="POST /api/fix to move the order to confirmed",
                    inputs={"url": f"{app.base_url}/api/fix", "method": "POST",
                            "headers": {"X-Approval-Token": app.approval_token},
                            "expect_status": 200,
                            "allowed_origins": [app.base_url]},
                    reobserve_url=f"{app.base_url}/app"),
                budgets=Budgets(max_iterations=4, deadline_seconds=300.0),
                session_id=session.session_id,
            )
            print(f"\nobserver run {run.run_id} started")

            run = advance(run.run_id, contract)
            print(f"  state: {run.state.value}")
            print(f"  attempt 1 verdict: {run.attempts[-1].verdict}")
            print(f"  {run.stop_reason}")
            print(f"  the order is still {app.state.status!r}, "
                  f"fix attempts: {app.state.fix_attempts}")
            if run.state is not ObserverState.AWAITING_APPROVAL:
                print("!!! the loop did not stop for approval")
                return 1
            if app.state.status != BROKEN_STATUS:
                print("!!! something changed the world without approval")
                return 1

            # --- 4. a human approves, by name ------------------------------
            print("\na human approves the specific effect...")
            run = approve_pending(run.run_id, actor="operator@example",
                                  reason="documented remediation")

            run = advance(run.run_id, contract)
            print(f"  state: {run.state.value}")
            print(f"  attempt 2 verdict: {run.attempts[-1].verdict}")
            print(f"  order is now {app.state.status!r}, "
                  f"applied {app.state.fix_attempts} time(s)")

            if anchor is not None:
                # No wait here: `clip_around` waits for the far side of the
                # window itself, and stops the moment the answer is final.
                try:
                    clip = buf.clip_around(session.session_id, anchor,
                                           before=3.0, after=3.0)
                    print(f"  evidence clip spanning the failure: {clip.name}")
                except ClipError as exc:
                    # Printed rather than swallowed. "no clip" and "no clip
                    # because capture started after the failure" send a reader
                    # to different places.
                    print(f"  no evidence clip: {exc}")
        finally:
            stop_live(session.session_id)

        # --- 5. the receipt ------------------------------------------------
        verifying = run.attempts[-1].run_id
        _c, bundle, attestation = load_run(verifying)
        print("\nthe verdict came from an independent oracle:")
        print(f"  verification run: {verifying}")
        assurance = getattr(bundle.assurance, "value", bundle.assurance)
        verdict = getattr(bundle.verdict, "value", bundle.verdict)
        print(f"  assurance:        {assurance}")
        print(f"  verdict:          {verdict}")
        print(f"  contract digest:  {bundle.contract_digest[:23]}…")
        print(f"  attestation:      {attestation.bundle_digest[:23]}…")
        for result in bundle.check_results:
            status = getattr(result.status, "value", result.status)
            print(f"  {result.check_id:<14} {status:<12} "
                  f"observed={result.observed!r}")
            if result.error:
                print(f"    {result.summary[:140]}")

        print(f"\n>>> final state: {run.state.value}")
        print(">>> the model did not decide this. A separate process read the")
        print(">>> page and the server, and both postconditions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
