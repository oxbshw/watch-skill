# 01 — Watch and ask

Watch a short YouTube video, then ask it one question. This is the core
Watch Skill workflow: `watch` runs the full pipeline (download → scene-aware
frames → OCR → transcript → index), and `ask` answers from the persistent
index without re-processing.

Needs network for the first watch (download + captions). No cloud key
required — everything below ran in local-only mode.

## CLI (the primary way)

```
uv run --no-sync watch-skill watch "https://www.youtube.com/watch?v=jNQXAC9IVRw"
uv run --no-sync watch-skill ask 4b0f48e4f4ae6e02 "What does the narrator say about the elephants?"
```

The `watch` report ends with the `video_id` to use with `ask`. Re-watching
the same URL is nearly free: acquisition is cached under `~/.watch-skill/`.

## Python equivalent

```
uv run --no-sync python examples/01-watch-and-ask/watch_and_ask.py
```

Pass a different URL as the first argument to watch something else.

## Example output

`watch` (trimmed — real run on this machine, acquisition served from cache):

```
# watch-skill: video report

- **Source:** https://www.youtube.com/watch?v=jNQXAC9IVRw
- **Title:** Me at the zoo
- **Uploader:** jawed
- **Duration:** 00:19 (19.0s)
- **Acquired via:** cache (cache)

## Frames

- **Selection:** 6 kept from 6 candidates (uniform engine, 0 scenes, 0 near-duplicates dropped)

## Transcript

_Source: captions._

[00:01] All right, so here we are, in front of the elephants
[00:05] the cool thing about these guys is that they have really...
[00:07] really really long trunks
[00:12] and that's cool
[00:14] (baaaaaaaaaaahhh!!)
[00:16] and that's pretty much all there is to say
```

`ask` (real run, local-only mode — no vision model configured, so the
engine returns timestamped evidence instead of a synthesized answer and
says so plainly rather than guessing):

```
The video does not clearly show an answer to: 'What does the narrator say about the elephants?'.
No guess is being made. The closest indexed moments are:
- [00:01] (segment) All right, so here we are, in front of the elephants
- [00:05] (segment) the cool thing about these guys is that they have really...
- [00:17] (segment) and that's pretty much all there is to say
- [00:08] (segment) really really long trunks
- [00:14] (segment) (baaaaaaaaaaahhh!!)

(confidence: 0.34 | escalations: dense_resample, zoom_crops_reocr)
~3248 tokens saved vs raw-frame injection
```

With a vision/LLM provider configured (any `WATCHSKILL_*` cloud key, or a
running Ollama with a vision model), the same command produces a verified
natural-language answer instead of the evidence list.

Next: use [02 — Focused moment](../02-focused-moment/) to inspect a narrow
window, or return to the [example catalog](../README.md).
