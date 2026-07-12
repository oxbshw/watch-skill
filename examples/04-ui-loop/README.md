# 04 — THE LOOP (UI fix loop)

The agentic capture -> critique -> fix -> verify loop, on a deliberately
broken checkout page. This is exactly the handshake the MCP `loop_start` /
`loop_iterate` tools expose:

1. `loop_start` captures the page in a real browser and critiques the
   recording — the broken page shows `TOTAL: $NaN`, so the verdict is
   **fail** with a suggested fix.
2. The "agent" (the script) applies the fix by swapping in the fixed HTML.
3. `loop_iterate` re-captures, diffs against the previous pass, and renders
   a before/after MP4 + GIF as proof.

Critic selection is automatic: the real strong-tier vision critic when a
vision provider answers, otherwise a deterministic OCR critic — so the demo
runs with zero cloud access. Needs a local browser (Edge/Chrome, or
`playwright install chromium`); no network otherwise.

Files:

- `page_broken.html` — checkout page whose total renders as `$NaN`
- `page_fixed.html`  — same page with the price parsing fixed
- `ui_loop.py`       — the loop driver

## Run

```bash
uv run --no-sync python examples/04-ui-loop/ui_loop.py
```

There is also a CLI surface for ad-hoc use: `watch-skill loop --help`.

## Example output

Real run on this machine (no vision provider running, so the OCR critic
was selected — the loop machinery is identical either way):

```
critic: no vision provider reachable -> deterministic OCR critic

=== iteration 0: capture the BROKEN page ===
loop_id: f2b6acda6cd1
status: running  (iteration 0, score 35, verdict fail)

summary: Checkout total renders as NaN instead of a price.
issues:
- [critical] t=2.4s Total shows 'TOTAL: $NaN' — price computation is broken. | suggested fix: Parse prices as numbers before summing (Number(p) or parseFloat).

Next step: apply the suggested fixes yourself, then call loop_iterate(loop_id='f2b6acda6cd1').

=== agent applies the suggested fix (swap in fixed HTML) ===

=== iteration 1: re-capture + diff vs previous ===
loop_id: f2b6acda6cd1
status: passed  (iteration 1, score 96, verdict pass)

summary: Checkout total renders a real price; no visual defects found.
vs previous iteration: 1 fixed, 0 unchanged, 0 new, 0/2 aligned frames changed
- FIXED: Total shows 'TOTAL: $NaN' — price computation is broken.
before/after proof: C:\Users\hp\.watch-skill\loops\f2b6acda6cd1\artifacts\before_after.gif + .mp4

DEMO PASSED
```

Next: [14 — Browser-agent verification](../14-browser-verification/) applies
the same loop to a transient interaction bug. See the
[example catalog](../README.md) for the complete sequence.
