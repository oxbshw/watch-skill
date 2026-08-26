# Watch Skill in Windsurf

<img src="../assets/agents/windsurf.webp" alt="Windsurf avatar riding a filmstrip with a timestamp compass" width="360">

**Status: config verified against official docs, not machine-tested ☑**
(Windsurf is not installed on the development machine — please report issues.)

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

Windsurf → Settings → Cascade → MCP Servers → *Add Server* → *Add custom
server*, or edit `~/.codeium/windsurf/mcp_config.json` directly:

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

Press the refresh button in the MCP panel after saving.

## Smoke test (3 steps)

1. The Cascade MCP panel should list `watch-skill` with its 39 tools.
2. Cascade prompt: *"Use watch-skill to watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Follow up: *"search my indexed videos for 'bunny'"* → `search_videos`.
