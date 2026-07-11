---
name: sharing-results
version: "1.0.0"
description: The user wants to share or hand off what was found in a video — "send this analysis to my team", "make a page I can share", "export the findings", "give me something I can attach to the ticket". Use this to render a self-contained offline HTML viewer page with the frames, transcript, and every cached answer with its evidence.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Sharing results

An analysis that lives only in this chat dies with it. The viewer turns
an analyzed video into a single HTML file anyone can open — no server,
no internet, no Watch Skill install on the other end.

## Generate the page

```bash
watch-skill viewer <video_id-or-source> [-o <path>]
```

The file contains, self-contained (frames inlined as data URIs, zero
external requests):

- a timeline with key-frame cards and timestamps,
- the transcript and all on-screen text (OCR),
- every question asked about the video so far, with its answer,
  confidence badge, and the exact timestamped evidence cited.

Answer questions FIRST, then generate. The page includes cached answers,
so ask what the user cares about before rendering — a viewer generated
before any questions holds only frames and transcript.

## Hand-off patterns

- Bug ticket: run `watch-skill extract bug-report` first, then the
  viewer — the ticket gets the structured report, the viewer link gives
  reviewers the evidence.
- Review request: send the file itself (it is one .html, typically well
  under a few hundred KB); it opens in any browser, RTL text renders
  correctly, nothing phones home.
