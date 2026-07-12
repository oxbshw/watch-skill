# 13 — Self-improvement: lessons, evals, prune

This example exercises the complete correction cycle: an answer is grounded
or refused, a correction becomes a classified lesson, and `lessons eval`
replays that lesson against the current pipeline. `--prune` retires guidance
that is no longer needed. The implementation is described in
[docs/guides/how-it-improves-itself.md](../../docs/guides/how-it-improves-itself.md).

The script uses a temporary index and lesson store. Its final prune operation
does not touch the user's Watch Skill data.

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

This example exposed two defects during development. Common words in a
correction could make unrelated cases pass, and quoted question text could
leak into prose matching. The evaluation now reads evidence only, and the
example remains as regression coverage for both cases.

The synthetic clips are deliberately unambiguous, so they do not manufacture
a false "wrong answer, then recovery" sequence. Dense resampling and
zoom-crop re-OCR are covered by the real-footage runs referenced in
[Lessons and savings](../../docs/guides/lessons-and-savings.md).
