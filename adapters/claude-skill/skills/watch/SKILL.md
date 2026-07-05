---
name: watch
version: "0.6.0"
description: Watch any video (URL, stream, or local path) via AgentVision. Downloads, extracts scene-aware deduped frames, OCRs them, transcribes (captions first, then local Whisper — offline by default), indexes everything, and hands the result to the agent. Follow-up questions are answered from the persistent index without re-processing.
argument-hint: "<video-url-or-path> [question]"
allowed-tools: Bash, Read, AskUserQuestion
license: MIT
user-invocable: true
---

# /watch (AgentVision)

You don't have a video input; this skill gives you one. It is a thin wrapper
around the `agentvision` CLI — all logic lives in the engine, so this skill
works identically on every harness (Claude Code, Codex, Cursor, ...).

This is a drop-in upgrade of the classic claude-video `/watch` skill:
same invocation shape, plus a persistent index (`ask` answers follow-ups
without re-processing), OCR on frames, scene-aware sampling with perceptual
dedup, local Whisper (offline by default, no API key needed), and THE LOOP
(capture -> critique -> fix -> re-capture) for iterating on your own output.

## Step 0 — Preflight (first invocation per session)

```bash
agentvision doctor --json
```

- Exit 0 → proceed silently. Do NOT announce that setup is fine.
- Non-zero → the JSON lists each failing check with a `fix`. `doctor`
  auto-bootstraps ffmpeg and yt-dlp into a managed bin dir on Windows/macOS/
  Linux; re-run once after it reports fixes. Only involve the user when a
  check still fails after remediation.
- If `agentvision` itself is not on PATH: `pip install agentvision` (or
  `uv tool install agentvision`), then re-run the doctor.

No API key is ever required: transcription falls back to LOCAL faster-whisper.
Cloud STT is opt-in (`--cloud-stt`) and only ever uploads extracted mono
audio — the video file never leaves the machine.

## Step 1 — Watch

Parse the user input into source + optional question, then:

```bash
agentvision watch "<source>" [--start T --end T] [--max-frames N] [--transcript-only]
```

- Any yt-dlp-supported site (1800+), direct media URLs, HLS/DASH manifests
  (`--duration 60` bounds live streams), and local files all work.
- `--start` / `--end` (`SS`, `MM:SS`, `HH:MM:SS`) switch to dense focused
  sampling of that window — use for "what happens at 2:30?" questions and for
  any video over ~10 minutes when the user cares about one section.
- `--timestamps T1,T2,...` pins frames at transcript-flagged moments
  ("look here", "as you can see") that visual selection may miss.
- `--transcript-only` skips frames entirely (fastest; no video download when
  captions exist).
- `--max-frames N` tightens the token budget (default: duration-tiered,
  hard cap 100, max 2 fps).

The report prints an `Indexed: video_id ...` line, frames with `t=MM:SS`
timestamps, OCR text, and the transcript.

## Step 2 — Read the frames

Read every frame path the report lists, in a single message (parallel Read
calls), so you see them together in chronological order.

## Step 3 — Answer

Answer from frames + OCR + transcript, citing timestamps. No question →
summarize structure, key moments, notable visuals, spoken content.

## Follow-ups — use the index, not re-processing

The video is already indexed. For any follow-up question in this or a LATER
session:

```bash
agentvision ask <video_id> "<question>"      # self-healing answer + evidence
agentvision search "<phrase>"                 # across every video ever watched
```

`ask` (v0.6) answers text-first with timestamped evidence, a confidence
score, and a `~N tokens saved` line. It escalates on its own when unsure
(dense re-sampling, zoom-crop re-OCR) and states plainly when the video
does not clearly show the answer — trust that refusal; do NOT invent an
answer past it. Frame paths are listed only when the engine wants you to
look yourself (or pass `--frames`); Read them then. Never re-run `watch`
for a follow-up on an already-indexed video.

If the user corrects one of your video answers, report it so the system
learns (locally):

```bash
agentvision lessons add <video_id> "<question>" "<your wrong answer>" "<the correction>"
```

## THE LOOP — iterate on your own output

When the user asks you to fix UI/visual output and verify the fix:

```bash
agentvision loop start "<url-or-screen:-or-file>" "<pass criteria>" [--script '<json steps>']
# ... you apply the suggested fixes ...
agentvision loop iterate <loop_id>
```

The critique returns structured issues with timestamps and suggested fixes.
YOU change the code; the loop only observes. On pass it renders a
before/after MP4+GIF proof. `agentvision capture "<target>"` records without
critiquing.

## Security posture

- The video file itself NEVER leaves the machine. Only extracted mono-16kHz
  audio may go to a cloud STT API, and only with explicit `--cloud-stt`.
- No cookies, no logins — only public data is requested.
- API keys live in env vars / `.env`; they are never logged or echoed.
- Downloads are cached under `~/.agentvision/cache` (LRU, size-capped).
