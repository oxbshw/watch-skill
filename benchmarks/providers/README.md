# Vision provider benchmark

Sixteen providers is a menu, not an answer. This settles which one to point
Watch Skill at, on your own keys and your own machine:

```bash
watch-skill bench providers --write benchmarks/providers/RESULTS.md
```

Every provider you hold a key for reads the same frames. Everything else is
skipped by name, never dropped quietly.

```bash
watch-skill bench providers --provider groq --provider mistral   # just these two
watch-skill bench providers --model qwen2.5-vl-7b                # same model everywhere
```

## What it measures

The inputs are the perception benchmark's committed fixtures — rendered
ground truth in code, subtitles, shaped Arabic, CJK, Lao, and one frame
mixing scripts. Nothing private, nothing that drifts between runs.

The task is "transcribe every character of text in this image", because it
is the one where providers visibly differ *and* it can be checked against
ground truth. "Describe this scene" cannot be scored.

| Column | Meaning |
|---|---|
| char-hit | Share of the truth's characters recovered, as a multiset — word order cannot hide a missing character. Same metric as the [perception bench](../perception/README.md). |
| latency | Wall clock for one call, including image upload. |
| USD | The provider's **own reported** input tokens × the dated price in [`prices.json`](../../src/watch_skill/vision/prices.json). A provider that reports no usage gets `-`, never an estimate. |

## Reading it honestly

- **One call per fixture.** Latency on a single sample is noisy; treat the
  ordering as a hint and the char-hit column as the signal.
- **Model choice dominates provider choice.** A vendor's cheap tier against
  another's flagship compares the models, not the hosts. `--model` pins one
  name across providers that serve it, which is the fairer comparison when
  they do.
- **Defaults age.** The per-provider defaults in
  `health/vision_setup.py` were current when written; vendors rename models
  often. Pass `--cheap-model` / `--model` rather than trusting the table.
- **A 0% row is usually a script the model cannot read**, not a broken
  provider — see how differently the fixtures score in the perception bench.

## Results

[RESULTS.md](RESULTS.md) holds whatever was last measured, with the machine
and date attached. It is not filled in from vendor marketing, and a row that
was not run is absent rather than guessed.

If you run this with keys we do not have, a PR updating RESULTS.md — with
the machine line intact — is welcome and is the most useful contribution
this benchmark can get.
