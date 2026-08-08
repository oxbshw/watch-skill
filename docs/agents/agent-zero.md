# Watch Skill in Agent Zero

<img src="../assets/agents/agent-zero.webp" alt="Agent Zero avatar mapping a branching video timeline" width="360">

**Status: doc-verified ☑** — config matches the official Agent Zero MCP
docs; not executed here.

## Install

```bash
uvx --from "watch-skill[standard]" watch-skill doctor
```

`uvx` fetches the package on first use and needs no checkout. Prefer a
permanent install? `pipx install "watch-skill[standard]"`, then use
`"command": "watch-skill", "args": ["serve"]` in the config below.

<details>
<summary>From source instead (contributors)</summary>

```bash
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

Then run `watch-skill setup`, which writes the config pointing at your
checkout rather than the published package.

</details>

## Configure

Agent Zero's Settings UI → MCP → external servers takes the standard
`mcpServers` JSON (persisted to `tmp/settings.json` under
`"mcp_servers"`):

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"]
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
