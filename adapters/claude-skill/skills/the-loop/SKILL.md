---
name: the-loop
version: "0.7.0"
description: The user built or changed something visual — a UI, an animation, a game, a generated video — and wants it verified, or asks "why does my UI look wrong", "check that the fix actually worked", "does the animation glitch". Use this to record the running thing, critique the recording against plain-language pass criteria, and iterate until it passes with before/after proof.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# THE LOOP

A screenshot shows a moment; it cannot show a flow. THE LOOP records the
actual running target, watches the recording, and judges it against pass
criteria you state in plain language. The loop only observes — YOU apply
the fixes, then iterate. On pass it renders a before/after MP4 + GIF as
proof.

## UI / web page / desktop window

```bash
watch-skill loop start "<url | screen: | window:<title> | file>" "<pass criteria>" [--script '<json steps>']
# ...apply the suggested fixes to the code...
watch-skill loop iterate <loop_id>
```

- Pass criteria are ordinary sentences: "the checkout completes, no
  error toast ever appears, the total is never NaN". Negative claims
  ("never X") and exemplars ("a real price (like $29.00)") are both
  understood and enforced deterministically.
- `--script` replays the same clicks/fills every iteration, so the
  comparison is honest.
- Only call `iterate` after you actually changed something. It diffs
  against the previous iteration: fixed / unchanged / new.

## Generated video (Manim, Remotion, ffmpeg, AI-gen)

```bash
watch-skill loop video-gen --spec "<what the video must show>" --cmd "<render command>" --output <file>
```

Re-runs the generator each iteration and judges the fresh render against
the spec.

## Game / simulation

```bash
watch-skill loop game "<canvas-url | window:<title> | screen:>" "<pass criteria>" [--run-cmd "<launch cmd>"]
```

Catches the failures screenshots miss: a NaN score counter, black
flicker frames, sprites that vanish mid-motion.

## Watch for a condition (monitoring)

```bash
watch-skill loop monitor "<folder | url | screen: | window:<title>>" "<condition>" [--interval 10] [--max-checks 10]
```

Bounded — it always terminates. Events land in `events.jsonl` under the
loop directory as structured records.

## Record without judging

```bash
watch-skill capture "<target>" [--duration 10]
```

Capture alone never critiques; it just records, analyzes, and indexes.
Use `loop start` when there are pass criteria.
