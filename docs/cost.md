# The cost policy

Video understanding gets expensive exactly one way: shipping frames to a
paid model. Everything in Watch Skill's answer path is arranged so that
happens as late as possible, as rarely as possible, and never without
accounting.

## The ladder

Every question walks the same ladder, stopping at the first rung that
clears the confidence target:

1. **cache** — the question (or a near-duplicate) was asked before:
   served free, counted.
2. **text-first** — hybrid retrieval over the index (transcript, OCR,
   scene descriptions). No model call; this answers most questions.
3. **local escalation** — dense re-sampling and zoom-crop re-OCR. CPU
   work on this machine; $0.
4. **cheap tier** — one verify call to the configured cheap vision model
   with the exact frames about to be cited.
5. **strong tier** — same call, stronger model, only when retrieval
   stayed genuinely unsure.

## Choosing a policy

`WATCHSKILL_COST_POLICY` (or `cost_policy` in settings) selects who may
run rungs 4–5:

| policy | behavior |
|---|---|
| `cheapest` (default) | cheapest path that clears confidence wins; strong tier only on low confidence |
| `quality_first` | verify goes straight to the strong tier, every time |
| `offline_only` | only keyless/local providers (Ollama) may verify — cloud never sees a frame |

`offline_only` with no local model configured simply skips verification:
answers degrade to retrieval-grounded with the honest floor intact, not
to guesses.

## The meter

Every answer carries `cost_breakdown` (tokens by source) and
`cost_usd_estimate` (cloud calls only) in its metadata. Lifetime totals:

```powershell
watch-skill stats --cost
```

```
lifetime spend by source (estimated tokens):
  cache hits (free)  : ...
  text-first         : ~...
  local escalation   : ~...
  vision calls       : ~...
  response frames    : ~...
  cloud spend        : ~$...
```

Dollar estimates come from
[`src/watch_skill/vision/prices.json`](../src/watch_skill/vision/prices.json)
— a dated data file, deliberately conservative, updated by editing the
file (and its `as_of` date), never code.

## The receipts

[`benchmarks/cost/`](../benchmarks/cost/) holds a scripted run — N
videos, M questions, tokens and dollars per approach, on stated
hardware — with its results committed. Re-run it yourself:

```powershell
uv run --no-sync python benchmarks/cost/run_cost_benchmark.py
```
