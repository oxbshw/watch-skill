---
name: asking-with-evidence
version: "0.7.0"
description: The user asks a question about a video that was already watched or indexed — "what did they say about X", "what error code appears", "what happens at 2:30", "does the video show Y". Use this to answer from the persistent index with timestamped evidence and a confidence score instead of re-watching or guessing.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Asking with evidence

Every watched video sits in a persistent index. Questions about it are
answered from that index — text first, frames only when needed — with
timestamps, a confidence score, and an honest refusal when the video
does not show the answer. Never re-run a watch for a follow-up.

## Answer a question

```bash
watch-skill ask <video_id-or-original-url> "<question>"
```

Any language works; the answer comes back in the language of the
question. The engine escalates on its own when unsure (dense re-sampling,
zoom-crop re-OCR, stronger model) and prints a `~N tokens saved` line.

Three rules for reading the result:

- **Cite the timestamps** it gives you; they are real evidence, not
  decoration.
- **Trust the refusal.** When it says the video does not clearly show
  the answer, that is the answer. Do not invent one past it.
- Frame paths are listed only when the engine wants you to look
  yourself — Read them then (or force with `--frames`).

## "What happens at 2:30?"

Moment questions get a dense window, not a whole-video ask:

```bash
watch-skill moment <video_id> 2:30 [--window 10]
```

Returns frames + transcript + OCR around that timestamp.

## Don't know which video? Search them all

```bash
watch-skill search "<phrase>"
```

Hybrid keyword + semantic search across every video ever watched, with
per-script normalization (Arabic folding, CJK segmentation, Thai
segmentation). Follow a hit with `ask` or `moment` on that video.

## When the user corrects you

Report it so the next answer is better — see the
`learning-from-mistakes` skill.
