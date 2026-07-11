# Pack: learning and research

A playlist is a syllabus nobody can query — until it is one library.

## The recipe

```powershell
watch-skill batch "https://www.youtube.com/playlist?list=..." --limit 12
```

Every video lands in the same persistent index; each one distills into
notes (entities, claims, chapters) automatically. Then study by asking:

```powershell
watch-skill library ask "what do the lectures disagree on about caching strategies?"
watch-skill library ask "which video derives the formula, and which just states it?"
```

Answers synthesize across the whole set with per-video timestamp
citations — [lecture 3 @ 12:40] — and refuse honestly when the library
does not clearly know. Locating (not synthesizing) stays with plain
search:

```powershell
watch-skill search "eviction policy"
watch-skill ask <video_id> "walk me through the LRU example"
```

`watch-skill library overview` shows what the library knows so far —
including the entities that recur across multiple videos, which is a
decent map of the topic's load-bearing concepts.

## Notes

- Works transcript-only for lecture content (`--transcript-only` per
  video is fastest); frames + OCR add slides and whiteboards.
- Everything is local and persistent: the library you build this
  semester still answers next semester.

Live example: [`examples/12-library-memory/`](../../examples/12-library-memory/)
(a cross-video question answered with citations from four clips).
