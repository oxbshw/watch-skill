# Troubleshooting

Symptom → cause → fix for the failures people actually hit. Two things to
try before anything below:

1. **`watch-skill doctor`** — it does not just diagnose, it self-heals:
   installs missing ffmpeg/yt-dlp/deno into the managed
   `~/.watch-skill/bin/`, updates a stale yt-dlp, and checks disk, GPU,
   and API keys. Most acquisition and dependency failures end here.
2. **Read the `fix` field.** Every structured error is
   `{error, message, fix, details}` — the `fix` names the exact setting,
   command, or tool to use next.

## Install & environment

**`uv sync` fails with `os error 32` (file in use) on Windows**
A running MCP server (your agent's session) holds a lock on
`.venv\Scripts\watch-skill.exe`. Close the agent or kill the process
(`taskkill /im watch-skill.exe /f`), then re-run. For tests and examples
you can skip syncing entirely: `uv run --no-sync ...`.

**`ffmpeg not found` even though you installed it**
Package managers (winget, brew) sometimes leave PATH stale in the shell
that launched your agent. Watch Skill prefers its own managed copy:
`watch-skill doctor` installs ffmpeg into `~/.watch-skill/bin/` and every
surface prepends that directory to PATH, so the managed copy wins
regardless of shell state.

**Arabic / CJK titles print as `?` in the terminal**
Legacy Windows code pages (cp1256 etc.) can't encode every character; the
CLI degrades unprintable characters instead of crashing. The index itself
is always full-fidelity UTF-8 — MCP and REST output is unaffected. For a
correct display, use Windows Terminal or `chcp 65001`.

**The MCP server doesn't show up in your agent**
Run `watch-skill setup` — it detects installed agents and writes the MCP
config (backing up existing files), then restart the agent. Manual
per-agent configs: [agents/README.md](agents/README.md).

## Acquisition (`acquire.*` errors)

**A YouTube/TikTok/... download suddenly fails that worked last week**
Extractor breakage — sites change, yt-dlp chases them. Watch Skill
detects the signature, self-updates yt-dlp, and retries once
automatically; if it still fails, run `watch-skill doctor` (updates
yt-dlp explicitly) and retry. Persistent failures fall through the chain:
yt-dlp → cobalt (only if `WATCHSKILL_COBALT_API_URL` is set) → direct
ffmpeg pull; the error's `details` show what each rung said.

**A live stream watch never finishes**
Bound it: `watch-skill watch <url> --duration 60` caps the capture at N
seconds (MCP: pass `start`/`end` or `budget`).

**Same URL keeps re-downloading / you need a fresh copy**
Downloads land in a content-addressed LRU cache under `~/.watch-skill/`.
Re-watching is nearly free; to force a fresh download (e.g. after fixing
caption languages), use `--no-cache`.

## Answers & transcription

**`ask` returns an evidence list saying the video "does not clearly show"
the answer**
Not a bug — the honest floor. Without a vision/LLM provider the engine
returns timestamped evidence instead of synthesizing an answer it can't
verify. Configure any `WATCHSKILL_*` cloud key or run Ollama with a
vision model to get natural-language verified answers; the evidence-list
mode remains the fallback whenever confidence stays low.

**The transcript is an English translation of a non-English video**
An old index entry from before original-language captions were preferred,
or the cached download only has English tracks. Re-watch with
`watch-skill watch <url> --no-cache`; for extra caption tracks set
`WATCHSKILL_SUBTITLE_LANGS` (see the
[Arabic guide](guides/arabic-in-arabic-out.md)).

**First transcription of a captionless video is very slow**
That's the local whisper model downloading, once. Captions are always
tried first. For text-only speed: `--transcript-only`; to pin a smaller
model: `--whisper-model tiny`. Cloud STT is strictly opt-in
(`--cloud-stt`).

**A wrong answer keeps coming back**
Two separate mechanisms: (1) `--no-cache` on `ask` bypasses the semantic
answer cache for one call, `watch-skill clean --cache-answers` clears it;
(2) report the mistake (`report_mistake` tool or `watch-skill lessons
add`) so the correction becomes a lesson applied to future questions —
see the [lessons guide](guides/lessons-and-savings.md).

## Capture & THE LOOP (`loop.*` errors)

**`capture`/`loop_start` on a URL fails to find a browser**
The headless capture needs Chromium-family: Edge or Chrome installed, or
`playwright install chromium`. `screen:` and `window:<title>` capture
don't need a browser at all.

**The loop critique seems shallow (misses layout issues)**
No vision provider reachable, so the deterministic OCR critic was
selected (the loop machinery is identical). Configure a vision provider
for the strong-tier critic; the critic line at loop start tells you which
one is active.

**`window:<title>` capture finds nothing**
The title must match exactly (it's a live window enumeration). Check the
window's real title bar text, including suffixes like `- Notepad`.

## Index (`index.*` errors)

**`index.video_not_found` / `unknown video`**
The id or source isn't in the index — `watch-skill list` (MCP:
`list_videos`) shows what is. Sources match by the original URL/path
exactly as first watched.

**Disk usage keeps growing**
Bounded, but reclaimable: `watch-skill clean --all` (cache to its size
cap + old loops + orphaned frame dirs), `--dry-run` first to see what
would go.

## REST API

**`config.public_bind_no_token` on startup**
Deliberate: the API refuses to bind non-loopback hosts without auth. Set
`WATCHSKILL_API_BEARER_TOKEN` (clients send `Authorization: Bearer
<token>`), or keep it on `127.0.0.1`.

## Still stuck?

`watch-skill doctor --json` prints a machine-readable report of every
check — attach it to a
[GitHub issue](https://github.com/oxbshw/watch-skill/issues) along with
the failing command and the structured error payload.
