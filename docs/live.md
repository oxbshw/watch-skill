# Live watching

Watch Skill can watch something **while it is happening** and tell an agent
what changed, when, and with what evidence — rather than reading a file to the
end and reporting afterwards.

That distinction is the whole feature, so it is worth being precise about it:

> A live session emits events **before the source has finished producing
> media**. The end-to-end test asserts exactly this — that the change was
> reported while the capture process was still running — because a pipeline
> that ingests everything and then reports would pass every other check while
> being batch processing with a different name.

## Quick start

```bash
watch-skill live start recording.mp4 --follow
```

`--follow` prints events as they arrive:

```text
    0.00s  session_started         live session started (file_replay, local-lite, 2 fps)
    0.00s  scene_change            first scene
    7.00s  scene_change            scene changed (phash distance 18)
    7.50s  visible_text_change     on-screen text appeared: error, 502
```

Then, from another shell or an agent:

```bash
watch-skill live ask <session_id> "what went wrong?" --scope session
watch-skill live status <session_id>
watch-skill live stop <session_id>
```

## Sources

| Kind | What it is | Status |
|---|---|---|
| `file_replay` | A local file paced at real time by `ffmpeg -re` | Implemented, machine-tested |
| `stream` | RTSP / RTMP / HLS / DASH — anything ffmpeg opens | Implemented; needs network egress |
| `browser`, `screen`, `window`, `camera`, `microphone`, `webrtc` | — | **Not implemented as live sources.** `capture_capabilities` reports them honestly |

A file replayed in real time is a *real* live source, not a shortcut: the
pipeline cannot tell it from a camera. It is also what makes the test suite
able to prove liveness deterministically, without hardware or a network.

Check before you attempt anything else:

```bash
watch-skill capture-capabilities
```

Every entry says how its answer was established — `machine_tested`, `probed`,
or `not_tested` — and nothing is reported `available` because a code path for
it exists. See [the capture matrix](capture-capabilities.md).

## How a session is built

```text
                    ┌─ fast_vision  (bounded, drop-oldest) → scene changes
capture (ffmpeg) ───┼─ ocr          (bounded, drop-oldest) → text changes
                    └─ persist      (bounded, blocking)    → rolling buffer
```

Three properties this shape exists to guarantee:

**A slow detector degrades only itself.** The first OCR call loads models and
can take tens of seconds. When it shared a stage with perceptual hashing, no
scene change was reported until OCR had finished warming up — the live view
was blind for as long as its slowest detector took to start. They are separate
stages so that cannot happen.

**Perception may skip; persistence may not.** The analysis stages take the
*newest* frame and count what they discarded, because catching up by analysing
four stale frames leaves the answer four frames behind. The persistence stage
drops nothing, because a frame that is not written cannot become evidence
later — and "later" is when most evidence is wanted.

**Every queue has a fixed bound.** Dropped frames are counted and reported in
`get_live_status`. A live view that silently skips is a live view you cannot
trust.

### No model runs per frame

Scene changes come from perceptual hashing; text changes come from local OCR
compared as token sets (so OCR jitter on a static screen does not fire an
event every frame). Both run on your machine and cost nothing.

Semantic interpretation happens later, on *selected* frames, driven by a
question. A live session that called an LLM once per frame would be
unaffordable within a minute and still slower than the video.

## The rolling buffer

A session retains a configurable recent window (`--buffer`, default 120 s).
When a detector fires, the media around that moment is **pinned** — three
seconds either side — which exempts it from eviction, because the cause of an
event is usually visible before the event itself.

Expired segments leave a row behind marked `expired`, so asking for evidence
that has aged out gets an honest "that has been evicted" rather than silence.

Evidence is addressed by `artifact_id`, never by path. Public tool output does
not contain your filesystem layout.

## Cursors

`observe_live` is cursor-addressed, and the cursor is a sequence number rather
than a timestamp:

```python
batch = observe_live(session_id)                     # from the beginning
batch = observe_live(session_id, cursor=batch["next_cursor"])   # only new
```

Repeating a cursor returns the same events, so a client that retries a dropped
response neither loses nor double-counts anything. A cursor belonging to a
*different* session is refused rather than silently reset — that usually means
two sessions got mixed up, and starting from zero would flood the caller with
events they already saw.

## Two clocks

Every event carries both, kept deliberately apart:

- `media_ts` — seconds into the source. What a citation means, and what
  survives finalisation into the index.
- `wall_ts` — Unix time. What a human reads, and what correlates with an
  agent's own logs.

Ordering internally uses a monotonic clock that is never displayed or
persisted, because it is meaningless across processes and using it for either
of the above breaks event ordering the moment the system clock steps.

## Finalising into permanent memory

```bash
watch-skill live stop <session_id>          # finalises by default
```

The session becomes an ordinary indexed video: `ask_video`, `search_videos`,
the viewer, all of it — **without reprocessing the media**. The frames and OCR
were already produced while it ran; finalising moves that work into the index
rather than repeating it.

Only pinned evidence is carried over, which is the point of a rolling buffer:
the moments a detector found interesting are kept, and the rest expires.

Finalising is idempotent, and refuses to run on a session that is still going
— indexing a moving target would produce a record of nothing in particular.

## Profiles

| Profile | Analysis queue | Overflow | For |
|---|---|---|---|
| `local-lite` (default) | 4 frames | drop oldest | Long sessions, modest machines |
| `local-realtime` | 8 frames | drop oldest | Denser sampling |
| `forensic` | 64 frames | **block** | Keep everything; a slower session is the price of a complete one |

All three run entirely locally. There is deliberately no cloud profile in the
default set: a profile that requires egress is opt-in configuration, not a
name you can reach by accident. `LiveBudget` permits zero egress frames and
zero dollars unless raised explicitly.

## What is not implemented

Named plainly, because a roadmap entry presented as a feature is worse than
an absent feature:

- **Live audio and streaming transcription.** `AudioChunk` is a defined
  contract; there is no audio capture stage yet, and `audio_chunks` /
  `audio_gap_seconds` are always zero. Speech events do not occur in a live
  session today.
- **Live triggers and the Observer Loop.** No trigger evaluation exists yet.
- **Browser/screen/window/camera live capture.** Recorded capture for these
  works (`capture`, `loop_start`); *live sessions* on them do not.
- **Semantic (model-driven) live perception.** Only local detectors run.
- **An interactive MCP App.** The fallback HTML viewer is what exists.
- **Session resume.** A live session whose process dies is marked stopped, not
  resumed — the media it was watching moved on, and pretending otherwise
  would be dishonest. Its events and buffer stay queryable and finalizable.

## Related

- [Capture capabilities](capture-capabilities.md)
- [Durable jobs](configuration.md#durable-background-jobs)
- [Architecture](architecture.md)
