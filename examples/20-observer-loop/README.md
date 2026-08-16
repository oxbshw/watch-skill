# Observer Loop: an approved fix, and an independent verdict

Proves the claim the loop exists for: **the thing that did the work is not the
thing that decided it worked.**

The target is `watch_skill.live.fixture_app` — a broken order desk written in
this repository and served on loopback. Rights-clear, offline, and identical
every run.

## Run it

```bash
python examples/20-observer-loop/run.py
```

Real output from this machine:

```text
the broken order desk is at http://127.0.0.1:62809
its order status is 'failed'

postcondition frozen before any work:
  contract order-confirmed  digest sha256:8c25b43036e383e8…
  required: dom-status — the status element reads 'confirmed'
  required: server-state — the server agrees

watching the broken application live...
  observed failure at 0.84s: console.error: order pipeline check failed: settlement…

observer run obs_5a4f4a1f5907 started
  state: awaiting_approval
  attempt 1 verdict: fail
  waiting for a human to approve: POST /api/fix to move the order to confirmed
  the order is still 'failed', fix attempts: 0

a human approves the specific effect...
  state: verified
  attempt 2 verdict: pass
  order is now 'confirmed', applied 1 time(s)
  evidence clip spanning the failure: clip_0.84.mp4

the verdict came from an independent oracle:
  verification run: vr_23ab050d1e83
  assurance:        isolated_local
  verdict:          pass
  contract digest:  sha256:8c25b43036e383e8…
  attestation:      sha256:d0f9ce0943e02968…
  dom-status     pass         observed='confirmed'
  server-state   pass         observed={'status': 200, 'body_contains': True}

>>> final state: verified
```

## The three lines that matter

**`the order is still 'failed', fix attempts: 0`** — the loop verified, found
the postcondition unmet, proposed a correction, and *stopped*. Nothing reached
the world. Advancing again would change nothing; only a human decision moves
it forward.

**`applied 1 time(s)`** — the approval is bound to a hash of the exact effect
and is single-use. The fixture counts its own fix attempts, so "exactly once"
is asserted by the target rather than by the code under test.

**`assurance: isolated_local`** — the verdict came from a separate process
that opened its own browser and read the page itself. Not the session the loop
was watching, whose state the loop controls.

## Two postconditions, deliberately

A DOM read *and* a server read. A correction that repainted the page would
satisfy the first and fail the second; one that changed the database without
the UI following would do the reverse. Postconditions are cheap — pick ones
that fail differently.

## What is not deciding anything

No model runs in this example. The clip is produced because a human reviewing
the run wants to see what happened; it has no bearing on the verdict. Delete
the clip and the result is identical.

## See also

- [Observer Loop guide](../../docs/guides/observer-loop.md) — states, budgets, the independence boundary
- [Live browser](../19-live-browser/) — the observation half on its own
- [Verification](../../docs/verification.md) — contracts, checks, assurance levels
