# Guide: lessons and the savings meter

## What this does

Two v0.6 systems that make Watch Skill cheaper and more accurate the more
you use it — both entirely local, nothing uploaded:

- **Lessons.** When a video answer turns out wrong, report it with the
  correction. The mistake is classified (`missed-ocr`,
  `wrong-timestamp`, `sampling-miss`, …), stored as a lesson with derived
  guidance, and injected into future similar questions. Where the error
  class is mechanical enough, the original question is re-asked
  immediately with the lesson applied — if the correction's key terms now
  surface in the evidence, the lesson is marked **validated**. Every
  lesson also becomes a replayable eval case, so "is it actually
  learning?" is a number, not a feeling.
- **The savings meter.** Answers are text-first (timestamped evidence
  instead of raw frames) and served through a semantic answer cache;
  every answer estimates the tokens that would have been burned by naive
  raw-frame injection and adds it to a lifetime counter.

## Prerequisites

- At least one indexed video ([getting started](../getting-started.md)).
- Nothing else — lessons, evals, profiles, and the meter all run local.

## Commands

Report a wrong answer (the MCP twin is
[`report_mistake`](../tools/README.md#report_mistake) — agents are
instructed to call it whenever the user corrects a video answer):

```bash
uv run watch-skill lessons add <video_id> \
  "what discount code is shown?" \
  "no code is shown" \
  "the code SAVE20 appears on screen at 1:45"
```

Inspect and manage what has been learned:

```bash
uv run watch-skill lessons list            # newest first; ✓ = validated
uv run watch-skill lessons rm 3            # remove one (or --session <id>)
```

Replay the lesson-derived eval suite — the pass rate rising over time is
the learning, measured:

```bash
uv run watch-skill lessons export-evals
uv run watch-skill evals run
```

Adaptive profiles aggregate lesson statistics per content type (screen
recordings vs talks vs …) and tune retrieval accordingly — data, not
code:

```bash
uv run watch-skill profiles show
uv run watch-skill profiles reset          # drop profiles; lessons stay
```

The meter:

```bash
uv run watch-skill stats
```

## Expected output shape

`lessons add` returns the lesson plus, for re-askable classes, the
immediate validation outcome:

```json
{
  "lesson_id": 7,
  "error_class": "missed-ocr",
  "content_type": "screen_recording",
  "guidance": "Read the on-screen text carefully — the code SAVE20 appears on screen at 1:45. (applies to screen_recording videos)",
  "validated": true,
  "reasked": true,
  "reask_confidence": 0.81,
  "matched_terms": ["save20", "code"]
}
```

`stats`:

```
answers served : 9
tokens saved   : ~86,647 vs raw-frame injection
```

(That savings figure is a real lifetime counter from this project's dev
machine.) A runnable end-to-end version is
[examples/07-lessons-and-stats](../../examples/07-lessons-and-stats).

## Notes and sharp edges

- Lessons are injected by semantic similarity (multilingual embeddings),
  so a lesson learned on one video helps similar questions on others.
- Only mechanical error classes are re-asked for validation; judgment
  errors still store a lesson but show `validated: false` until an eval
  run proves them.
- The semantic answer cache is honest about staleness: re-watching a
  video invalidates its cached answers; `--no-cache` on `ask` bypasses
  the cache for one call.
- Everything lives in `~/.watch-skill/` (lessons and cache tables in the
  index database) — deleting a lesson never touches the video index.
