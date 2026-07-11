# Watch Skill — video input for this agent

Copy this file (or its relevant section) into a project's `AGENTS.md` /
`.cursorrules` / rules file to teach any coding agent to use Watch Skill.
Everything is a plain CLI call — no harness-specific features required.

This file IS the integration for agents without an MCP client or plugin
format — Pi, Hermes Agent, aider-style tools, homegrown harnesses: if it
reads repo instructions and can run a shell command, this is the whole
setup. Agents with richer surfaces have native configs in
[`docs/agents/`](../../docs/agents/README.md); agents with a skills
directory can load
[`adapters/claude-skill/skills/`](../claude-skill/skills/) directly.

## What it gives you

You cannot see videos. The `watch-skill` CLI can: it downloads any source
(1800+ sites via yt-dlp, direct URLs, HLS/DASH streams, local files), extracts
scene-aware deduplicated frames, OCRs them, transcribes audio (platform
captions first, then LOCAL whisper — works offline), and indexes everything in
a persistent, searchable store.

## Rules

1. **Preflight once per session:** run `watch-skill doctor --json`. Exit 0 →
   proceed silently. Otherwise follow each check's `fix` field; the doctor
   auto-installs ffmpeg/yt-dlp into a managed bin dir.
2. **First look at a video:** `watch-skill watch "<source>" [--start T --end T]`.
   Read the frame image paths it prints. The report includes a `video_id`.
3. **Follow-up questions:** NEVER re-watch. Use
   `watch-skill ask <video_id> "<question>"` — a self-healing answer with
   timestamped evidence and a confidence score; it escalates on its own when
   unsure and says plainly when the video does not clearly show the answer.
   Trust that refusal — never invent an answer past it. Frame paths appear
   only when it wants you to look yourself.
3b. **The user corrected your video answer?** Report it so the system
   learns locally: `watch-skill lessons add <video_id> "<question>"
   "<wrong answer>" "<correction>"`.
4. **Cross-video questions:** `watch-skill search "<phrase>"`.
5. **Zooming in:** `watch-skill watch` with `--start/--end` samples that
   window densely (up to 2 fps).
6. **Verifying your own UI/visual work (THE LOOP):**
   `watch-skill loop start "<url|screen:|window:<title>|file>" "<pass criteria>"`
   → returns structured issues with suggested fixes. Apply fixes in code, then
   `watch-skill loop iterate <loop_id>` until it passes. The loop never edits
   code — you do.
7. **Recording without critique:** `watch-skill capture "<target>" --duration 10`.
8. **Structure from an indexed video:** `watch-skill extract chapters <video>`
   (titled chapters), `watch-skill extract bug-report <video>` (where the
   error appears: timestamp + frame + OCR text), `watch-skill extract hook
   <video>` (opening-seconds score for creators).
9. **Many videos at once:** `watch-skill batch "<playlist-or-folder>"` —
   one persistent index for the whole set; then `search`/`ask` span it.
10. **Hand-off:** `watch-skill viewer <video>` renders a single offline
    HTML page — frames, transcript, every cached answer with evidence.

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

- MCP server: `watch-skill serve` (stdio) or `watch-skill serve --http`
  (streamable HTTP on :8747) — 21 tools; the full reference is
  [`docs/tools/README.md`](../../docs/tools/README.md).
- REST API: `watch-skill api` (OpenAPI spec at `http://127.0.0.1:8748/openapi.json`).
- Python: `from watch_skill.watch import watch`.
