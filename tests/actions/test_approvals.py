"""The line between deciding something should happen and being allowed to.

Most of these are adversarial: they describe an acting agent trying to satisfy
its own approval requirement. Every one of them must fail closed, because an
approval an agent can grant itself is not an approval.
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

from watch_skill.actions import db
from watch_skill.actions.approvals import (
    ApprovalError,
    approval_state,
    approve,
    consume,
    effect_digest,
    reject,
    request_approval,
)
from watch_skill.actions.types import ActionState, ApprovalStatus

EFFECT = {"url": "http://127.0.0.1:9999/api/fix", "method": "POST"}


def test_a_fresh_request_grants_nothing() -> None:
    approval = request_approval(kind="http_post", inputs=EFFECT,
                                summary="mark the order confirmed")
    assert approval.status is ApprovalStatus.PENDING
    with pytest.raises(ApprovalError) as excinfo:
        consume(approval.approval_id, kind="http_post", inputs=EFFECT)
    assert excinfo.value.code == "actions.approval_not_granted"


def test_an_approved_effect_can_be_spent_exactly_once() -> None:
    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix")
    approve(approval.approval_id, actor="operator@example")
    spent = consume(approval.approval_id, kind="http_post", inputs=EFFECT)
    assert spent.used_at is not None

    with pytest.raises(ApprovalError) as excinfo:
        consume(approval.approval_id, kind="http_post", inputs=EFFECT)
    assert excinfo.value.code == "actions.approval_already_used"


def test_an_approval_does_not_cover_a_different_effect() -> None:
    """The substitution attack: get one thing approved, then do another.

    This is why the approval binds to a hash of the effect rather than to the
    action id — the id would still match after the payload was swapped.
    """
    approval = request_approval(kind="http_post", inputs=EFFECT,
                                summary="mark the order confirmed")
    approve(approval.approval_id, actor="operator@example")
    with pytest.raises(ApprovalError) as excinfo:
        consume(approval.approval_id, kind="http_post",
                inputs={**EFFECT, "url": "http://127.0.0.1:9999/api/delete"})
    assert excinfo.value.code == "actions.approval_effect_mismatch"
    # And the real approval is still unspent — a refused attempt must not
    # burn the operator's decision.
    assert consume(approval.approval_id, kind="http_post", inputs=EFFECT)


def test_a_stale_approval_is_refused() -> None:
    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix",
                                ttl_seconds=1.0)
    approve(approval.approval_id, actor="operator@example")
    time.sleep(1.2)
    with pytest.raises(ApprovalError) as excinfo:
        consume(approval.approval_id, kind="http_post", inputs=EFFECT)
    assert excinfo.value.code == "actions.approval_expired"


def test_a_rejected_request_cannot_be_approved_afterwards() -> None:
    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix")
    reject(approval.approval_id, actor="operator@example", reason="not now")
    # Approving after a decision is a no-op, not a second chance: the decision
    # was already made and recorded.
    after = approve(approval.approval_id, actor="operator@example")
    assert after.status is ApprovalStatus.REJECTED
    with pytest.raises(ApprovalError):
        consume(approval.approval_id, kind="http_post", inputs=EFFECT)


def test_an_approval_must_name_who_granted_it() -> None:
    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix")
    with pytest.raises(ApprovalError) as excinfo:
        approve(approval.approval_id, actor="   ")
    assert excinfo.value.code == "actions.approval_actor_required"


def test_approving_a_request_that_does_not_exist_fails_closed() -> None:
    with pytest.raises(ApprovalError) as excinfo:
        approve("apr_doesnotexist", actor="operator@example")
    assert excinfo.value.code == "actions.approval_not_found"


def test_the_effect_digest_is_stable_across_key_ordering() -> None:
    """Two processes describing the same effect must agree, or the binding
    between an approval and an effect means nothing."""
    a = effect_digest("http_post", {"url": "u", "method": "POST", "body": {"x": 1}})
    b = effect_digest("http_post", {"body": {"x": 1}, "method": "POST", "url": "u"})
    assert a == b
    assert a != effect_digest("http_post", {"url": "u", "method": "DELETE"})


def test_concurrent_approvals_produce_one_decision() -> None:
    """A double-clicked approve button must not grant twice."""
    import threading

    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix")
    results: list[str] = []

    def decide(actor: str) -> None:
        try:
            results.append(approve(approval.approval_id, actor=actor).actor)
        except ApprovalError:
            results.append("refused")

    threads = [threading.Thread(target=decide, args=(f"operator{i}",))
               for i in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    final = db.get_approval(approval.approval_id)
    assert final is not None and final.status is ApprovalStatus.APPROVED
    # Whoever won, exactly one actor is recorded — not the last writer.
    assert results.count(final.actor) >= 1
    assert len({r for r in results if r != "refused"}) == 1


def test_the_oracle_reads_approvals_from_the_store_not_from_evidence(
    isolated_settings: Path,
) -> None:
    """The verification oracle must consult the store, in its own process.

    Run in a *separate interpreter* so nothing this test holds in memory can
    be supplying the answer — the independence claim is about processes, and
    asserting it in-process would prove nothing about it.
    """
    approval = request_approval(kind="http_post", inputs=EFFECT, summary="fix")
    approve(approval.approval_id, actor="operator@example")

    probe = isolated_settings.parent / "probe_approval.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {str(Path(__file__).resolve().parents[2] / "src")!r})
        from watch_skill.verify.checks import CheckContext, run_check
        from watch_skill.verify.contract import Check

        ctx = CheckContext(working_dir={str(isolated_settings)!r})
        granted = run_check(Check(
            id="approved", type="human_approval",
            params={{"approval_id": {approval.approval_id!r}}}), ctx)
        # An agent asserting its own approval in the evidence dict must not
        # be able to satisfy the oracle.
        forged = run_check(Check(
            id="forged", type="human_approval",
            params={{"approval_id": "apr_forged"}}),
            CheckContext(working_dir={str(isolated_settings)!r},
                         evidence={{"approvals": {{"apr_forged": "approved"}}}}))
        print(json.dumps({{
            "granted": granted.status.value,
            "granted_summary": granted.summary,
            "forged": forged.status.value,
        }}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["granted"] == "pass"
    assert "operator@example" in payload["granted_summary"]
    assert payload["forged"] == "fail", (
        "an agent satisfied a human-approval oracle from its own evidence")


def test_approval_state_reports_expiry_against_the_clock_now() -> None:
    """Expiry is resolved against the clock now, not frozen at creation.

    Two approvals rather than one. A single short-lived approval had to be
    created, approved and read inside its entire lifetime, and the TTL has a
    one-second floor -- a budget no loaded machine can promise. It failed on a
    CI runner taking more than twice its usual time for the suite. Each
    direction now has room where it needs it: a long-lived approval for "not
    expired", and a poll rather than a fixed sleep for "expired".
    """
    live = request_approval(kind="http_post", inputs=EFFECT, summary="fix",
                            ttl_seconds=300.0)
    approve(live.approval_id, actor="operator@example")
    assert approval_state(live.approval_id)["expired"] is False

    brief = request_approval(kind="http_post", inputs=EFFECT, summary="fix",
                             ttl_seconds=2.0)
    approve(brief.approval_id, actor="operator@example")
    deadline = time.monotonic() + 30.0
    state = approval_state(brief.approval_id)
    while time.monotonic() < deadline and not state["expired"]:
        time.sleep(0.05)
        state = approval_state(brief.approval_id)
    assert state["expired"] is True, "a two-second approval never expired"
    assert state["status"] == "expired"


# --- action lifecycle --------------------------------------------------------


def test_an_idempotency_key_makes_a_repeated_proposal_one_action() -> None:
    """A trigger delivered twice must propose once."""
    from watch_skill.actions.types import Action

    first = db.insert_action(Action(
        action_id="act_first", kind="http_post", idempotency_key="fix-order-A",
        summary="fix the order"))
    second = db.insert_action(Action(
        action_id="act_second", kind="http_post", idempotency_key="fix-order-A",
        summary="fix the order"))
    assert first.action_id == "act_first"
    assert second.action_id == "act_first", "a duplicate proposal created a second action"
    assert len(db.list_actions()) == 1


def test_a_transition_is_conditional_on_the_current_state() -> None:
    """Compare-and-swap: two workers must not both start one approved action."""
    from watch_skill.actions.types import Action

    db.insert_action(Action(action_id="act_cas", kind="http_post",
                            state=ActionState.APPROVED))
    won = db.transition("act_cas", ActionState.STARTED,
                        expect=ActionState.APPROVED, actor="worker-1")
    lost = db.transition("act_cas", ActionState.STARTED,
                         expect=ActionState.APPROVED, actor="worker-2")
    assert won is not None and won.state is ActionState.STARTED
    assert lost is None, "two workers both started one approved action"


def test_the_transition_log_explains_how_an_action_got_where_it_is() -> None:
    from watch_skill.actions.types import Action

    db.insert_action(Action(action_id="act_log", kind="http_post",
                            proposed_by="observer-loop"))
    db.transition("act_log", ActionState.AWAITING_APPROVAL, actor="observer-loop")
    db.transition("act_log", ActionState.APPROVED, actor="operator@example")
    db.transition("act_log", ActionState.STARTED, actor="executor")
    db.transition("act_log", ActionState.SUCCEEDED, actor="executor")

    history = db.transitions_for("act_log")
    assert [entry["to"] for entry in history] == [
        "proposed", "awaiting_approval", "approved", "started", "succeeded"]
    assert history[2]["actor"] == "operator@example"
    # Succeeded is not verified, and the log must not pretend otherwise.
    assert "verified" not in [entry["to"] for entry in history]


def test_succeeding_is_not_the_same_as_being_verified() -> None:
    from watch_skill.actions.types import Action

    action = Action(action_id="act_v", kind="http_post",
                    state=ActionState.SUCCEEDED)
    assert action.can_move_to(ActionState.VERIFICATION_PENDING)
    assert action.can_move_to(ActionState.VERIFICATION_FAILED)
    # An action cannot go back and run again once it has succeeded.
    assert not action.can_move_to(ActionState.STARTED)


def test_an_action_cannot_skip_approval() -> None:
    from watch_skill.actions.types import Action

    action = Action(action_id="act_skip", kind="http_post",
                    state=ActionState.AWAITING_APPROVAL)
    assert not action.can_move_to(ActionState.STARTED), (
        "an action reached execution without passing through approval")
    assert not action.can_move_to(ActionState.SUCCEEDED)
