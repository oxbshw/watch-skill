# Watch Skill in Amp

<img src="../assets/agents/amp.webp" alt="Amp avatar beside a tower of glowing film reels" width="360">

**Status: doc-verified ☑** — config matches Sourcegraph's own Amp MCP setup
guide; not executed here.

## Install

```bash
uvx --from "watch-skill[standard]" watch-skill doctor
```

`uvx` fetches the package on first use and needs no checkout. Prefer a
permanent install? `pipx install "watch-skill[standard]"`, then use
`"command": "watch-skill", "args": ["serve"]` below.

<details>
<summary>From source instead (contributors)</summary>

```bash
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

</details>

## Configure

The CLI does it in one line:

```bash
amp mcp add watch-skill -- uvx --from "watch-skill[standard]" watch-skill serve
```

Or edit settings directly. Amp namespaces its servers under `amp.mcpServers`
rather than the bare `mcpServers` most clients use, so a block copied from
Cursor or Cline needs that key changed:

```json
{
  "amp.mcpServers": {
    "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"]
    }
  }
}
```

## Smoke test (3 steps)

1. Ask Amp: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me
   what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

- Amp also accepts remote servers as a `url`, which is what
  `watch-skill serve --http` exposes (port 8747, `/mcp`). Keep it on
  loopback or put a bearer token in front of it — see
  [Configuration](../configuration.md).
- The same settings key works in the CLI and the editor extensions; there is
  one server list, not two.
