# 08 — Loop types (video-gen, game, monitor)

v0.7 generalizes THE LOOP into a pluggable framework: every loop shares the
same spine — produce a recording → perceive → critique against pass criteria
→ diff vs the previous iteration → iterate → before/after artifact — and a
*loop type* only decides how the recording is produced. `loop_start` /
`loop_iterate` are unchanged; the new types are new tools:

| Loop type | Producer | MCP tool | CLI |
|---|---|---|---|
| `ui` (v0.6) | record URL / `screen:` / `window:` | `loop_start` | `watch-skill loop start` |
| `video-gen` | run a generator command, adopt the video it writes | `loop_video_gen` | `watch-skill loop video-gen` |
| `game` | (optionally) launch a process, record its window/canvas | `loop_game` | `watch-skill loop game` |
| monitor | bounded watch over a folder/stream, emit events | `loop_monitor` | `watch-skill loop monitor` |

The monitor is not iterate-shaped: it samples a source until a described
condition appears, then emits a structured event (appended to `events.jsonl`
+ an `on_event` callback — the v0.8 webhook system plugs into that seam).

## Run

```
uv run --no-sync python examples/08-loop-types/video_gen_loop.py
uv run --no-sync python examples/08-loop-types/game_loop.py
uv run --no-sync python examples/08-loop-types/monitor_loop.py
```

## Example output (real runs on this machine, local moondream vision)

Video-gen loop — the generator renders the WRONG title; the "agent" fixes the
generator input; the regenerated render passes:

```
=== iteration 0: generate + watch the WRONG render ===
status: running  (iteration 0, score 35, verdict fail)
summary: Criteria not met (contains banned 'untitled'); frame shows: The image
features ... the words "untitled draft" written in white at the top ...

=== agent fixes the generator input ===

=== iteration 1: regenerate + verify ===
status: passed  (iteration 1, score 92, verdict pass)
vs previous iteration: 1 fixed, 0 unchanged, 0 new
before/after proof: ~\.watch-skill\loops\3e4c686137e3\artifacts\before_after.gif + .mp4
DEMO PASSED
```

Monitor loop — a healthy dashboard clip passes silently; the clip with the
error screen emits a structured event and the watch stops:

```
{
  "condition": "an error screen (like ERROR 502)",
  "checks_run": 2,
  "triggered": true,
  "events": [
    {
      "check": 1,
      "source": "...\\drop folder\\failed_deploy.mp4",
      "detections": [
        {"timestamp": 0.457, "severity": "critical",
         "description": "Criteria not met (contains banned 'ERROR 5082'); frame
          shows: The image features a bold, red error message ..."}
      ]
    }
  ],
  "events_path": "...\\loops\\monitor_0edbdce4bdb9\\events.jsonl"
}
DEMO PASSED
```

(Note the vision model misread "ERROR 502" as "ERROR 5082" — the detection
still fired because criteria exemplars are digit-generalized shape patterns.)

Game loop — the canvas game's score counter renders `NaN` (uninitialized
state); the loop records real gameplay, the critic reads the HUD, the fix is
verified:

```
=== iteration 0: record the GLITCHED game ===
status: running  (iteration 0, verdict fail)  — SCORE: NaN flagged

=== agent fixes the game state bug ===

=== iteration 1: re-record + verify ===
status: passed — diff reports the NaN issue FIXED
DEMO PASSED
```

## Notes

- All three demos use the real vision critic. On machines that can only fit a
  small captioning model (moondream), the critic automatically degrades from
  the JSON schema to describe-then-judge — deterministic banned-terms and
  exemplar shape patterns from your criteria, with a plain PASS/FAIL judgment
  only where no rule speaks. Phrase criteria with `never X` and `(like Y)`
  exemplars to get fully deterministic verdicts.
- `render_title_card.py` stands in for Manim/Remotion — any command that
  writes a video file works unchanged.
