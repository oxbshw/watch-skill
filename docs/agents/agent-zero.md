# Watch Skill in Agent Zero

**Status: doc-verified ☑** — config matches the official Agent Zero MCP
docs; not executed here.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Agent Zero's Settings UI → MCP → external servers takes the standard
`mcpServers` JSON (persisted to `tmp/settings.json` under
`"mcp_servers"`):

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

Agent Zero queries the server on startup and injects the tool list into
its system prompt, so the tools are visible to the agent immediately.

## Smoke test (3 steps)

1. New chat: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell
   me what happens at 0:10."*
2. Watch the tool router pick `watch_video`.
3. Follow up: *"what color is the bird?"* — should route to `ask_video`,
   no re-processing.

## Notes

- Agent Zero usually runs dockerized. Run the MCP server inside the same
  container (or use `watch-skill serve --http` on the host and configure
  a remote streaming-HTTP entry instead) so frame paths in reports are
  readable where the agent runs, and mount `~/.watch-skill/` if the
  container is ephemeral.
