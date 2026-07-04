# AgentVision in Claude Desktop

**Status: machine-tested ✅** (config written and tools verified on the
development machine).

## Install

```powershell
git clone https://github.com/agentvision/agentvision && cd agentvision
uv sync --all-extras
uv run agentvision doctor
```

## Configure

Edit `%APPDATA%\Claude\claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agentvision": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\agentvision", "run", "agentvision", "serve"]
    }
  }
}
```

Tip: `agentvision setup` (see [the 2-minute install](../../README.md#install))
detects Claude Desktop and writes this for you, backing up the existing file.

## Smoke test (3 steps)

1. Fully quit and restart Claude Desktop (tray icon too), then check the
   tools icon (🔨) lists `agentvision`.
2. Ask: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ with agentvision — what happens at 0:10?"*
3. Follow up: *"Search my videos for 'butterfly'"* — should hit `search_videos`.
