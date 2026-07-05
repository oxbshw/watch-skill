# Guide: analyzing a YouTube video

## What this does

Turn any YouTube URL (or any of yt-dlp's 1800+ supported sites) into a
persistent, queryable index: scene-aware deduplicated frames, on-screen
text, and a timestamped transcript. Analyze once; every follow-up question
answers in seconds without re-downloading.

## Prerequisites

- Watch Skill installed, `watch-skill doctor` green
  ([getting started](../getting-started.md)).
- The doctor bootstraps `deno` automatically — without a JS runtime,
  YouTube throttles downloads to a crawl (an observed 100 MB video took
  30+ minutes without it).
- No API keys required.

## Commands

Full watch (downloads at ≤720p, extracts frames, OCRs, grabs captions —
falling back to local Whisper when there are none — and indexes):

```bash
uv run watch-skill watch "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

Zoom into one section with a denser frame budget (focused mode):

```bash
uv run watch-skill watch "https://youtu.be/aqz-KE-bpKQ" --start 1:00 --end 1:30
```

Transcript only — the fastest way to “read” a talk or interview:

```bash
uv run watch-skill watch "https://youtu.be/..." --transcript-only
```

Then ask, forever:

```bash
uv run watch-skill ask <video_id> "when exactly does the demo crash?"
uv run watch-skill ask <video_id> "what is on the slide at 2:30?"
```

From an MCP agent (Claude Code, Cursor, …) the same flow is: say *"watch
this video: `<url>` — what happens at 0:10?"* → the agent calls
[`watch_video`](../tools/README.md#watch_video) once, then
[`ask_video`](../tools/README.md#ask_video) for every follow-up.

**Long videos / strict client timeouts:** MCP callers pass
`background=true` to `watch_video` for an instant `job_id`, then poll
[`get_status`](../tools/README.md#get_status) every few seconds.

## Expected output shape

`watch` prints the index line first, then a Markdown report:

```
> **Indexed:** video_id `4b0f48e4f4ae6e02` — follow up with `watch-skill ask 4b0f48e4f4ae6e02 ...`

# Watch report: Me at the zoo
- duration 0:19 · 640x480 · transcript: captions
...
## Transcript
- [00:01] All right, so here we are, in front of the elephants
...
## Frames
- t=00:00 `~/.watch-skill/frames/4b0f48e4f4ae6e02/frame_000.jpg`
...
```

`ask` prints the answer, then metadata:

```
He says the elephants have really, really, really long trunks.

Evidence:
- [00:08] (segment) really really long trunks
...
(confidence: 0.87 | verified: true)
~7,900 tokens saved vs raw-frame injection
```

## Notes

- **The download cache is content-addressed** (`~/.watch-skill/cache`,
  20 GiB LRU cap): re-watching the same URL — for example with a different
  `--start/--end` window — skips the download.
- **Extractor breakage self-heals.** When YouTube changes something and
  yt-dlp fails with a known breakage signature, Watch Skill updates yt-dlp
  and retries once, automatically. `doctor` also updates any yt-dlp older
  than 14 days.
- **Captions are fetched in the original language** — auto-translated
  tracks are not silently substituted (see the
  [Arabic guide](arabic-in-arabic-out.md)).
- **Privacy invariant:** no cookies, no logins. Region-locked or
  login-walled videos fail with `acquire.chain_exhausted` rather than
  bypassing the wall.
