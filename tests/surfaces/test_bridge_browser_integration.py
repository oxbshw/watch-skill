"""End-to-end Browser/Evidence Bridge proof against real local Chromium."""
from __future__ import annotations

import pytest

from watch_skill.operate.fixture_site import FixtureSite
from watch_skill.surfaces.bridge import methods
from watch_skill.surfaces.bridge.protocol import BridgeError

pytestmark = pytest.mark.timeout(180)


def _command(session_id: str, action: dict[str, object], *, key: str) -> dict[str, object]:
    return {
        "sessionId": session_id,
        "action": action,
        "operationId": f"op_{key}",
        "idempotencyKey": key,
        "inputDigest": f"sha256:{key}",
    }


def test_real_chromium_observe_act_receipt_and_evidence() -> None:
    methods._reset_browser_bridge_state()
    with FixtureSite() as site:
        started = methods.live_start({
            "target": f"{site.base_url}/form",
            "kind": "browser",
            "allowLocal": True,
            "allowedHosts": ["127.0.0.1"],
        })
        session_id = started["session_id"]
        try:
            observed = methods.browser_observe({"sessionId": session_id})
            assert observed["authority"] == "watch-core"
            assert observed["observation"]["title"] == "Sign up"
            assert methods.evidence_get({
                "evidenceId": observed["evidenceId"],
            })["evidenceId"] == observed["evidenceId"]

            fill = _command(session_id, {
                "kind": "fill",
                "intent": "enter an email",
                "target": {"label": "Email"},
                "value": "ada@example.com",
                "side_effect": "reversible",
                "expect": {"input_value": ["#email", "ada@example.com"]},
            }, key="fill_email")
            filled = methods.browser_act(fill)
            assert filled["completed"] is True
            assert filled["verified"] is True
            assert filled["verdict"] == "succeeded"
            assert methods.browser_receipt({
                "idempotencyKey": "fill_email",
            })["status"] == "completed"
            assert methods.browser_act(fill) == filled

            click = _command(session_id, {
                "kind": "click",
                "intent": "create the account",
                "target": {"role": "button", "name": "Create account"},
                "expect": {"text_present": "Account created"},
            }, key="create_account")
            with pytest.raises(BridgeError) as refused:
                methods.browser_act(click)
            assert refused.value.error == "bridge.approval_required"
            assert site.state.form_submits == 0

            approved = methods.browser_act({**click, "approvalId": "host-approved-once"})
            assert approved["completed"] is True
            # The click was dispatched, but the incomplete form did not reach
            # the stated postcondition. Completion and verification stay separate.
            assert approved["verified"] is False
            assert approved["verdict"] == "failed"
            assert site.state.form_submits == 1
            evidence = methods.evidence_get({"evidenceId": approved["evidenceId"]})
            assert evidence["producer"] == "watch-core-browser-runtime"
        finally:
            methods.live_stop({"sessionId": session_id, "reason": "integration complete"})
            methods._reset_browser_bridge_state()
