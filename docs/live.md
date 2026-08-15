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
video (ffmpeg -re) ─┬─ fast_vision  (bounded, drop-oldest) → scene changes
                    ├─ ocr          (bounded, drop-oldest) → text changes
                    └─ persist      (bounded, blocking)    → rolling buffer

audio (ffmpeg -re) ─┬─ assemble     (bounded, BLOCKING)    → overlapping utterances
                    └─ transcribe   (bounded, BLOCKING)    → speech events
```

Audio and video share nothing but the session clock and the event log —
separate ffmpeg processes, separate queues, separate threads. Vision falling
behind cannot cost a syllable.

Three properties this shape exists to guarantee:

**A slow detector degrades only itself.** The first OCR call loads models and
can take tens of seconds. When it shared a stage with perceptual hashing, no
scene change was reported until OCR had finished warming up — the live view
was blind for as long as its slowest detector took to start. They are separate
stages so that cannot happen.

**Audio is never dropped to relieve pressure.** The video stages shed frames
when they fall behind, because a frame from four seconds ago has been
superseded. The audio stages *block* instead: speech is continuous and
unrepeatable, and a queue that sheds audio to keep up is a queue that loses
words. Anything the capture genuinely missed is recorded as a `capture_gap`
event, because a transcript with an unmarked hole invites the reader to
conclude nobody spoke — a different claim from "we were not listening".

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

## Hearing as well as seeing

A live session captures audio through its own ffmpeg process, normalizes it to
mono 16 kHz signed 16-bit PCM at the boundary, and assembles it into short
**overlapping** utterances before transcription.

The overlap is not incidental. Cutting audio into adjacent blocks and
transcribing each independently reliably loses the word sitting on the seam;
carrying half a second of the previous block into the next is what stops
"checkout total" becoming "…total".

Silence is gated arithmetically — a mean-amplitude check — rather than by a
VAD model, because this runs on every utterance and the expensive thing it is
protecting against is exactly the model we would have to load to make the
decision.

### Backends

| Backend | What it does | When it runs |
|---|---|---|
| `faster-whisper` | Real recognition, locally | The default when the `transcribe` extra is installed |
| `deterministic-fixture` | Returns text from a fixture manifest | Only when constructed explicitly, by tests |

The fixture backend exists to test the *transport* — chunking, timestamps,
event shape, finalisation — on machines without the model. It recognises
nothing, it names itself in every event it produces, and a test using it
proves nothing about recognition quality.

Real recognition has its own opt-in gate against a locally synthesized speech
fixture with a known transcript, measuring word error rate with its
normalization stated. See [testing.md](testing.md). Measured on this machine
with `faster-whisper tiny (int8, cpu)`: **WER 0.0 over 20 reference words,
0.27x realtime** — on clean synthetic speech, which is an easier problem than
a real recording and is reported as such.

Whisper is wrapped in a streaming adapter over bounded spans. It is not a
streaming model, and whole-file transcription relabelled as real-time would be
the same dishonesty as batch processing called live.

### When there is no audio

`detectors.asr` always says which of these is true, because silence with no
explanation is indistinguishable from a room where nobody spoke:

| `reason` | Meaning |
|---|---|
| `no_audio_track_in_source` | The media has no audio stream |
| `audio_disabled_for_this_session` | Started with `audio=false` |
| `model_unavailable` | No local ASR installed |
| A failure message | ASR broke mid-session; visual detectors continue |

Live ASR is local-only in this build. A configured cloud key is not consent
and does not change that — the boundary asks the execution policy, so if a
cloud backend is ever added, the policy is already what decides.

## Detector readiness

`get_live_status` reports each detector separately:

```json
{"detectors": {
  "scene_change": {"status": "ready"},
  "ocr": {"status": "initializing"},
  "asr": {"status": "degraded", "reason": "no_audio_track_in_source"}
}}
```

Models load through a lifecycle registry that makes loading **single-flight**:
a plain cache checked before a slow constructor is a race, not a cache — every
thread misses and every thread builds. The registry also releases idle models,
which is what the earlier end-to-end run needed: a parent process holding OCR
and embedding weights it had finished with, while a child trying to answer a
question was refused the allocation.

A failed model degrades only itself, is retried on a cooldown rather than at
the frame rate, and is announced once rather than on every frame.

## Fusing what was seen, read and heard

Three event streams are not understanding. A scene change at 7.0 s and the
words "the total is wrong" at 7.2 s are almost certainly the same happening,
and an agent that cannot join them has to guess.

```bash
watch-skill live timeline <session_id> --window 2
```

Also `fused_timeline` over MCP and `GET /v1/live/{id}/fused`.

Joining is **deterministic** — timestamp overlap, shared entities, declared
state transitions. No model runs. Correlation an operator cannot reproduce by
hand is correlation they cannot check, and this layer decides what gets cited.

### Observation and inference never share a sentence

This is the rule the whole layer exists to enforce:

```json
{"observation": "total changed from '$125.00' to 'NaN'; someone said \"the total is wrong\"",
 "inferences": [{"text": "total became a non-value, which usually means the calculation or fetch behind it failed",
                 "confidence": 0.74, "basis": "rule:broken_value"}]}
```

`observation` contains only what a stream actually recorded. `inferences` are
what it might mean, each scored and attributed to the rule that produced it —
so a wrong conclusion is traceable, and "the coupon calculation failed" is
never quotable as though a camera had recorded it.

The rules are pattern matches, not judgements: a value becoming `NaN` /
`undefined` / `[object Object]`, a number vanishing, an error word or HTTP
status appearing, speech sharing vocabulary with what is on screen. Each is
cheap, explainable, and individually disableable.

### Entities

Entity tracks record when something appeared, when it was last seen, and
whether it is still present. Confidence **decays** with staleness — an entity
last seen thirty seconds ago is not evidence about now, and letting its
confidence stay at 1.0 would let stale state answer a question about the
present.

Disappearances are marked absent rather than deleted, so "did the checkout
total vanish?" stays answerable after the fact.

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

## Two clocks, and one session clock

Every event carries both, kept deliberately apart:

- `media_ts` — seconds into the source. What a citation means, and what
  survives finalisation into the index.
- `wall_ts` — Unix time. What a human reads, and what correlates with an
  agent's own logs.

Ordering internally uses a monotonic clock that is never displayed or
persisted, because it is meaningless across processes and using it for either
of the above breaks event ordering the moment the system clock steps.

Audio and video come from *independent* ffmpeg processes, each counting its
own bytes. Their media clocks drift, and neither knows the other exists. The
session clock is the shared reference that makes them comparable:

```json
{"clock": {
  "streams": {
    "video": {"samples": 28, "last_media_ts": 13.5, "lag_seconds": 0.4,
              "discontinuities": 0, "gap_seconds": 0.0},
    "audio": {"samples": 14, "last_media_ts": 13.2, "gap_seconds": 0.0}
  },
  "av_drift_seconds": 0.3,
  "in_sync": true
}}
```

Three things it deliberately does not do:

- **It does not rewrite timestamps.** A media timestamp is what the source
  said; silently correcting it would make a citation point at something the
  viewer will not find there.
- **It does not report zero drift for a missing stream.** A video with no
  audio track gives `av_drift_seconds: null` — an absent stream is not a
  synchronisation, and claiming it is would be a measurement nobody made.
- **It does not average a reconnect into the drift.** A stream whose timeline
  jumps backwards has *reset*, not drifted; that is a separate discontinuity
  event, and it is not counted as lost time the way a forward gap is.

### Asking what was visible when something was said

```bash
watch-skill live aligned <session_id> 7.4 --window 2
```

Also `aligned_evidence` over MCP and `GET /v1/live/{id}/aligned`. Give it the
media timestamp of a speech event; it returns everything every stream observed
within the window, grouped by stream, nearest first. Correlation is
deterministic timestamp overlap — nothing learned, nothing guessed — so the
ranking can be reproduced by hand.

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
