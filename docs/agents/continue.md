# Watch Skill in Continue

**Status: doc-verified ☑** — config matches the official Continue MCP docs;
not executed here.

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

</details>

## Configure

Continue reads MCP servers from `.continue/mcpServers/` in the workspace —
one JSON file per server. Create `.continue/mcpServers/watch-skill.json`:

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

The format is the same one Claude Desktop, Cursor, and Cline use, so an
existing block can be copied across unchanged.

## Smoke test (3 steps)

1. In the chat, ask: *"Watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at
   0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

- MCP tools are available in agent mode; chat and edit modes will not call
  them.
- Keep the file in the repository to share the setup with a team, or put it
  in the global `~/.continue/` directory for every workspace.
