# 13 — Self-improvement: lessons, evals, prune

The closed loop, mechanically: answers ground or refuse; corrections
become classified lessons; `lessons eval` replays every lesson against
the CURRENT pipeline and classifies it; `--prune` retires the ones the
pipeline has outgrown. Full mechanics:
[docs/guides/how-it-improves-itself.md](../../docs/guides/how-it-improves-itself.md).

Isolated by construction — the demo builds its own index and lessons
store in a temp dir, so the prune at the end never touches yours.

```powershell
uv run --no-sync python examples/13-self-improvement/self_improvement_demo.py
```

Real output from the reference machine (8 GB CPU-only Windows,
2026-07-11), trimmed:

```
Q1 (answerable): what build number is shown?
  grounded answer, honest_floor=False, cites 7741: True

Q2 (unanswerable): what is the team's OKR score?
  honest_floor=True — the engine refuses rather than invents

suppose an agent HAD invented one — report it:
  lesson #1 [hallucination] guidance: Do not assert what the evidence does not show...

--- lessons eval --report (every lesson replayed, classified) ---
  #1 (hallucination): prunable
  #2 (recoverable): prunable
  #3 (unrecoverable): regressed
  counts: {'still_effective': 0, 'prunable': 2, 'regressed': 1, 'skipped': 0}

lessons eval --prune: retired 2 lesson(s) the pipeline no longer needs;
regressed ones stay flagged for a human

  PASS  grounded answer cites the build
  PASS  unanswerable question hits the honest floor
  PASS  hallucination lesson expects the floor and passes
  PASS  surfaced correction classifies prunable
  PASS  unsurfaceable correction classifies regressed
  PASS  prune removed only the prunable

SELF-IMPROVEMENT DEMO: PASSED
```

Worth knowing: building this demo caught two real bugs in the eval
machinery — stopwords in a correction made every case pass ("the"
matches anything), and the honest floor's text quotes the question,
which leaked question words into prose matching. Both are fixed and the
pass rule now reads evidence only. The demo is the regression test that
found them.

Why no faked "wrong answer, then recovery" here: on clean synthetic
clips the perception stack reads everything on the first pass — we
tried three designs and it kept being right. The recovery path (dense
re-sample + zoom-crop re-OCR persisting evidence into the index) shows
up on real footage; see the loop demos and golden-run logs referenced in
docs/guides/lessons-and-savings.md.
