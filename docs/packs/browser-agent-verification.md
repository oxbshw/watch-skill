# Pack: browser-agent verification

Agents can drive real browsers now — Claude in Chrome and its peers
browse, click, and screenshot. A screenshot shows a moment. It cannot
show a flow: the toast that flashed for 400 ms, the total that read NaN
for two frames before the re-render, the redirect loop that resolved
itself. watch-skill is the independent eye that watches the RECORDING
of the session and verdicts the whole flow.

watch-skill does not compete with browser agents. It verifies them.

## The recipe (existing tools only)

1. **Record the session.** Either let watch-skill drive and record the
   flow itself (`loop_start` with a script — the replay is identical
   every iteration), or record the browser agent's own session window
   (`capture "window:<title>"`). On small machines release the local
   vision model before capturing — a resident model and a browser do
   not share 8 GB well.
2. **State the criteria in plain language.** Flow properties, not pixel
   coordinates: *"the checkout completes, no error toast ever appears,
   the total is never NaN"*. Negative claims ("never X") are enforced
   deterministically on every frame; exemplars ("a real price (like
   $29.00)") become shape checks.
3. **Verdict.** `loop_start` returns pass/fail with per-timestamp
   issues; on pass after a fix, `loop_iterate` renders the before/after
   MP4 + GIF proof artifact.
4. **When it fails, file it.** `extract_bug_report <video>` pinpoints
   the timestamp, the frame, and the exact on-screen error text.

```powershell
watch-skill loop start "http://localhost:3000/checkout" `
  "the checkout completes, no error toast ever appears, the total is never NaN" `
  --script '[{"action":"click","selector":"#add-to-cart"},{"action":"click","selector":"#checkout"},{"action":"wait","seconds":2}]'
# ...the browser agent (or you) fixes the code...
watch-skill loop iterate <loop_id>
```

## Live example

[`examples/14-browser-verification/`](../../examples/14-browser-verification/)
drives a checkout flow with a deliberately injected flow bug — the total
flashes NaN for a few frames mid-update, invisible to any single
screenshot — and shows the loop catching it, the fix, and the pass with
proof artifacts.

## Notes

- The interaction script replays identically every iteration; that is
  what makes before/after comparison honest.
- The critic runs on your configured vision backend — the local
  moondream path works, with the deterministic banned-term/exemplar
  rules doing the judging on small models.
