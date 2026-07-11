# Cost benchmark

One script, three arms, committed results. The point is not that the
numbers are small — it is that they are MEASURED, on stated hardware, on
a stated date, by a script anyone can re-run:

```powershell
uv run --no-sync python benchmarks/cost/run_cost_benchmark.py
```

- The run isolates its own index (`WATCHSKILL_DATA_DIR` → temp dir), so
  it never touches your library and starts from zero every time.
- The **offline arm** is a real run: 4 clips watched + indexed, 6
  questions answered (2 repeats to exercise the cache), every token off
  the cost meter.
- The **raw-frames arm** is arithmetic over the SAME index — what
  shipping every frame per question costs — and the table labels it as
  computed, not run.
- The **Gemini free-tier arm** runs only when a `GEMINI_API_KEY` is
  configured; otherwise the table says exactly that instead of inventing
  a number.

Current results: [RESULTS.md](RESULTS.md).
