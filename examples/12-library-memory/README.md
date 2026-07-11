# 12 — Library memory: answers no single video holds

Four clips tell one incident story in pieces: the monitor feed shows
`ERROR 502`, the standup names the root cause, the tutorial shows the
config fix, the release clip confirms it shipped. No clip has the whole
answer. `library ask` does.

```powershell
uv run --no-sync python examples/12-library-memory/library_demo.py
```

What it does:

1. Builds the four clips (content lives in pixels — OCR carries it; a
   local vision backend adds scene descriptions when one is running).
2. `watch_batch` indexes the folder; note distillation runs per video,
   automatically.
3. `library_overview` — what the library now knows.
4. `library_synthesize("what caused the ERROR 502 and is it fixed?")` —
   then asks the SAME question again to show the cache path.

Real output from the reference machine (8 GB CPU-only Windows,
moondream via Ollama for scene descriptions, 2026-07-11), trimmed:

```
batch: 4/4 indexed
library overview: notes = {'chapter': 4, 'claim': 3, 'entity': 15}
entities recurring across videos: ['ERROR 502', ...]

Q (no single clip answers this): what caused the ERROR 502 and is it fixed?
Across 4 video(s), the library answers 'what caused the ERROR 502 and is it fixed?':

- ERROR 502  [monitor_feed.mp4 @ 0:00]
- ERROR 502 ROOT CAUSE  [standup_notes.mp4 @ 0:00]
- ERROR 502 RESOLVED  [release_update.mp4 @ 0:00]
- "Cache Config Fix Upstream Timout 30" (scene description)  [config_tutorial.mp4 @ 0:00]
...
(Corroborated: the same finding appears in more than one video.)

confidence: 0.566 | videos consulted: 4 | corroborated: True | cached: False
meter: 2 library syntheses, ~784 library tokens saved
  PASS  synthesis is not honest-floored
  PASS  2+ videos cited
  PASS  timestamps in the text
  PASS  repeat served from cache
  PASS  savings meter counts syntheses

LIBRARY DEMO: PASSED
```

Worth noticing in the real run: the vision model's scene descriptions
misread "502" as "522" on two frames — and the synthesis still cites the
right code, because OCR read the exact digits and both layers carry
provenance. Layered perception is not a slogan; it is why the answer
survives a sloppy eyewitness.

## Upgrading an older index

Videos watched before the notes layer have no notes yet (nothing is
reprocessed behind your back). One command distills them all:

```powershell
uv run --no-sync watch-skill library rebuild-notes
```

New watches distill automatically from now on.
