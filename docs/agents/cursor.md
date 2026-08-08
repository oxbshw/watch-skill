# Watch Skill in Cursor

<img src="../assets/agents/cursor.webp" alt="Cursor avatar scrubbing a physical video timeline" width="360">

**Status: machine-configured ◐** — `watch-skill setup` wrote this config on
a real machine and the server command answered MCP `initialize`; a full
in-Cursor chat session was not run.

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

Global: `~/.cursor/mcp.json` — per-project: `.cursor/mcp.json` in the repo:

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

Then: Cursor Settings → MCP → verify `watch-skill` shows a green dot
(enable it if prompted).

## Smoke test (3 steps)

1. Open Cursor's chat (Agent mode), type: *"Use the watch-skill tools to
   watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what
   happens at 0:10."*
2. Approve the `watch_video` tool call when prompted.
3. Follow up with *"what color is the bird?"* — should call `ask_video`
   and answer from the index without re-processing.

## Notes

- Cursor renders tool text output; image blocks may be ignored depending on
  version — the text report carries frame paths you can open manually.
