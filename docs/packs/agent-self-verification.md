# Pack: agent self-verification

An agent that generates UI, video, or a game has a blind spot the size
of its own output. THE LOOP is how it checks its work without a human
in the chair.

## The three loops

**UI / web** — the agent changed frontend code and must prove the fix:

```powershell
watch-skill loop start "http://localhost:3000" "the dashboard renders real numbers, never NaN, no overlapping labels"
# agent applies fixes, then:
watch-skill loop iterate <loop_id>
```

**Generated video** (Manim, Remotion, ffmpeg pipelines, AI generation) —
judge the render against the spec, re-render, repeat:

```powershell
watch-skill loop video-gen --spec "a blue square slides left to right, title 'Demo' visible throughout" --cmd "python render.py" --output out.mp4
```

**Game / simulation** — record gameplay, catch the failures screenshots
can't:

```powershell
watch-skill loop game "http://localhost:8080" "the SCORE counter always shows a number (like SCORE: 12), never NaN; no black flicker frames"
```

## The contract

- The loop OBSERVES; the agent edits. `loop_iterate` only after a real
  change — it diffs issues against the previous iteration
  (fixed / unchanged / new) and stops on pass, on `max_iterations`, or
  on no-progress.
- On pass it renders the before/after MP4 + GIF: the proof the agent
  attaches instead of the word "done".
- Criteria are plain language. "never X" bans a term on every frame
  deterministically; "(like $29.00)" turns an example into a shape
  check. Small local vision models judge through the describe-then-judge
  critic, so this works offline on modest hardware.

Live examples: [`examples/04-ui-loop/`](../../examples/04-ui-loop/) (the
NaN price catch), [`examples/08-loop-types/`](../../examples/08-loop-types/)
(video-gen and game runs with real outputs).
