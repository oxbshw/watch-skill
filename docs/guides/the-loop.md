# Guide: THE LOOP (capture → critique → fix → verify)

## What this does

Closes the loop on visual work. You (or your agent) changed a UI; THE
LOOP records it running in a real browser (or the screen, or a window),
watches the recording, and critiques it against natural-language pass
criteria — returning structured issues with timestamps and suggested
fixes. You apply the fixes in code, iterate, and on pass it renders a
before/after MP4 + GIF as proof.

The division of labor is strict: **the loop observes, it never edits
anything.** The agent owns the code; the loop owns the evidence.

## Prerequisites

- Watch Skill installed, `watch-skill doctor` green
  ([getting started](../getting-started.md)).
- For URL targets: a Chromium-family browser (Edge/Chrome, or
  `playwright install chromium`). `screen:` / `window:<title>` targets
  need no browser.
- No cloud key required: with a vision provider the strong-tier vision
  critic judges the recording; without one, a deterministic OCR critic
  takes over (it reads rendered text, so bugs like `TOTAL: $NaN` are
  still caught). The loop machinery is identical either way.

## Commands

Start a loop against a local page with pass criteria:

```bash
uv run watch-skill loop start "http://localhost:3000/checkout" \
  "the checkout total renders a real dollar amount, no NaN or undefined"
```

The output is `loop_id`, a verdict (`pass`/`fail`), a 0–100 score, and
issues each carrying a timestamp and a suggested fix. Apply the fixes in
your code, then:

```bash
uv run watch-skill loop iterate <loop_id>
uv run watch-skill loop status  <loop_id>   # persisted state + score history
```

`iterate` re-captures the same target with the same interaction script,
re-critiques, and diffs against the previous iteration — fixed /
unchanged / new issues — so regressions are named, not vibes. It stops on
pass, `max_iterations` (default 5), or no-progress.

Drive interactions during the recording with a script (replayed
identically every iteration, so diffs are apples-to-apples):

```bash
uv run watch-skill loop start "http://localhost:3000" "cart badge shows 2 after adding two items" \
  --script '[{"action":"click","selector":"#add-to-cart"},{"action":"click","selector":"#add-to-cart"},{"action":"wait","seconds":1}]'
```

Capture without judging (just record + analyze + index):

```bash
uv run watch-skill capture "screen:" --duration 15
uv run watch-skill capture "window:Calculator" --duration 10
```

From an MCP agent the same flow is the
[`loop_start`](../tools/README.md#loop_start) /
[`loop_iterate`](../tools/README.md#loop_iterate) handshake — the tool
descriptions steer the agent to apply fixes itself between calls.

## Expected output shape

```
loop_id: f2b6acda6cd1
status: running  (iteration 0, score 35, verdict fail)

summary: Checkout total renders as NaN instead of a price.
issues:
- [critical] t=2.4s Total shows 'TOTAL: $NaN' — price computation is broken. | suggested fix: Parse prices as numbers before summing (Number(p) or parseFloat).

Next step: apply the suggested fixes yourself, then call loop_iterate(loop_id='f2b6acda6cd1').
```

and after the fix:

```
status: passed  (iteration 1, score 96, verdict pass)
vs previous iteration: 1 fixed, 0 unchanged, 0 new, 0/2 aligned frames changed
before/after proof: ~/.watch-skill/loops/f2b6acda6cd1/artifacts/before_after.gif + .mp4
```

A complete runnable version of exactly this scenario is
[examples/04-ui-loop](../../examples/04-ui-loop).

## Notes and sharp edges

- Loop state persists under `~/.watch-skill/loops/<loop_id>/` — loops
  survive agent restarts; `loop status` works across sessions.
- Every capture is also indexed like any watched video, so you can
  `ask`/`search` old loop recordings later.
- Old loop archives are bounded: `watch-skill clean --loops` keeps the 10
  most recent (`--keep-loops N` to change).
- The critic line printed at loop start tells you which critic is active;
  see [troubleshooting](../troubleshooting.md) if the critique seems
  shallower than expected.
