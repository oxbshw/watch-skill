# Watch Skill in VS Code (native MCP / Copilot agent mode)

**Status: config verified against official docs, not machine-tested ☑**
(VS Code with Copilot agent mode is not set up on the development machine.)

Requires VS Code ≥ 1.99 with GitHub Copilot and agent mode enabled.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Per-workspace `.vscode/mcp.json` (note: `servers`, not `mcpServers`):

```json
{
  "servers": {
    "watch-skill": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]
    }
  }
}
```

Or user-wide: Command Palette → *MCP: Add Server*.

## Smoke test (3 steps)

1. Command Palette → *MCP: List Servers* → `watch-skill` running.
2. Copilot Chat (Agent mode), prompt: *"Use watch-skill to watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Follow up: *"list indexed videos"* → `list_videos`.
