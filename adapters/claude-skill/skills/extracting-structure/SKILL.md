---
name: extracting-structure
version: "0.7.0"
description: The user wants structure pulled out of a watched video — "make chapters for this video", "where does the bug appear in this recording", "turn this screen recording into a bug report", "how strong is my intro/hook". Use this for deterministic extraction from the index — chapters with timestamps, a fileable bug report with the exact frame, or a scored hook analysis.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Extracting structure

Three extractors turn an already-watched video into something structured.
All of them answer straight from the persistent index — deterministic, no
extra model calls. The video must be watched first (see `watching-videos`).

## Chapters

```bash
watch-skill extract chapters <video_id-or-source>
```

Titled chapters with start/end timestamps, built from scene changes plus
transcript topic shifts. Good for long tutorials, lectures, meetings —
give the user the chapter list with timestamps, not a prose summary.

## Bug report from a screen recording

```bash
watch-skill extract bug-report <video_id-or-source>
```

Pinpoints where an error appears: timestamp, the exact frame, the
on-screen error text as OCR read it, and the steps that led up to it
(from the transcript/actions preceding the failure). Returns
`found: false` honestly when no error signal exists — report that as
"no error found in the recording", not as an error.

Paste the output into the user's issue tracker format when they ask for
a fileable report; the frame path is the attachment.

## Hook analysis (creators)

```bash
watch-skill extract hook <video_id-or-source> [--seconds 15]
```

Scores the opening seconds on four measured axes — attention trigger in
the opening line, speech pacing, visual change rate, on-screen text —
each with an actionable critique, plus a 0–100 score and verdict. Give
the user the per-axis critiques; the number alone helps nobody.
