# The Observer Loop

Watch something, decide whether it worked, and let the deciding be done by
something other than the thing that did the work.

That last clause is the whole feature. An agent that reports its own success
is reporting its own confidence, and confidence is not evidence. So the loop is
arranged so that the agent doing the work cannot be the one that says it
worked:

| Step | Who does it |
| --- | --- |
| Declare what success means | You, **before** the work starts |
| Do the work | The agent, or a human, or a deterministic correction |
| Decide whether it succeeded | A separate process, reading the world itself |
| Approve any side effect | A named human |

## The shape of a run

```python
from watch_skill.observer import Budgets, CorrectionSpec, advance, start_run
from watch_skill.verify.contract import Check, VerificationContract

# 1. Success, written down first, and frozen.
contract = VerificationContract(
    contract_id="order-confirmed",
    title="the order reaches confirmed",
    created_by="you@example",
    checks=[
        # A browser check spends most of its budget launching a browser, not
        # reading the page. The 30s default suits a file or an HTTP call and
        # is too tight here — give it room, especially if a live session is
        # already competing for the machine.
        Check(id="dom-status", type="browser_dom", required=True,
              timeout_seconds=120.0,
              params={"url": "http://127.0.0.1:5173/app",
                      "selector": "#order-status",
                      "mode": "text", "expected": "confirmed"}),
        Check(id="server-state", type="http_request", required=True,
              params={"url": "http://127.0.0.1:5173/api/state",
                      "status": 200, "body_contains": "confirmed"}),
    ],
).freeze(created_by="you@example")

# 2. A run around that postcondition, with ceilings and a declared correction.
run = start_run(
    contract=contract,
    working_dir=".",
    allowed_origins=["http://127.0.0.1:5173"],
    correction=CorrectionSpec(
        kind="http_request",
        summary="POST /api/fix to move the order to confirmed",
        inputs={"url": "http://127.0.0.1:5173/api/fix", "method": "POST",
                "expect_status": 200},
        reobserve_url="http://127.0.0.1:5173/app",
    ),
    budgets=Budgets(max_iterations=4, deadline_seconds=300),
    session_id=live_session_id,      # optional: link the footage
)

# 3. Advance. It verifies, and stops when it needs a person.
run = advance(run.run_id, contract)
print(run.state)          # awaiting_approval
print(run.stop_reason)    # waiting for a human to approve: POST /api/fix
```

Nothing has happened to the world yet. The loop verified, found the
postcondition unmet, proposed a correction, and stopped.

```python
from watch_skill.observer import approve_pending

approve_pending(run.run_id, actor="you@example", reason="documented remediation")
run = advance(run.run_id, contract)
print(run.state)                    # verified
print(run.attempts[-1].run_id)      # the verification run that established it
```

## Two checks, not one

The example declares a DOM read *and* a server read. That is not redundancy.
A correction that repainted the page without changing anything would satisfy
the first and fail the second, and a correction that changed the database
without the UI reflecting it would do the reverse. Postconditions are cheap;
pick the ones that fail differently.

## What each state means

| State | Meaning |
| --- | --- |
| `observing`, `retrying` | About to ask the oracle |
| `verification_pending` | The oracle is running, in its own process |
| `verification_failed` | The postcondition is not met. Not an error — an answer |
| `correction_proposed` | A correction exists and is cleared to run |
| `awaiting_approval` | **Stopped.** A human has to decide |
| `acting` | The approved correction is executing |
| `verified` | An independent oracle said yes |
| `exhausted` | Every budget spent without success. Nothing malfunctioned |
| `failed` | The loop itself broke — usually an unreachable oracle |
| `cancelled` | An operator stopped it |

`exhausted` and `failed` are separate because they call for different
responses, and neither is `verified`. A loop that reported "exhausted" as
"failed" would send you looking for a bug that is not there.

## Budgets

Every ceiling ends the run in `exhausted`, and there is no way to construct a
run without them:

- `max_iterations` — verify/correct cycles
- `deadline_seconds` — wall clock
- `max_tool_calls`
- `max_model_calls` — **zero by default, and honest**: this loop calls no
  model. The budget exists so a future model step cannot appear silently
- `max_usd`
- `max_repeated_failure_signature` — a correction producing the identical
  failure twice will not produce a different one on the third attempt
- `max_consecutive_unavailable_oracle` — an oracle nobody can reach has not
  said yes, so the loop fails closed rather than acting blind

The isolated verifier's overall deadline is the sum of its checks'
`timeout_seconds` plus 30 seconds, so one slow check cannot hide behind a
generous overall budget. If a contract comes back `inconclusive` with "the
verifier exceeded its deadline", that sum is what to raise — and note that
`inconclusive` is not `fail`: the oracle did not answer, so nothing was
established either way.

## The independence boundary

Five things keep the verdict out of the actor's hands:

1. **The postcondition is frozen first.** `start_run` refuses an unfrozen
   contract. The digest is copied onto the run, and advancing with a different
   contract raises `observer.postcondition_changed` — an agent that noticed it
   was failing cannot freeze an easier target and carry on.
2. **A separate verifier process.** Verdicts come back at `isolated_local`
   assurance. A contract requiring more than the available backend provides is
   refused rather than downgraded.
3. **The oracle reads the world itself.** A `browser_dom` check opens its own
   browser against the URL in the contract — not the agent's session, whose
   state the agent controls — and is read-only. There is no click, no fill, no
   evaluate, so verification cannot become the thing that makes the
   postcondition true.
4. **Approval is a separate call by a separate actor**, bound to a hash of the
   exact effect, single-use, and expiring.
5. **An append-only receipt.** The bundle, its attestation hash, the contract
   digest, and every check's input and output digest are written to disk and
   can be re-read and re-hashed from any process later.

An LLM statement, a video summary, a screenshot caption, or "looks fixed" is
never a successful oracle result. There is no code path that makes one.

## The video is evidence, not the verdict

A linked live session gives you a before clip and an after clip, cut from the
rolling buffer and spanning both sides of the moment. That footage is what a
human reviews, and it is the reason the loop is worth watching rather than
just running.

It is never the stop condition. The DOM, file, HTTP, or hash oracle is.

## Corrections

A `CorrectionSpec` is a `kind` resolved against a closed executor registry
plus structured inputs. It is never a command string and never generated code,
because the correction is a thing a human approves by reading it, and a string
assembled at runtime can be rewritten between the reading and the running.

`http_request` ships today. Executors are registered by name, and
re-registering a name is refused — an action kind is part of what an operator
approved, so it may not be redefined underneath them.

Every outbound effect passes the `action_effect` egress channel, so offline
mode closes it like every other. Approval and policy are separate gates: a
human saying yes does not override an operator's decision that this machine
performs no outbound side effects.

## Trying it

`watch_skill.live.fixture_app` is a broken order desk written in this
repository. Its order starts `failed`, and the endpoint that fixes it requires
a token — so "the agent corrected it" cannot happen by accident, and the state
survives a reload so verification reads the world rather than the page's
memory.

The full demonstration lives in
[`tests/observer/test_observer_loop.py`](../../tests/observer/test_observer_loop.py).

## See also

- [Verification](../verification.md) — contracts, checks, assurance levels
- [Live browser](live-browser.md) — the observation half
- [THE LOOP](the-loop.md) — the earlier capture-and-critique workflow
