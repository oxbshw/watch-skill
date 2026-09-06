# ADR-011: Browser and Evidence authority

- Status: Accepted
- Date: 2026-09-02

## Context

DeepSeek Harness 0.1.1-rc.2 provides the host approval service and the client
tool surface, but it exposes no supported extension that lets a plugin use its
internal browser runtime. Claiming that runtime as DeepWatch's authority would
therefore describe an API that does not exist.

## Decision

Watch Core owns the Playwright browser process, observations, actions,
receipts, and normalized evidence records. DeepWatch's Node tool layer owns
coordination with the Harness approval service and never accepts an approval
identifier from the model. For a consequential operation the sequence is:

1. Node asks the Harness approval service.
2. A denial returns before any browser request crosses the Bridge.
3. A one-use grant is converted to an internal approval reference.
4. Watch Core executes once under the supplied idempotency key and records a
   stable receipt and evidence identifier.
5. Watch Core alone evaluates the declared postcondition. `completed` records
   execution; only a satisfied postcondition sets `verified: true`.

| Fact | Authority | Stable reference |
| --- | --- | --- |
| User approval | DeepSeek Harness host | internal one-use approval reference |
| Browser execution | Watch Core Playwright runtime | operation and idempotency keys |
| Browser receipt | Watch Core | receipt keyed by idempotency key |
| Normalized browser evidence | Watch Core | `evidence_id` |
| Final deterministic verdict | Watch Core Verification | verification record id |

The model is advisory. It cannot mint an approval, receipt, evidence record,
or `VERIFIED` verdict. Mock transport is test-only and can never be selected by
`auto`.

## Failure and cancellation semantics

Every request carries the Bridge deadline and cancellation signal. An unknown
session, an unavailable browser runtime, malformed parameters, a deadline, or
a dead process is a typed refusal with a remediation. Retrying the same
idempotency key and input replays the original receipt; reusing it with a
different input is a conflict. A reconnect never silently repeats a click.

## Evidence

`tests/surfaces/test_bridge_browser_integration.py` drives real Chromium
against a loopback page. `workspace/tests/core-integration-packed.test.mjs`
drives the same observe → approve → act → receipt → evidence sequence through
the packed Python executable and the real Node Bridge client.
