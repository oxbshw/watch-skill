"""The definitive end-to-end product proof.

One controlled demonstration, start to finish:

1. a deliberately broken local browser application;
2. success declared as a checkable DOM postcondition, **frozen first**;
3. live browser observation, producing pixels and structured evidence while
   the page is open;
4. a pre-event clip from the rolling buffer;
5. the postcondition failing against the real page;
6. a correction proposed, and the loop **stopping** for a human;
7. an explicit approval through the governed path;
8. the deterministic correction applied, once;
9. the corrected application observed;
10. verification from a **separate read-only process**;
11. the receipt read back from a **fresh interpreter**, with hashes checked.

The model is not the oracle. There is no model in this test at all.
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
from tests.conftest import require_verification_browser

from watch_skill.actions import db as actions_db
from watch_skill.actions.approvals import ApprovalError, approve
from watch_skill.actions.types import ActionState
from watch_skill.live import buffer as buf
from watch_skill.live import session as live_session
from watch_skill.live.capabilities import capability_for
from watch_skill.live.fixture_app import BROKEN_STATUS, FIXED_STATUS, FixtureApp
from watch_skill.observer import (
    Budgets,
    CorrectionSpec,
    ObserverState,
    advance,
    approve_pending,
    start_run,
)
from watch_skill.observer import loop as observer_loop
from watch_skill.verify.contract import Check, VerificationContract

pytestmark = pytest.mark.timeout(600)

REPO_SRC = str(Path(__file__).resolve().parents[2] / "src")


def _require_browser() -> None:
    capability = capability_for("browser")
    if capability.status != "available":
        pytest.skip(f"browser capture is {capability.status}")
    # One governed browser is about to be started. The governor refuses when
    # the machine cannot afford it, with exact numbers -- that is the product
    # working, not a defect, so the honest outcome is a skip that repeats those
    # numbers rather than a failure that looks like a capture bug.
    require_verification_browser(1)


@pytest.fixture
def app():
    _require_browser()
    with FixtureApp(splash_delay_ms=500) as running:
        yield running


def _postcondition(app, contract_id: str = "order-confirmed") -> VerificationContract:
    """Success, written down before any work happens.

    Two required checks, deliberately of different kinds. The DOM check is
    what a human would look at; the HTTP check reads the server's own state.
    A correction that only repainted the page would satisfy one and fail the
    other.
    """
    return VerificationContract(
        contract_id=contract_id,
        title="the order reaches confirmed",
        created_by="test",
        checks=[
            # timeout_seconds is the *check* budget, and a browser check
            # spends most of it launching a browser rather than reading the
            # page. The 30s default is right for a file or an HTTP call and
            # too tight for this — a live session is competing for the
            # machine, and a cold Chromium launch can take most of it.
            Check(id="dom-status", type="browser_dom", required=True,
                  description="the order status element reads 'confirmed'",
                  timeout_seconds=120.0,
                  params={"url": f"{app.base_url}/app",
                          "selector": "#order-status", "mode": "text",
                          "expected": FIXED_STATUS, "timeout_ms": 8000}),
            Check(id="server-state", type="http_request", required=True,
                  description="the server agrees the order is confirmed",
                  params={"url": f"{app.base_url}/api/state",
                          "status": 200,
                          "body_contains": FIXED_STATUS}),
        ],
    ).freeze(created_by="test")


def _correction(app) -> CorrectionSpec:
    return CorrectionSpec(
        kind="http_request",
        summary="POST /api/fix to move the order to confirmed",
        inputs={
            "url": f"{app.base_url}/api/fix",
            "method": "POST",
            "headers": {"X-Approval-Token": app.approval_token},
            "expect_status": 200,
            "allowed_origins": [app.base_url],
        },
        reobserve_url=f"{app.base_url}/app",
        requires_approval=True,
    )


def _wait_for(predicate, timeout: float, interval: float = 0.15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


# --- the whole thing ---------------------------------------------------------


def test_broken_app_observed_corrected_and_independently_verified(
    app, tmp_path: Path, isolated_settings: Path
) -> None:
    # Two governed browsers are held at once here — the live source, and the
    # verifier during `advance()`. Checked before anything starts, because a
    # refusal halfway through surfaces as an unrelated-looking state
    # assertion. See `require_verification_browser` for the measurement.
    require_verification_browser(2)

    contract = _postcondition(app)
    assert contract.frozen and contract.digest

    # 1. watch the broken application live.
    session = live_session.start_live(
        f"{app.base_url}/app", kind="browser", fps=3.0, audio=False,
        allow_local=True,
    )
    try:
        evidence = _wait_for(
            lambda: [
                event for event in
                live_session.observe(session.session_id, limit=300)["events"]
                if event["type"] == "error"
            ] or None,
            timeout=90.0)
        assert evidence, "the broken app produced no observable failure"
        assert live_session.get_session(session.session_id).state.value == "running"

        # 2. a before clip, from the rolling buffer, spanning the moment.
        #    Waiting for the buffer to pass the far edge of the window is the
        #    honest wait: a clip cannot contain footage the source has not
        #    captured yet, and clipping early would silently produce a shorter
        #    clip that still looks fine.
        anchor = evidence[0]["media_ts"]
        # The builder waits, and refuses with a reason. Waiting here for the
        # newest frame to pass the far edge proved nothing about the near
        # edge, and on a fast machine it succeeded instantly over a window
        # that had never been captured.
        before_clip = buf.clip_around(session.session_id, anchor,
                                      before=3.0, after=3.0)
        assert before_clip.is_file(), "the clip was recorded but not written"

        # 3. the loop. The postcondition already exists and cannot be edited.
        run = start_run(
            contract=contract,
            working_dir=tmp_path,
            correction=_correction(app),
            budgets=Budgets(max_iterations=4, deadline_seconds=300.0),
            allowed_origins=[app.base_url],
            session_id=session.session_id,
        )
        assert run.contract_digest == contract.digest

        # 4. it verifies, fails against the real page, proposes a correction,
        #    and then STOPS. It must not proceed on its own.
        run = advance(run.run_id, contract)
        assert run.state is ObserverState.AWAITING_APPROVAL, run.stop_reason
        assert run.approval_id, "nothing was actually put up for approval"
        assert run.attempts and run.attempts[0].verdict != "pass"
        assert app.state.status == BROKEN_STATUS, (
            "the correction was applied without approval")
        assert app.state.fix_attempts == 0

        # Advancing again changes nothing. A loop that could talk itself past
        # a pending approval by being called twice would not be a gate.
        again = advance(run.run_id, contract)
        assert again.state is ObserverState.AWAITING_APPROVAL
        assert app.state.fix_attempts == 0

        # 5. a human approves, by name.
        run = approve_pending(run.run_id, actor="operator@test",
                              reason="the fix is the documented remediation")
        assert run.state is ObserverState.CORRECTION_PROPOSED

        # 6. the loop applies it, re-observes, and re-verifies.
        run = advance(run.run_id, contract)
        assert run.state is ObserverState.VERIFIED, (
            f"{run.state.value}: {run.stop_reason}")
        assert app.state.status == FIXED_STATUS
        assert app.state.fix_attempts == 1, "the correction was applied twice"
        assert run.spend.corrections_applied == 1
        assert run.spend.verification_attempts >= 2

        # 7. an after clip, from the corrected application.
        after_events = live_session.observe(session.session_id, limit=400)["events"]
        after_anchor = max(event["media_ts"] for event in after_events)
        assert after_anchor > anchor, "the after window is not after the before one"
        after_clip = buf.clip_around(session.session_id, after_anchor,
                                     before=3.0, after=3.0)
        assert after_clip.is_file()
        assert after_clip != before_clip
    finally:
        live_session.stop_live(session.session_id)

    # 8. the verdict came from a real verification run, not from the loop.
    verifying_run_id = run.attempts[-1].run_id
    assert verifying_run_id

    # 9. read the whole receipt back from a fresh interpreter and re-check
    #    every hash. Nothing this process holds can be supplying the answer.
    probe = isolated_settings.parent / "probe_receipt.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {REPO_SRC!r})
        from watch_skill.verify import load_run
        from watch_skill.verify.evidence import digest_file
        from watch_skill.observer import get_run
        from pathlib import Path

        contract, bundle, attestation = load_run({verifying_run_id!r})
        run = get_run({run.run_id!r})
        print(json.dumps({{
            "verdict": bundle.verdict.value if hasattr(bundle.verdict, "value")
                       else str(bundle.verdict),
            "assurance": bundle.assurance.value if hasattr(bundle.assurance, "value")
                         else str(bundle.assurance),
            "contract_frozen": contract.frozen,
            "contract_digest_matches": contract.digest == contract.compute_digest(),
            "bundle_contract_digest": bundle.contract_digest,
            "attestation_digest": attestation.bundle_digest,
            "required_checks": sorted(
                r.check_id for r in bundle.check_results if r.required),
            "all_required_passed": all(
                r.status.value == "pass" for r in bundle.check_results if r.required),
            "observer_state": run.state.value,
            "observer_contract_digest": run.contract_digest,
            "before_clip": digest_file(Path({str(before_clip)!r})),
            "after_clip": digest_file(Path({str(after_clip)!r})),
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    receipt = json.loads(result.stdout.strip().splitlines()[-1])

    assert receipt["verdict"] == "pass"
    assert receipt["assurance"] == "isolated_local", (
        "the verdict did not come from an isolated verifier process")
    assert receipt["contract_frozen"] is True
    assert receipt["contract_digest_matches"] is True, "the contract was edited"
    assert receipt["bundle_contract_digest"] == contract.digest
    assert receipt["observer_contract_digest"] == contract.digest
    assert receipt["attestation_digest"].startswith("sha256:")
    assert receipt["all_required_passed"] is True
    assert receipt["required_checks"] == ["dom-status", "server-state"]
    assert receipt["observer_state"] == "verified"
    assert receipt["before_clip"].startswith("sha256:")
    assert receipt["after_clip"].startswith("sha256:")
    assert receipt["before_clip"] != receipt["after_clip"], (
        "the before and after clips are byte-identical")


# --- the boundary, attacked --------------------------------------------------


def test_the_loop_cannot_start_against_an_unfrozen_postcondition(
    app, tmp_path: Path
) -> None:
    """Declaring success after seeing the result is not verification."""
    draft = VerificationContract(
        contract_id="draft", created_by="test",
        checks=[Check(id="c", type="file_exists", params={"path": "x"})])
    with pytest.raises(observer_loop.ObserverError) as excinfo:
        start_run(contract=draft, working_dir=tmp_path)
    assert excinfo.value.code == "observer.postcondition_not_frozen"


def test_a_widened_postcondition_is_refused_mid_run(app, tmp_path: Path) -> None:
    """The target may not move while the run is aiming at it.

    An agent that noticed it was failing could otherwise freeze an easier
    contract and advance the same run against it.
    """
    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    allowed_origins=[app.base_url])
    easier = VerificationContract(
        contract_id="order-confirmed", title="anything at all", created_by="test",
        checks=[Check(id="dom-status", type="browser_dom", required=True,
                      params={"url": f"{app.base_url}/app", "selector": "body",
                              "mode": "exists"})],
    ).freeze(created_by="test")
    with pytest.raises(observer_loop.ObserverError) as excinfo:
        advance(run.run_id, easier)
    assert excinfo.value.code == "observer.postcondition_changed"


def test_the_acting_side_cannot_perform_the_correction_without_approval(
    app, tmp_path: Path
) -> None:
    """The approval is a real gate, not a recorded intention."""
    from watch_skill.actions.runner import perform

    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    correction=_correction(app),
                    budgets=Budgets(max_iterations=2, deadline_seconds=180.0),
                    allowed_origins=[app.base_url])
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.AWAITING_APPROVAL

    with pytest.raises(ApprovalError) as excinfo:
        perform(run.action_id, approval_id=run.approval_id, actor="impatient")
    assert excinfo.value.code == "actions.approval_not_granted"
    assert app.state.status == BROKEN_STATUS
    assert app.state.fix_attempts == 0
    # The fixture also counted the unauthorised attempt at its own door.
    assert app.state.rejected_attempts == 0, (
        "the correction reached the server despite having no approval")


def test_an_approval_is_spent_once_even_if_the_loop_is_advanced_twice(
    app, tmp_path: Path
) -> None:
    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    correction=_correction(app),
                    budgets=Budgets(max_iterations=4, deadline_seconds=300.0),
                    allowed_origins=[app.base_url])
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.AWAITING_APPROVAL
    approve(run.approval_id, actor="operator@test")

    from watch_skill.observer import db as observer_db

    run.state = ObserverState.CORRECTION_PROPOSED
    observer_db.save_run(run)
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.VERIFIED
    assert app.state.fix_attempts == 1, "the effect happened more than once"


def test_a_run_with_no_correction_is_exhausted_not_verified(
    app, tmp_path: Path
) -> None:
    """Observing a problem is not fixing one, and must not be reported as one."""
    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path, correction=None,
                    budgets=Budgets(max_iterations=2, deadline_seconds=180.0),
                    allowed_origins=[app.base_url])
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.EXHAUSTED
    assert run.state is not ObserverState.VERIFIED
    assert "no correction" in run.stop_reason


def test_an_unreachable_oracle_fails_closed(app, tmp_path: Path,
                                            monkeypatch) -> None:
    """A verifier nobody can reach has not said yes."""
    from watch_skill.errors import WatchSkillError

    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    correction=_correction(app),
                    budgets=Budgets(max_iterations=6, deadline_seconds=180.0,
                                    max_consecutive_unavailable_oracle=2),
                    allowed_origins=[app.base_url])

    def unavailable(*args, **kwargs):
        raise WatchSkillError("the verifier could not be started",
                              code="verify.backend_unavailable")

    monkeypatch.setattr(observer_loop, "verify_run", unavailable)
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.FAILED
    assert run.state is not ObserverState.VERIFIED
    assert "unavailable" in run.stop_reason
    assert app.state.fix_attempts == 0, "acted blind while the oracle was down"


def test_a_cancelled_run_stops_wherever_it_is(app, tmp_path: Path) -> None:
    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    correction=_correction(app),
                    budgets=Budgets(max_iterations=4, deadline_seconds=180.0),
                    allowed_origins=[app.base_url])
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.AWAITING_APPROVAL
    cancelled = observer_loop.cancel(run.run_id, reason="operator changed their mind")
    assert cancelled.state is ObserverState.CANCELLED
    # Advancing a cancelled run does nothing at all.
    assert advance(run.run_id, contract).state is ObserverState.CANCELLED
    assert app.state.fix_attempts == 0


def test_the_action_record_separates_succeeded_from_verified(
    app, tmp_path: Path
) -> None:
    """An action that ran and an action that worked are different rows."""
    contract = _postcondition(app)
    run = start_run(contract=contract, working_dir=tmp_path,
                    correction=_correction(app),
                    budgets=Budgets(max_iterations=4, deadline_seconds=300.0),
                    allowed_origins=[app.base_url])
    run = advance(run.run_id, contract)
    action_id = run.action_id
    approve_pending(run.run_id, actor="operator@test")
    run = advance(run.run_id, contract)
    assert run.state is ObserverState.VERIFIED

    action = actions_db.get_action(action_id)
    assert action is not None
    # The executor marks succeeded. Nothing in the executor may mark verified.
    assert action.state is ActionState.SUCCEEDED
    history = [entry["to"] for entry in actions_db.transitions_for(action_id)]
    assert "approved" not in history or history.index("succeeded") > 0
    assert "verified" not in history, (
        "the executing side recorded its own verification verdict")
