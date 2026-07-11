# 14 — Browser-agent verification (the flagship)

A checkout page updates its total when the button is clicked — and for
about 1.5 seconds mid-flow the total renders **$NaN** before the second
pass fixes it. The end state is correct: any screenshot taken after the
flow finishes looks perfect. Only the recording shows the defect.

That is the whole argument. Browser agents browse, click, and
screenshot; a screenshot shows a moment, and moments lie. watch-skill is
the independent eye that watches the recording of the session and
verdicts the FLOW.

```powershell
uv run --no-sync python examples/14-browser-verification/browser_verification_demo.py
```

What it does:

1. Serves `checkout_buggy.html` locally and starts THE LOOP on it with a
   plain-language criterion — *"after checkout is clicked, the order
   total always shows a real dollar amount (like $29.00) and never shows
   nan"* — plus the interaction script (click checkout, wait). The same
   script replays identically every iteration.
2. Iteration 0 fails: the recording's mid-flow frames carry the red
   $NaN, and the banned-term rule names it with a timestamp.
3. The "browser agent" applies the fix (here: one file swap to
   `checkout_fixed.html`).
4. Iteration 1 passes and renders the before/after MP4 + GIF proof.

## What building this caught (a story about receipts)

The demo failed three times before it passed, and each failure was a
real defect this repo has now fixed and regression-tested:

- The recording caught the $NaN, but frame selection collapsed the whole
  3-second flow to ONE frame: perceptual-hash dedup is grayscale, and a
  blue button turning gray with a total turning red is luminance-
  invisible. Loop and monitor critiques now pin evenly-spaced **flow
  cues** across short recordings — cue frames are never deduped
  (`perceive/budget.py::flow_cues`, tests in
  `tests/perceive/test_flow_cues.py`).
- With the frames finally in front of the critic, the criteria phrase
  "never **shows** nan" banned the unmatchable term "shows nan". The
  banned-term parser now sheds light verbs — "never shows X", "no Y ever
  appears" ban X and Y (`loop/critic.py::_strip_light_verbs`, tests in
  `tests/loop/test_describe_critic.py`).

A verification tool that cannot see what it recorded, or cannot parse
how people actually phrase criteria, verifies nothing. The flagship demo
is the test that proved both.

## Real output

From the reference machine (8 GB CPU-only Windows, moondream critic,
2026-07-11):

```
iteration 0: fail (score 35)
  transient NaN caught by the recording: True
fix applied (checkout_fixed.html)
iteration 1: pass (score 92)
  proof (mp4): ~/.watch-skill/loops/<id>/artifacts/before_after.mp4 (20 KB)
  proof (gif): ~/.watch-skill/loops/<id>/artifacts/before_after.gif (93 KB)

BROWSER VERIFICATION DEMO: PASSED
```
