# AgentVision

**Give any agent a video input — and let it watch its own output.**

AgentVision turns any video source into agent-ready perception: scene-detected
deduplicated frames, on-frame OCR, and a captions-first → local-Whisper
transcription ladder — all landing in a persistent, searchable index.
Analyze once, ask forever. One core engine, four surfaces: **MCP**
(stdio + streamable HTTP), **CLI**, **REST API** (OpenAPI), and a
**Python SDK**. Any agent that speaks MCP or HTTP works with zero custom code.

The flagship feature is **THE LOOP**: an agent records its own output (a UI it
just built, a generated video, gameplay), gets a structured critique against
natural-language pass criteria, applies fixes, and re-captures — until it
passes. On pass, AgentVision renders the shareable before/after proof:

![The Loop: broken checkout page fixed autonomously](docs/assets/loop_before_after.gif)

*Above: iteration 0 detected `TOTAL: $NaN` as a critical issue with a
suggested fix; after the fix, iteration 1 verified it and rendered this GIF.
Reproduce with `uv run python "examples/loop_demo/run_demo.py"`.*

## Why not just screenshot?

Screenshots miss everything that moves: flaky animation, layout shift during
load, a spinner that never resolves, audio/video desync, the state *between*
clicks. AgentVision gives agents the temporal dimension — with token budgets
that make it affordable (scene-aware sampling, perceptual-hash dedup, hard
frame caps, retrieval instead of re-injection).

## Install

Windows, macOS, or Linux; Python 3.11+. Only Python is required — everything
else self-bootstraps.

```powershell
# with uv (recommended)
git clone <repo> agentvision && cd agentvision
uv sync --all-extras
uv run agentvision doctor        # installs ffmpeg + yt-dlp if missing, checks GPU/disk/keys

# or with pip
python -m venv .venv
.venv\Scripts\Activate.ps1       # source .venv/bin/activate on macOS/Linux
pip install -e ".[all]"
agentvision doctor
```

`doctor` self-heals: missing binaries install via winget → choco → portable
downloads into a managed bin dir (`~/.agentvision/bin`); a stale yt-dlp
auto-updates; every failed check prints a machine-actionable `fix`.

Optional: `uv sync --extra loop && uv run playwright install chromium` for URL
capture (system Edge/Chrome is used automatically when present, so this is
usually unnecessary on Windows).

## Quick start

```powershell
# Watch anything: 1800+ sites via yt-dlp, direct URLs, HLS/DASH, local files
agentvision watch "https://youtu.be/dQw4w9WgXcQ" "what happens in this video?"

# Zoom into a moment (dense sampling up to 2 fps)
agentvision watch "talk.mp4" --start 12:30 --end 13:10

# Follow-ups hit the index — instant, no re-processing
agentvision ask <video_id> "when does the demo crash?"
agentvision search "kubernetes"          # across every video ever watched

# Record your own output
agentvision capture "https://localhost:3000" --duration 10
agentvision capture "screen:" --duration 15
agentvision capture "window:My App"

# THE LOOP
agentvision loop start "http://localhost:3000" "the cart total must show a real price"
# ...apply the suggested fixes...
agentvision loop iterate <loop_id>       # reports fixed/unchanged/new + proof GIF on pass
```

### MCP (Claude Code, or any MCP client)

```powershell
claude mcp add agentvision -- uv --directory "C:\path\to\agentvision" run agentvision serve
# or HTTP: agentvision serve --http   (streamable HTTP on :8747)
```

Tools: `watch_video`, `ask_video`, `get_moment`, `search_videos`, `capture`,
`loop_start`, `loop_iterate`, `loop_status`, `list_videos`, `doctor`.
Responses are text + image blocks, capped at 12 frames — retrieval makes more
unnecessary.

### REST (everything else)

```powershell
agentvision api                          # http://127.0.0.1:8748, spec at /openapi.json
```

```bash
curl -X POST http://127.0.0.1:8748/v1/watch \
  -H "Content-Type: application/json" \
  -d '{"source": "https://youtu.be/...", "budget": 40}'
curl -X POST http://127.0.0.1:8748/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"video": "<video_id>", "question": "what breaks first?"}'
```

Set `AGENTVISION_API_BEARER_TOKEN` to expose it beyond localhost (the server
refuses public binds without it).

### Python

```python
from agentvision.watch import watch

result = watch("https://youtu.be/...", start_seconds=30, end_seconds=90)
for frame in result.perception.frames:
    print(frame.timestamp_seconds, frame.path, frame.ocr_text)
print(result.transcript.formatted())
```

### Claude Skill / AGENTS.md

`adapters/claude-skill/` is a drop-in upgrade of the classic `/watch` skill
(thin wrapper over this CLI); `adapters/agents-md/AGENTS.md` is a paste-in
rules block for Codex, Cursor, and friends.

## How perception stays cheap

| Duration | Frame budget | Strategy |
|----------|-------------|----------|
| ≤ 30 s | ~30 | scene boundaries + midpoints |
| ≤ 3 min | ~60 | + uniform fill if scenes under-produce |
| longer | ~100 (hard cap) | + `--start/--end` focused mode up to 2 fps |

Perceptual-hash dedup drops near-identical frames (held slides, static
screens) so the budget buys distinct content. Frames default to 512 px wide.
After the first analysis, `ask` answers from hybrid FTS5 + vector retrieval
over transcript, OCR, and scene text — a handful of frames, not 80.

## Transcription ladder

1. **Platform captions** (yt-dlp; manual subs preferred) — free, instant.
2. **Local faster-whisper** — the default fallback; model size auto-selected
   by RAM/VRAM; fully offline. No API key ever required.
3. **Cloud STT (opt-in only)** — Groq `whisper-large-v3`, then OpenAI;
   audio chunked under 24 MB with 2 s overlap so any length works.

Optional speaker diarization: `--diarize` with the `diarize` extra
(pyannote; needs a Hugging Face token).

## Vision layer

Model-agnostic: Anthropic / OpenAI / Gemini / Ollama behind one interface,
two tiers (`cheap` for bulk scene descriptions, `strong` for answers and loop
critiques), a data-driven registry, and a pre-call cost guard with a
configurable ceiling.

## Privacy invariants (hard rules, enforced by tests)

- The video file itself **never** leaves the machine.
- No cookies, no logins — only public data is requested.
- Only extracted mono-16 kHz audio may go to a cloud STT API, and only when
  you explicitly opt in (`AGENTVISION_CLOUD_STT_ENABLED=1` or `--cloud-stt`).
- Downloads are cached (`~/.agentvision/cache`, LRU, size-capped) and keyed by
  content — an unchanged video is never re-downloaded.

## Configuration

Precedence: CLI flag > env var > `.env` > defaults. All env vars use the
`AGENTVISION_` prefix — see [core/agentvision/config.py](core/agentvision/config.py)
for every setting (data dir, frame budgets, vision tiers, cost ceiling,
API keys, bearer token).

## Layout

```
core/agentvision/   all logic: acquire, perceive, transcribe, index, vision, loop, health
surfaces/           thin wrappers: mcp_server, cli, api      (core never imports surfaces)
adapters/           claude-skill + AGENTS.md templates
examples/           loop_demo — the M3 acceptance demo
tests/              pytest (synthesized clips; no copyrighted media, no network)
docs/               REFERENCE_ANALYSIS.md, DECISIONS.md
```

Errors everywhere are structured — `{error, message, fix, details}` — so
agents can act on failures without parsing prose.

## Development

```powershell
uv sync --all-extras
uv run pytest -q                 # 160+ tests, all offline
uv run python "examples/loop_demo/run_demo.py"   # THE LOOP end-to-end
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Non-obvious choices (especially
Windows-driven dependency swaps) are logged in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT.
