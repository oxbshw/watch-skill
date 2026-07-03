# AgentVision

**Give any agent a video input — and let it watch its own output.**

AgentVision resolves any video source (1800+ sites via yt-dlp, direct URLs,
HLS/DASH streams, local files, screen capture) into smart, token-aware
perception: scene-detected frames, perceptual-hash dedup, OCR, and a
captions-first / local-whisper transcription ladder. Everything lands in a
persistent searchable index — analyze once, ask forever. One core engine,
four surfaces: **MCP** (stdio + streamable HTTP), **CLI**, **REST API**
(OpenAPI), and a **Python SDK**.

The flagship feature is **The Loop**: agents record their own output (UI
sessions, generated video, gameplay), watch it, get a structured critique,
fix, and re-capture — until the pass criteria are met.

> Status: pre-release, under active development. Milestone 0 (scaffold +
> self-healing doctor) is complete; the watch pipeline is next.

## Quick start (Windows, Python 3.11+)

```powershell
# with uv (recommended)
uv sync
uv run agentvision doctor      # bootstraps ffmpeg + yt-dlp if missing

# or with pip
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[all]"
agentvision doctor
```

`agentvision doctor` self-heals: it installs missing dependencies via
winget → choco → portable binaries downloaded into a managed `bin/` dir, and
auto-updates a stale yt-dlp.

## Privacy invariants (hard rules, enforced by tests)

- The video file itself **never** leaves the machine.
- No cookies, no logins — only public data is requested.
- Only extracted mono-16 kHz audio may go to a cloud STT API, and only when
  you explicitly enable cloud transcription (`AGENTVISION_CLOUD_STT_ENABLED=1`).
  The default fallback is **local** faster-whisper.

## Layout

```
core/agentvision/   all logic: acquire, perceive, transcribe, index, vision, loop, health
surfaces/           thin wrappers: mcp_server, cli, api
adapters/           claude-skill + AGENTS.md templates
tests/              pytest (synthesized clips, no copyrighted media, no network)
docs/               REFERENCE_ANALYSIS.md, DECISIONS.md
```

## License

MIT.
