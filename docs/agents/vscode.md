# AgentVision in VS Code (native MCP / Copilot agent mode)

**Status: config verified against official docs, not machine-tested ☑**
(VS Code with Copilot agent mode is not set up on the development machine.)

Requires VS Code ≥ 1.99 with GitHub Copilot and agent mode enabled.

## Install

```powershell
git clone https://github.com/oxbshw/agentvision && cd agentvision
uv sync --extra all
uv run agentvision doctor
```

## Configure

Per-workspace `.vscode/mcp.json` (note: `servers`, not `mcpServers`):

```json
{
  "servers": {
    "agentvision": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\agentvision", "run", "agentvision", "serve"]
    }
  }
}
```

Or user-wide: Command Palette → *MCP: Add Server*.

## Smoke test (3 steps)

1. Command Palette → *MCP: List Servers* → `agentvision` running.
2. Copilot Chat (Agent mode), prompt: *"Use agentvision to watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Follow up: *"list indexed videos"* → `list_videos`.
