# Watch Skill in Kimi Code CLI

<img src="../assets/agents/kimi-code.webp" alt="Kimi Code archivist avatar opening film canisters" width="360">

**Status: doc-verified ☑** — config matches Moonshot's official Kimi Code
CLI docs; not executed here.

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

User level: `~/.kimi-code/mcp.json` (shared across projects). Project
level: `.kimi-code/mcp.json` in the repo (wins on name conflicts). The
format is the common `mcpServers` shape:

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

Or skip the JSON and use the CLI/TUI: `kimi mcp add` from the shell, or
`/mcp-config` inside a session.

## Smoke test (3 steps)

1. `kimi`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and
   tell me what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- Entries with `command` are stdio servers; entries with `url` are HTTP.
  For a remote setup, `watch-skill serve --http` and a `url` entry
  pointing at `http://<host>:8747/mcp` also works.
