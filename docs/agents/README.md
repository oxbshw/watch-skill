# Watch Skill agent matrix

One engine, every agent. Each page gives exact install + config + a 3-step
smoke test. Statuses are honestly graded:
- **machine-tested ✅** — full end-to-end run in the agent (tools called, answers received)
- **machine-configured ◐** — `watch-skill setup` wrote the config on a real machine, the file
  parses in the agent's own tooling, and the exact server command answered an MCP
  `initialize` from a neutral directory; an in-app chat session was not run
- **doc-verified ☑** — config matches the agent's official docs (fetched, not remembered);
  not executed here. Every fenced config block in these pages is parsed by
  [`templates/agent-adapter/validate.py`](../../templates/agent-adapter/validate.py) in CI-style test runs.

| Agent | Surface | Config file | Status |
|-------|---------|-------------|--------|
| [Claude Code](claude-code.md) | plugin (skills + MCP) | `/plugin marketplace add oxbshw/watch-skill` | machine-tested ✅ |
| [Claude Desktop](claude-desktop.md) | MCP (stdio) | `claude_desktop_config.json` | machine-configured ◐ |
| [Cursor](cursor.md) | MCP (stdio) | `~/.cursor/mcp.json` | machine-configured ◐ |
| [Codex CLI](codex-cli.md) | MCP (stdio) | `~/.codex/config.toml` | machine-configured ◐ (`codex mcp list` shows it enabled) |
| [Cline](cline.md) | MCP (stdio) | `cline_mcp_settings.json` | doc-verified ☑ |
| [Windsurf](windsurf.md) | MCP (stdio) | `~/.codeium/windsurf/mcp_config.json` | doc-verified ☑ |
| [Gemini CLI](gemini-cli.md) | MCP (stdio) | `~/.gemini/settings.json` | doc-verified ☑ |
| [VS Code (Copilot agent)](vscode.md) | MCP (stdio) | `.vscode/mcp.json` | doc-verified ☑ |
| [GitHub Copilot CLI](github-copilot-cli.md) | MCP (stdio) | `~/.copilot/mcp-config.json` | doc-verified ☑ |
| [Kimi Code CLI](kimi-code.md) | MCP (stdio) | `~/.kimi-code/mcp.json` / `kimi mcp add` | doc-verified ☑ |
| [Qwen Code](qwen-code.md) | MCP (stdio) | `~/.qwen/settings.json` | doc-verified ☑ |
| [OpenCode](opencode.md) | MCP (stdio) | `opencode.json` | doc-verified ☑ |
| [Goose](goose.md) | MCP extension (stdio) | `~/.config/goose/config.yaml` | doc-verified ☑ |
| [OpenHands](openhands.md) | MCP (stdio) | `config.toml` `[mcp]` | doc-verified ☑ |
| [Kilo Code](kilocode.md) | MCP (stdio) | `kilo.jsonc` (v7+) | doc-verified ☑ |
| [Qodo Command](qodo.md) | MCP (stdio) | project `mcp.json` + agent TOML | doc-verified ☑ |
| [Agent Zero](agent-zero.md) | MCP (stdio/HTTP) | Settings UI → `mcp_servers` | doc-verified ☑ |
| [OpenClaw](openclaw.md) | skills (SKILL.md dirs) | `skills.load.extraDirs` | doc-verified ☑ |
| [Pi](pi.md) | skills (CLI-first, no MCP by design) | `--skills-dir` / pi package | doc-verified ☑ |
| [Hermes Agent & co.](hermes.md) | skills / `AGENTS.md` / REST | see page | doc-verified ☑ |
| [LangChain / CrewAI / Agents SDK / LlamaIndex / AutoGen](frameworks.md) | Python adapters | `watch_skill.integrations.*` | machine-tested ✅ (3 of 5 live; 5 of 5 under test) |
| Any instruction-following agent | `AGENTS.md` | [`adapters/agents-md/AGENTS.md`](../../adapters/agents-md/AGENTS.md) | machine-tested ✅ (it's how this repo dogfoods) |
| Anything with HTTP | REST + OpenAPI | `watch-skill api` → `/openapi.json` | machine-tested ✅ |
| Any MCP client (remote) | MCP (streamable HTTP) | `watch-skill serve --http` (`:8747/mcp`) | machine-tested ✅ |

Your agent missing? [Add it in ~20 minutes](../../CONTRIBUTING.md#add-your-agent)
from the template — most rows above are one config block + one doc page.

**Fast path:** `watch-skill setup` detects the agents installed on your
machine and writes these configs for you (with a backup of any existing
file).

The tool contract every agent sees:

| Tool | Use it when |
|------|-------------|
| `watch_video` | first look at any URL/stream/file — analyzes AND indexes |
| `ask_video` | ANY follow-up about an already-watched video |
| `get_moment` | zoom into one timestamp of an indexed video |
| `search_videos` | find something across all videos ever watched |
| `capture` | record a URL session / the screen / a window |
| `loop_start` / `loop_iterate` / `loop_status` | iterate on your own visual output until criteria pass |
| `list_videos` | see what's in the index |
| `doctor` | anything is broken — self-heals deps |
