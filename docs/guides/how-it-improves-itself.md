# How it improves itself

No mysticism: four concrete mechanisms, each inspectable on disk, each
with a command that shows it working. Everything is local —
`~/.watch-skill/` — nothing uploads.

## 1. Corrections become lessons

`report_mistake` (MCP) / `watch-skill lessons add` (CLI) takes the wrong
answer and the correction, classifies the error (`missed-ocr`,
`sampling-miss`, `wrong-timestamp`, `hallucination`, ...), and derives a
guidance line per content type. Where the error class is mechanical, the
question is immediately re-asked with the lesson live; when the
correction's key terms surface in the new evidence, the lesson is marked
validated — proof it works, recorded at write time.

## 2. Lessons steer future answers

Two injection points:

- **The verify prompt.** The top-k lessons relevant to a question (by
  embedding similarity, with a content-type bonus) ride along when a
  vision model verifies the evidence — under a hard token cap
  (`WATCHSKILL_LESSONS_INJECTION_TOKEN_CAP`), because lessons exist to
  raise accuracy, not erode the token economy.
- **Adaptive profiles.** Lessons aggregate into per-content-type
  profiles: a screencast with a history of missed-OCR mistakes gets the
  OCR-recovery escalation FIRST and a nudged confidence floor. Profiles
  are re-derived on every report — inspect them with
  `watch-skill profiles`.

## 3. Escalations make recovered evidence permanent

The re-ask's ladder (dense re-sampling at 1024 px, zoom-crop re-OCR)
writes what it finds back into the index via `augment_video` — the next
ask starts from the better index, no lesson needed. This is why lessons
are SUPPOSED to become prunable over time: the pipeline absorbs the fix.

## 4. Every mistake becomes a test

`watch-skill lessons export-evals` turns each lesson into a replayable
case; `watch-skill evals run` replays them and appends the pass-rate to
a history file. New in v1.0, the classification loop:

```powershell
watch-skill lessons eval            # replay + classify every lesson
watch-skill lessons eval --prune    # retire the ones the pipeline outgrew
```

Each lesson is replayed against the CURRENT pipeline twice — once
normally, once with the lesson suppressed — and classified:

| state | meaning | action |
|---|---|---|
| `still-effective` | passes with the lesson, fails without | keep — it is load-bearing |
| `prunable` | passes even without it | `--prune` retires it (it only costs injection budget now) |
| `regressed` | fails even with it | flagged — the lesson no longer protects; look at it |

Replays run with verification off, so the report measures the retrieval
and lesson mechanics deterministically, not a vision model's mood.

## See it run

```powershell
uv run --no-sync python examples/13-self-improvement/self_improvement_demo.py
```

The demo builds its own isolated index (your lessons store is never
touched), shows a grounded answer, an honest refusal, a reported
hallucination becoming a lesson, and the eval report classifying three
lessons three different ways — from real replays. Known honest edge: on
clean synthetic clips the perception stack reads everything on the first
pass, so the demo cannot fake a "wrong answer later recovered by
escalation" — that path shows up on real footage (see the loop examples
and docs/guides/lessons-and-savings.md).
