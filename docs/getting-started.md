# Getting started

From nothing to asking a video questions inside your agent, in under ten
minutes. Every command below is copy-pasteable.

## 1. Install (about 2 minutes)

The installer bootstraps `uv` (and a Python if you have none), clones the
repo, installs dependencies, runs the self-healing `doctor` (which installs
ffmpeg, yt-dlp, and deno if missing), and registers the MCP server in every
supported agent it finds on your machine.

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.ps1 | iex"
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.sh | sh
```

The install lands in `~/watch-skill` (override on macOS/Linux with
`WATCHSKILL_HOME=/path/to/dir` before the command).

**Manual install** (if you prefer to see every step):

```bash
git clone https://github.com/oxbshw/watch-skill
cd watch-skill
uv sync --extra all          # or: pip install -e ".[all]"
uv run watch-skill doctor    # checks AND fixes: ffmpeg, yt-dlp, deno, disk, GPU, API keys
```

`doctor` should end with every check `ok` (some informational checks may
`warn` — a warning never blocks a watch). Re-run it any time something
breaks; it self-heals what it can and prints a `fix` for what it cannot.

No API keys are needed for anything in this guide — transcription and OCR
run locally by default. Cloud vision models are optional and only improve
answer verification (see [configuration.md](configuration.md)).

## 2. First watch (about 1 minute)

Watch a short, public YouTube video. This downloads it, extracts scene-aware
deduplicated frames, OCRs them, pulls the captions (falling back to local
Whisper when a video has none), and persists everything into the index at
`~/.watch-skill/index.db`:

```bash
uv run watch-skill watch "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

The first line of output matters:

```
> **Indexed:** video_id `4b0f48e4f4ae6e02` — follow up with `watch-skill ask 4b0f48e4f4ae6e02 ...`
```

followed by a Markdown report: metadata, the transcript with timestamps,
on-screen text, and frame paths. The very first run also downloads the local
Whisper model once; later watches skip that.

Useful variants:

```bash
# zoom into a section with denser frame sampling
uv run watch-skill watch "https://youtu.be/..." --start 1:00 --end 1:30

# transcript only — fastest possible look at a talk or interview
uv run watch-skill watch "https://youtu.be/..." --transcript-only

# a local file works exactly the same way
uv run watch-skill watch "C:\clips\demo.mp4"
```

## 3. First ask (seconds)

Questions run against the persistent index — no re-download, no
re-processing, and they keep working in every later session:

```bash
uv run watch-skill ask 4b0f48e4f4ae6e02 "what does he say about the elephants?"
```

You get a text answer with timestamped evidence, plus a calibrated
confidence score. If the video does not clearly show the answer, it says so
plainly instead of guessing. Repeat questions hit the semantic answer cache
and come back marked `cached: true` at zero model cost.

Two more commands worth knowing right away:

```bash
uv run watch-skill list                  # everything in the index
uv run watch-skill search "elephants"    # find a moment across ALL indexed videos
```

## 4. Into Claude Code (about 2 minutes)

If you ran the installer, `watch-skill setup` already registered the MCP
server — restart Claude Code and skip to the smoke test. Otherwise:

```bash
claude mcp add watch-skill -- uv --directory "C:\path\to\watch-skill" run watch-skill serve
```

(or add it to `.mcp.json` in your project — see
[agents/claude-code.md](agents/claude-code.md) for the JSON form and for
`pip`-based installs).

Smoke test, inside Claude Code:

1. Run `/mcp` — `watch-skill` should be listed as connected.
2. Say: *"Use watch-skill to watch https://www.youtube.com/watch?v=jNQXAC9IVRw
   and tell me what happens."* — that calls `watch_video`.
3. Follow up: *"What does he say about the elephants?"* — that calls
   `ask_video` and answers in seconds from the index.

Using a different agent? `watch-skill setup` auto-configures Claude Desktop,
Cursor, Codex CLI, Windsurf, and Gemini CLI too; manual configs for every
agent are in [agents/README.md](agents/README.md).

## Where to go next

- [Configuration](configuration.md) — every environment variable, config
  key, and CLI flag.
- [Tool reference](tools/README.md) — all 13 MCP tools with parameters,
  defaults, and their REST twins.
- [Guides](guides/) — YouTube analysis, Arabic in / Arabic out, THE LOOP,
  and the lessons + savings workflow.
- [Architecture](architecture.md) — how the pipeline, the three surfaces,
  and the self-healing answer loop fit together.
- [Troubleshooting](troubleshooting.md) — symptom → cause → fix.
