# AgentVision agent matrix

One engine, every agent. Each page gives exact install + config + a 3-step
smoke test. Statuses are honest: **machine-tested ✅** means it was run on a
real machine by us; **doc-verified ☑** means the config matches the agent's
official documentation but was not executed here — reports welcome.

| Agent | Surface | Config file | Status |
|-------|---------|-------------|--------|
| [Claude Code](claude-code.md) | MCP (stdio) | `claude mcp add` / `.mcp.json` | machine-tested ✅ |
| [Claude Desktop](claude-desktop.md) | MCP (stdio) | `claude_desktop_config.json` | machine-tested ✅ |
| [Cursor](cursor.md) | MCP (stdio) | `~/.cursor/mcp.json` | machine-tested ✅ |
| [Codex CLI](codex-cli.md) | MCP (stdio) | `~/.codex/config.toml` | machine-tested ✅ |
| [Cline](cline.md) | MCP (stdio) | `cline_mcp_settings.json` | doc-verified ☑ |
| [Windsurf](windsurf.md) | MCP (stdio) | `~/.codeium/windsurf/mcp_config.json` | doc-verified ☑ |
| [Gemini CLI](gemini-cli.md) | MCP (stdio) | `~/.gemini/settings.json` | doc-verified ☑ |
| [VS Code (Copilot agent)](vscode.md) | MCP (stdio) | `.vscode/mcp.json` | doc-verified ☑ |
| Claude Code / claude.ai skills | Claude Skill | [`adapters/claude-skill/`](../../adapters/claude-skill/) | machine-tested ✅ |
| Anything with HTTP | REST + OpenAPI | `agentvision api` → `/openapi.json` | machine-tested ✅ |
| Any MCP client (remote) | MCP (streamable HTTP) | `agentvision serve --http` (`:8747/mcp`) | machine-tested ✅ |

**Fast path:** `agentvision setup` detects the agents installed on your
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
