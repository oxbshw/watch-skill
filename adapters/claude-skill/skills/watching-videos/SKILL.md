---
name: watching-videos
version: "1.0.0"
description: The user shared a video URL, a YouTube/TikTok/stream link, a local video file, a screen recording, a meeting recording, or a playlist/folder of videos — "watch this", "summarize this video", "what's in this recording". Use this to actually watch the video — download, extract frames, OCR, transcribe, and index it — instead of guessing from the title or asking the user to describe it.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Watching videos

You don't have a video input; this skill gives you one. Anything a user
hands you — a YouTube link, a TikTok, a lecture, a meeting recording, a
screen capture, an .mp4 on disk — goes through the same pipeline: frames
(scene-aware, deduplicated), OCR, transcript (captions first, local
Whisper offline fallback), all persisted into one index.

## Before watching: check the index

```bash
watch-skill list
```

If the video was already analyzed — this session or any earlier one —
do NOT watch it again. Ask it directly (see the `asking-with-evidence`
skill):

```bash
watch-skill ask <video_id> "<question>"
```

## One video

```bash
watch-skill watch "<url-or-path>" [--start T --end T] [--max-frames N] [--transcript-only]
```

- Works on any yt-dlp-supported site (1800+), direct media URLs, HLS/DASH
  manifests (`--duration 60` bounds live streams), and local files.
- Video over ~10 minutes and the user cares about one part → use
  `--start`/`--end` for dense sampling of that window.
- User only needs what was said → `--transcript-only` (fastest, often no
  video download at all).

The report prints `Indexed: <video_id>`, frames with `t=MM:SS`
timestamps, OCR text, and the transcript. Read every frame path listed —
in a single message, parallel Read calls — then answer from frames + OCR
+ transcript, citing timestamps.

## Many videos (playlist, channel, folder)

```bash
watch-skill batch "<playlist-url-or-folder>" [--limit N]
```

Everything lands in the same index; one broken video never stops the
rest. Afterwards a single `watch-skill search "<phrase>"` spans the whole
batch.

## First run on a machine

If any command fails with a dependency error, run `watch-skill doctor`
once — it installs missing ffmpeg/yt-dlp itself. No API key is required
for any of this; transcription is local by default and the video file
never leaves the machine.
