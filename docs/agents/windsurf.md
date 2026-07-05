# Watch Skill in Windsurf

**Status: config verified against official docs, not machine-tested ☑**
(Windsurf is not installed on the development machine — please report issues.)

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Windsurf → Settings → Cascade → MCP Servers → *Add Server* → *Add custom
server*, or edit `~/.codeium/windsurf/mcp_config.json` directly:

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

Press the refresh button in the MCP panel after saving.

## Smoke test (3 steps)

1. The Cascade MCP panel should list `watch-skill` with its 10 tools.
2. Cascade prompt: *"Use watch-skill to watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Follow up: *"search my indexed videos for 'bunny'"* → `search_videos`.
