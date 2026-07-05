# Watch Skill in Claude Desktop

**Status: machine-configured ◐** — `watch-skill setup` wrote this config on
a real machine (existing keys preserved, backup taken) and the server
command answered MCP `initialize`; a full in-app session was not run.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Edit `%APPDATA%\Claude\claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]
    }
  }
}
```

Tip: `watch-skill setup` (see [the 2-minute install](../../README.md#install))
detects Claude Desktop and writes this for you, backing up the existing file.

## Smoke test (3 steps)

1. Fully quit and restart Claude Desktop (tray icon too), then check the
   tools icon (🔨) lists `watch-skill`.
2. Ask: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ with watch-skill — what happens at 0:10?"*
3. Follow up: *"Search my videos for 'butterfly'"* — should hit `search_videos`.
