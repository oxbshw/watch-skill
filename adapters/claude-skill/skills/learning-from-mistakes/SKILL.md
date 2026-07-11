---
name: learning-from-mistakes
version: "1.0.0"
description: The user corrected an answer about a video — "no, it actually says X", "that's the wrong timestamp", "you misread the error code" — or asks why a video answer was wrong. Use this to record the correction as a lesson so future answers on similar questions improve, and to show what the system has learned and saved.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Learning from mistakes

When a video answer turns out wrong, the correction is worth more than
an apology. Report it and Watch Skill learns locally — the mistake is
classified, stored as a lesson, injected into future similar questions,
and where possible the original question is immediately re-asked to
confirm the lesson actually fixes it.

## Report a correction

The moment the user corrects a video answer, run:

```bash
watch-skill lessons add <video_id> "<question>" "<the wrong answer>" "<the correction>"
```

The output includes the lesson (`error_class`, `guidance`) and, when the
question was re-asked, whether the corrected answer now comes back —
tell the user which it was. Nothing is uploaded; lessons live in
`~/.watch-skill/`.

## See what has been learned

```bash
watch-skill lessons list
```

## The savings meter

```bash
watch-skill stats
```

Lifetime token economics: what text-first answering and the semantic
cache have saved versus stuffing raw frames into context. Quote real
numbers from it when the user asks whether any of this is worth it.
