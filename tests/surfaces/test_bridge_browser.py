"""The real Browser/Evidence authority exposed through the Core Bridge.

These tests stay below Playwright on purpose: the browser runtime already has
its own real-browser suite.  Here the boundary under test is the one that was
missing -- session ownership, approval-before-touch, idempotent receipts, and
Core-minted evidence that can be resolved by id.
"""
from __future__ import annotations

from typing import Any

import pytest

from watch_skill.operate.observe import BrowserObservation
from watch_skill.operate.types import Action, ActionReceipt, Verdict
from watch_skill.surfaces.bridge import methods
from watch_skill.surfaces.bridge.protocol import BridgeError


class FakeRuntime:
    """A deterministic substitute for the separately-tested Playwright runtime."""

    def __init__(self) -> None:
        self.acts = 0
        self.observations = 0

    def observe(self) -> BrowserObservation:
        self.observations += 1
        return BrowserObservation(
            url="https://example.test/account",
            title="Account",
            navigation_epoch=3,
            text="Save settings",
        )

    def act(self, action: Action) -> ActionReceipt:
        self.acts += 1
        return ActionReceipt(
            action_id=action.action_id,
            kind=action.kind,
            intent=action.intent,
            verdict=Verdict.UNVERIFIED,
            reason="No executable expectation was supplied.",
        )


@pytest.fixture(autouse=True)
def isolated_bridge_state(monkeypatch: pytest.MonkeyPatch) -> FakeRuntime:
    runtime = FakeRuntime()
    methods._reset_browser_bridge_state()
    monkeypatch.setattr(methods, "_runtime_for_session", lambda _session_id: runtime)
    yield runtime
    methods._reset_browser_bridge_state()


def command_params(**overrides: Any) -> dict[str, Any]:
    action = {
        "kind": "click",
        "intent": "Save the account settings",
        "target": {"role": "button", "name": "Save"},
        "expect": {},
    }
    return {
        "sessionId": "live_browser_1",
        "action": action,
        "operationId": "op_1",
        "idempotencyKey": "idem_1",
        "inputDigest": "sha256:action-1",
        **overrides,
    }


def test_observe_is_real_and_mints_resolvable_evidence() -> None:
    observed = methods.browser_observe({"sessionId": "live_browser_1"})
    assert observed["authority"] == "watch-core"
    assert observed["observation"]["title"] == "Account"
    assert observed["verification"] is None
    evidence_id = observed["evidenceId"]

    evidence = methods.evidence_get({"evidenceId": evidence_id})
    assert evidence["evidenceId"] == evidence_id
    assert evidence["modality"] == "dom"
    assert evidence["provenance"] == "observation"
    assert evidence["contentDigest"].startswith("sha256:")
    assert "example.test" not in str(evidence)


def test_side_effecting_action_is_refused_before_page_touch(
    isolated_bridge_state: FakeRuntime,
) -> None:
    with pytest.raises(BridgeError) as raised:
        methods.browser_act(command_params())
    assert raised.value.error == "bridge.approval_required"
    assert isolated_bridge_state.acts == 0


def test_approved_action_returns_unverified_not_success(
    isolated_bridge_state: FakeRuntime,
) -> None:
    result = methods.browser_act(command_params(approvalId="approval_host_1"))
    assert isolated_bridge_state.acts == 1
    assert result["authority"] == "watch-core"
    assert result["verdict"] == "unverified"
    assert result["completed"] is True
    assert result["verified"] is False
    assert result["evidenceId"].startswith("evi_")


def test_same_key_and_digest_replays_one_receipt(
    isolated_bridge_state: FakeRuntime,
) -> None:
    first = methods.browser_act(command_params(approvalId="approval_host_1"))
    second = methods.browser_act(command_params(approvalId="approval_host_1"))
    assert second == first
    assert isolated_bridge_state.acts == 1
    assert methods.browser_receipt({"idempotencyKey": "idem_1"})["status"] == "completed"


def test_same_key_with_different_digest_is_a_conflict(
    isolated_bridge_state: FakeRuntime,
) -> None:
    methods.browser_act(command_params(approvalId="approval_host_1"))
    with pytest.raises(BridgeError) as raised:
        methods.browser_act(command_params(
            approvalId="approval_host_1", inputDigest="sha256:different",
        ))
    assert raised.value.error == "bridge.idempotency_conflict"
    assert isolated_bridge_state.acts == 1


def test_unknown_receipt_and_evidence_are_explicit_absence() -> None:
    assert methods.browser_receipt({"idempotencyKey": "never-seen"}) == {
        "status": "unknown", "idempotencyKey": "never-seen",
    }
    with pytest.raises(BridgeError) as raised:
        methods.evidence_get({"evidenceId": "evi_missing"})
    assert raised.value.error == "evidence.not_found"


@pytest.mark.parametrize("missing", ["operationId", "idempotencyKey", "inputDigest"])
def test_command_identity_fields_are_mandatory(missing: str) -> None:
    params = command_params(approvalId="approval_host_1")
    params.pop(missing)
    with pytest.raises(BridgeError) as raised:
        methods.browser_act(params)
    assert raised.value.error == "bridge.invalid_params"


def test_malformed_action_is_refused_without_touching_page(
    isolated_bridge_state: FakeRuntime,
) -> None:
    with pytest.raises(BridgeError) as raised:
        methods.browser_act(command_params(
            approvalId="approval_host_1", action={"kind": "invented"},
        ))
    assert raised.value.error == "bridge.invalid_params"
    assert isolated_bridge_state.acts == 0


def test_stopped_or_foreign_session_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(methods, "_runtime_for_session", lambda _session_id: None)
    with pytest.raises(BridgeError) as raised:
        methods.browser_observe({"sessionId": "dead"})
    assert raised.value.error == "browser.session_unavailable"
