# AgentVision — video input for this agent

Copy this file (or its relevant section) into a project's `AGENTS.md` /
`.cursorrules` / rules file to teach any coding agent to use AgentVision.
Everything is a plain CLI call — no harness-specific features required.

## What it gives you

You cannot see videos. The `agentvision` CLI can: it downloads any source
(1800+ sites via yt-dlp, direct URLs, HLS/DASH streams, local files), extracts
scene-aware deduplicated frames, OCRs them, transcribes audio (platform
captions first, then LOCAL whisper — works offline), and indexes everything in
a persistent, searchable store.

## Rules

1. **Preflight once per session:** run `agentvision doctor --json`. Exit 0 →
   proceed silently. Otherwise follow each check's `fix` field; the doctor
   auto-installs ffmpeg/yt-dlp into a managed bin dir.
2. **First look at a video:** `agentvision watch "<source>" [--start T --end T]`.
   Read the frame image paths it prints. The report includes a `video_id`.
3. **Follow-up questions:** NEVER re-watch. Use
   `agentvision ask <video_id> "<question>"` — retrieval-based, returns
   timestamped evidence + the few relevant frame paths.
4. **Cross-video questions:** `agentvision search "<phrase>"`.
5. **Zooming in:** `agentvision watch` with `--start/--end` samples that
   window densely (up to 2 fps).
6. **Verifying your own UI/visual work (THE LOOP):**
   `agentvision loop start "<url|screen:|window:<title>|file>" "<pass criteria>"`
   → returns structured issues with suggested fixes. Apply fixes in code, then
   `agentvision loop iterate <loop_id>` until it passes. The loop never edits
   code — you do.
7. **Recording without critique:** `agentvision capture "<target>" --duration 10`.

## Error handling

Every error is structured JSON: `{error, message, fix, details}`. Act on
`fix` — it is written for you. `acquire.*` failures already exhausted the
fallback chain (yt-dlp → auto-update → cobalt → direct ffmpeg), so do not
retry the same command verbatim.

## Privacy invariants (do not work around these)

- The video file never leaves the machine.
- Only extracted mono audio may go to cloud STT, and only with `--cloud-stt`.
- No cookies or logins are ever used.

## Machine-to-machine surfaces

- MCP server: `agentvision serve` (stdio) or `agentvision serve --http`
  (streamable HTTP on :8747) — tools: watch_video, ask_video, get_moment,
  search_videos, capture, loop_start, loop_iterate, loop_status, list_videos,
  doctor.
- REST API: `agentvision api` (OpenAPI spec at `http://127.0.0.1:8748/openapi.json`).
- Python: `from agentvision.watch import watch`.
