<p align="center">
  <img src="docs/assets/watch-skill-repositories.webp" alt="Watch Skill tracks repositories and skills from an AI agent's workspace" width="100%">
</p>

<p align="center">
  <img src="docs/assets/watch-skill-repositories-alt.webp" alt="Watch Skill repository and skill tracking shown in a warm pixel-art workspace" width="100%">
</p>

<div align="center">

# Watch Skill

**Video understanding and memory for AI agents.**

Watch Skill turns video into evidence an agent can search, cite, and revisit. It accepts
URLs from 1,800+ sites, live HLS/DASH streams, local files, meeting recordings, and an
agent's own browser or desktop capture. Each watch produces a persistent index of scenes,
on-screen text, and transcript—available through skills, 23 MCP tools, a CLI, REST, and
native framework adapters.

**Watch. Remember. Verify.**

[![CI](https://github.com/oxbshw/watch-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/oxbshw/watch-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-3776AB)](pyproject.toml)

</div>

## Start in 60 seconds

### Claude Code

```text
/plugin marketplace add oxbshw/watch-skill
/plugin install watch-skill@watch-skill
```

Run `/watch-skill:setup-watch-skill` once after installation. It installs the engine,
checks the binary dependencies, registers the MCP server, and offers to configure a
vision provider.

### macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.sh | sh
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.ps1 | iex"
```

Then watch a video and ask a follow-up:

```bash
watch-skill watch "https://youtu.be/..." "Summarize the important moments."
watch-skill ask <video_id> "When does the demo first fail?"
watch-skill search "pricing decision"       # search every indexed video
watch-skill serve                           # MCP over stdio
```

Transcription, OCR, and search can run locally without an API key. For visual Q&A, use
Gemini, Anthropic, OpenAI, OpenRouter, or a local Ollama model. See
[Getting started](docs/getting-started.md) for manual installation and
[Configuration](docs/configuration.md) for provider and privacy settings.

## Why use it

- **Evidence instead of frame dumps.** Scene detection and perceptual deduplication spend
  the frame budget on distinct moments. Answers include timestamps, confidence, and the
  evidence used to support them.
- **Persistent video memory.** Analyze once, ask again without downloading or transcribing
  the same video. Hybrid full-text and vector retrieval works within one video or across
  the entire library.
- **Local-first processing.** Original-language captions are preferred, local Whisper is
  the default fallback, and cloud speech-to-text is opt-in. An Ollama configuration keeps
  the complete pipeline on the machine.
- **Flow verification.** THE LOOP records an agent's browser, screen, or window; checks the
  result against plain-language criteria; and produces before/after proof after a fix.
- **Corrections that persist.** `report_mistake` stores a local lesson, applies it to related
  questions, and turns it into a replayable evaluation.
- **Measured cost controls.** Text-first answers, semantic caching, configurable token
  budgets, and explicit `cheapest`, `quality_first`, and `offline_only` policies keep the
  trade-offs visible.
- **Multilingual retrieval.** Script-aware OCR routing, Arabic normalization, CJK substring
  matching, and multilingual embeddings support questions across languages.

The repository includes reproducible [cost](benchmarks/cost/RESULTS.md) and
[perception](benchmarks/perception/RESULTS.md) benchmarks. Product claims in this README
link to the relevant implementation notes or testable example rather than relying on
unqualified marketing numbers.

## Works with your agent

The setup command detects supported clients and updates their configuration with a backup.
Manual guides are available for every entry below.

| | | | |
|:---:|:---:|:---:|:---:|
| [<img src="docs/assets/agents/claude-code.webp" width="150" alt="Claude Code avatar">](docs/agents/claude-code.md)<br>[Claude Code](docs/agents/claude-code.md) | [<img src="docs/assets/agents/claude-desktop.webp" width="150" alt="Claude Desktop avatar">](docs/agents/claude-desktop.md)<br>[Claude Desktop](docs/agents/claude-desktop.md) | [<img src="docs/assets/agents/cursor.webp" width="150" alt="Cursor avatar">](docs/agents/cursor.md)<br>[Cursor](docs/agents/cursor.md) | [<img src="docs/assets/agents/codex-cli.webp" width="150" alt="Codex CLI avatar">](docs/agents/codex-cli.md)<br>[Codex CLI](docs/agents/codex-cli.md) |
| [<img src="docs/assets/agents/cline.webp" width="150" alt="Cline avatar">](docs/agents/cline.md)<br>[Cline](docs/agents/cline.md) | [<img src="docs/assets/agents/windsurf.webp" width="150" alt="Windsurf avatar">](docs/agents/windsurf.md)<br>[Windsurf](docs/agents/windsurf.md) | [<img src="docs/assets/agents/gemini-cli.webp" width="150" alt="Gemini CLI avatar">](docs/agents/gemini-cli.md)<br>[Gemini CLI](docs/agents/gemini-cli.md) | [<img src="docs/assets/agents/vscode.webp" width="150" alt="VS Code avatar">](docs/agents/vscode.md)<br>[VS Code](docs/agents/vscode.md) |
| [<img src="docs/assets/agents/github-copilot-cli.webp" width="150" alt="GitHub Copilot CLI avatar">](docs/agents/github-copilot-cli.md)<br>[GitHub Copilot CLI](docs/agents/github-copilot-cli.md) | [<img src="docs/assets/agents/kimi-code.webp" width="150" alt="Kimi Code avatar">](docs/agents/kimi-code.md)<br>[Kimi Code](docs/agents/kimi-code.md) | [<img src="docs/assets/agents/qwen-code.webp" width="150" alt="Qwen Code avatar">](docs/agents/qwen-code.md)<br>[Qwen Code](docs/agents/qwen-code.md) | [<img src="docs/assets/agents/opencode.webp" width="150" alt="OpenCode avatar">](docs/agents/opencode.md)<br>[OpenCode](docs/agents/opencode.md) |
| [<img src="docs/assets/agents/goose.webp" width="150" alt="Goose avatar">](docs/agents/goose.md)<br>[Goose](docs/agents/goose.md) | [<img src="docs/assets/agents/openhands.webp" width="150" alt="OpenHands avatar">](docs/agents/openhands.md)<br>[OpenHands](docs/agents/openhands.md) | [<img src="docs/assets/agents/kilocode.webp" width="150" alt="Kilo Code avatar">](docs/agents/kilocode.md)<br>[Kilo Code](docs/agents/kilocode.md) | [<img src="docs/assets/agents/qodo.webp" width="150" alt="Qodo avatar">](docs/agents/qodo.md)<br>[Qodo](docs/agents/qodo.md) |
| [<img src="docs/assets/agents/agent-zero.webp" width="150" alt="Agent Zero avatar">](docs/agents/agent-zero.md)<br>[Agent Zero](docs/agents/agent-zero.md) | [<img src="docs/assets/agents/openclaw.webp" width="150" alt="OpenClaw avatar">](docs/agents/openclaw.md)<br>[OpenClaw](docs/agents/openclaw.md) | [<img src="docs/assets/agents/pi.webp" width="150" alt="Pi avatar">](docs/agents/pi.md)<br>[Pi](docs/agents/pi.md) | [<img src="docs/assets/agents/hermes.webp" width="150" alt="Hermes avatar">](docs/agents/hermes.md)<br>[Hermes](docs/agents/hermes.md) |

[<img src="docs/assets/agents/frameworks.webp" width="360" alt="Framework agent avatars collaborating around a shared video engine">](docs/agents/frameworks.md)

Native tools are also available for [LangChain/LangGraph, CrewAI, OpenAI Agents SDK,
LlamaIndex, and AutoGen](docs/agents/frameworks.md); any other framework can use REST or
MCP.

| Connection | Supported agents and frameworks |
|---|---|
| Plugin and skills | [Claude Code](docs/agents/claude-code.md), [OpenClaw](docs/agents/openclaw.md), [Pi](docs/agents/pi.md), [Hermes-style agents](docs/agents/hermes.md) |
| MCP | [Claude Desktop](docs/agents/claude-desktop.md), [Cursor](docs/agents/cursor.md), [Codex CLI](docs/agents/codex-cli.md), [Cline](docs/agents/cline.md), [Windsurf](docs/agents/windsurf.md), [Gemini CLI](docs/agents/gemini-cli.md), [VS Code](docs/agents/vscode.md), [GitHub Copilot CLI](docs/agents/github-copilot-cli.md), [Kimi Code](docs/agents/kimi-code.md), [Qwen Code](docs/agents/qwen-code.md), [OpenCode](docs/agents/opencode.md), [Goose](docs/agents/goose.md), [OpenHands](docs/agents/openhands.md), [Kilo Code](docs/agents/kilocode.md), [Qodo](docs/agents/qodo.md), [Agent Zero](docs/agents/agent-zero.md) |
| Native Python tools | [LangChain/LangGraph, CrewAI, OpenAI Agents SDK, LlamaIndex, and AutoGen](docs/agents/frameworks.md) |
| HTTP | Vercel AI SDK, n8n, and any client that can call REST/OpenAPI |

The [full compatibility matrix](docs/agents/README.md) separates machine-tested,
machine-configured, and documentation-verified integrations. If your agent is missing,
the [adapter template](templates/agent-adapter/README.md) provides a short contribution
path.

## Common workflows

### Build a searchable video library

```bash
watch-skill batch ./recordings --limit 50
watch-skill library overview
watch-skill library ask "What did the team decide about authentication?"
```

`library ask` synthesizes evidence across videos and retains per-video timestamp
provenance. The [library example](examples/12-library-memory/) demonstrates a question
whose answer is distributed across four clips.

### Verify an agent's browser work

```bash
watch-skill loop start \
  --source "browser:http://127.0.0.1:3000" \
  --criteria "Checkout completes and the total is always a valid currency amount"
```

The loop captures the full interaction, critiques failures, and records proof after the
agent applies a fix. [Example 14](examples/14-browser-verification/) includes a transient
`$NaN` bug that an end-state screenshot misses.

<p align="center">
  <img src="docs/assets/loop_before_after.gif" alt="A checkout flow fails with a NaN total, is fixed, and passes verification" width="720">
</p>

### Export an offline report

```bash
watch-skill viewer <video_id> --out video-report.html
```

The generated page contains its frames, transcript, OCR, cached answers, and cited
evidence. It has no external runtime dependencies and can be opened without a server.

## Examples

The examples progress from a first watch to agent integration, cross-video memory, and
self-verification.

| Track | Examples |
|---|---|
| Learn the core | [01 Watch and ask](examples/01-watch-and-ask), [02 Focused moment](examples/02-focused-moment), [03 Cross-video search](examples/03-cross-video-search) |
| Build with agents | [06 MCP and REST](examples/06-agent-integration), [09 Framework adapters](examples/09-framework-adapters), [15 Private offline workflow](examples/15-private-offline-workflow) |
| Understand and organize | [05 Multilingual Arabic](examples/05-multilingual-arabic), [10 Structured extraction](examples/10-structured-extraction), [11 Batch mode](examples/11-batch-mode), [12 Library memory](examples/12-library-memory) |
| Verify and improve | [04 UI loop](examples/04-ui-loop), [07 Lessons and stats](examples/07-lessons-and-stats), [08 Loop types](examples/08-loop-types), [13 Self-improvement](examples/13-self-improvement), [14 Browser verification](examples/14-browser-verification) |
| Share results | [16 Export a self-contained viewer](examples/16-shareable-viewer) |

See the [example catalog](examples/README.md) for prerequisites, expected output, and a
recommended path through all 16 examples.

## Architecture

All interfaces call the same Python core. Skills and agent adapters decide *when* to use
Watch Skill; acquisition, perception, transcription, indexing, answering, and verification
remain in `src/watch_skill`.

```mermaid
flowchart LR
    A["Agents and frameworks"] --> S["Skills · MCP · CLI · REST"]
    S --> AC["Acquire"]
    AC --> P["Scenes · OCR · transcript"]
    P --> I[("Persistent index")]
    I --> Q["Answers · extraction · library"]
    I --> L["Lessons and evaluations"]
    V["Browser · screen · stream capture"] --> C["Loop critic"]
    C --> I
```

Read [Architecture](docs/architecture.md) for the data model, provider boundaries, and
extension points.

## Documentation

| Guide | Use it for |
|---|---|
| [Documentation index](docs/README.md) | Choose a guide by task or audience |
| [Getting started](docs/getting-started.md) | Installation, first watch, and first agent connection |
| [Tool reference](docs/tools/README.md) | All 23 MCP tools and their REST/CLI counterparts |
| [Configuration](docs/configuration.md) | Storage, privacy, models, limits, and environment variables |
| [Agent matrix](docs/agents/README.md) | Per-client setup and verification status |
| [Use-case packs](docs/packs/README.md) | Recipes for research, meetings, QA, content, and operations |
| [THE LOOP](docs/guides/the-loop.md) | Capture, critique, iteration, and proof artifacts |
| [Cost policy](docs/cost.md) | Routing, budgets, caching, and benchmark method |
| [Troubleshooting](docs/troubleshooting.md) | Dependency repair and common runtime errors |
| [Engineering decisions](docs/DECISIONS.md) | The reasoning behind non-obvious design choices |
| [Roadmap](docs/ROADMAP.md) | Planned work and contribution opportunities |

## Development

```bash
git clone https://github.com/oxbshw/watch-skill
cd watch-skill
uv sync --extra all
uv run pytest
uv run ruff check .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for test tiers, documentation standards, and the
agent-adapter checklist. Security and privacy reports are covered by
[SECURITY.md](SECURITY.md).

Watch Skill is available under the [MIT License](LICENSE).
