# 07 — Lessons and the savings meter

The self-improve loop, end to end: report a wrong video answer with its
correction, watch it become a classified lesson (with an immediate re-ask
where the error class is mechanical), then read the lifetime token-savings
meter. Everything is local — lessons live in `~/.watch-skill/`, nothing is
uploaded. Full background:
[docs/guides/lessons-and-savings.md](../../docs/guides/lessons-and-savings.md).

The script cleans its demo lesson up afterwards, so your real lessons
store is untouched. Needs at least one indexed video (run example 01
first on a fresh machine); runs offline.

## Run

```
uv run --no-sync python examples/07-lessons-and-stats/lessons_and_stats.py
```

## Example output

Real run on this machine (against the Arabic video from example 05 — the
newest index entry):

```
using indexed video: d02c3e2e589f4253 — ماهي البرمجة وكيف تتعلمها : تعلم البرمجة للمبتدئين من الصفر ١

--- report_mistake outcome ---
{
  "lesson_id": 5,
  "error_class": "missed-ocr",
  "content_type": "talking-head",
  "guidance": "Read the on-screen text carefully — the on-screen text shows the title ماهي البرمجة وكيف تتعلمها : تعلم البرمجة للمبتدئين من الصفر ١. (applies to talking-head videos)",
  "validated": false,
  "reasked": true,
  "reask_confidence": 0.102,
  "matched_terms": ["text", "screen", "the"]
}

--- the lesson in the store ---
#5 [stored] missed-ocr (talking-head): Read the on-screen text carefully — ...

(demo lesson cleaned up: removed 1)

--- lifetime savings meter ---
answers served : 22
tokens saved   : ~144,288 vs raw-frame injection
```

Things to notice:

- The error class was **classified** from the correction's phrasing
  ("on-screen text" → `missed-ocr`), and guidance was derived per content
  type — data the answer engine injects into future similar questions.
- `missed-ocr` is mechanical enough for an immediate **re-ask**: the
  engine re-answered the question with the fresh lesson applied (the
  escalation ladder ran dense re-sampling + zoom-crop re-OCR). Here the
  correction's key terms did not surface in the evidence, so the lesson
  honestly stays `validated: false` until an eval run proves it.
- The savings meter is a real lifetime counter
  (`watch-skill stats` shows the same numbers).

Measure the learning over time:

```
uv run --no-sync watch-skill lessons export-evals
uv run --no-sync watch-skill evals run          # pass rate rising = it learns
```
