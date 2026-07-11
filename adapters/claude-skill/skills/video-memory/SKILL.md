---
name: video-memory
version: "0.7.0"
description: The user asks about videos watched in the past or across sessions — "have we watched anything about X", "which video showed that error", "what did that meeting decide", "search my videos", or a question that spans several videos. Use this to search and answer from the persistent cross-video index instead of saying you don't remember.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Video memory

Every video ever watched on this machine is still here — frames, OCR,
transcripts, and past answers, in one persistent index under
`~/.watch-skill/`. You never have to say "I don't remember that video."
Sessions don't expire it; watching more videos makes it more useful.

## What's in the library?

```bash
watch-skill list
```

Every indexed video: id, title, duration, when it was analyzed. Check
here before watching anything — it may already be in memory from a
previous session.

## Find something across all of it

```bash
watch-skill search "<phrase or keywords>"
```

Hybrid keyword + semantic search across every video, any language
(Arabic folding, CJK and Thai segmentation are handled). Hits come back
with video + timestamp; follow up on a hit with:

```bash
watch-skill ask <video_id> "<the user's actual question>"
watch-skill moment <video_id> <timestamp>
```

## Questions that span videos

"What did we decide about the pricing page across those meetings?" —
questions no single video answers go to the library synthesizer:

```bash
watch-skill library ask "<the question>"
```

It answers from distilled notes across every indexed video, drills into
real evidence, and cites video + timestamp for each finding. When it
says the library does not clearly answer, trust that — do not stitch a
guess together from weak search hits. `watch-skill library overview`
shows what the library knows (videos, note counts, entities recurring
across videos).

For "which video showed X" (locate, not synthesize), plain `search` is
the right tool; then `ask` the hit video.

## Batches build memory fast

A playlist or a folder of recordings goes in as one call —
`watch-skill batch "<playlist-or-folder>"` — and the whole set becomes
searchable memory (see `watching-videos`).
