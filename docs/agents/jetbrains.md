# Watch Skill in JetBrains IDEs

<img src="../assets/agents/jetbrains.webp" alt="JetBrains avatar among CRT monitors playing frames" width="360">

**Status: doc-verified ☑** — config matches JetBrains' own Junie and AI
Assistant MCP documentation; not executed here.

Covers Junie (IDE plugin and CLI) and AI Assistant across IntelliJ IDEA,
PyCharm, WebStorm, GoLand, and the rest of the family.

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

## Configure Junie

Junie reads the same JSON in the IDE plugin and the CLI. Project scope is
`.junie/mcp/mcp.json` in the repository root; global scope is
`~/.junie/mcp/mcp.json`, which is also what the *Tools → Junie → MCP
Settings* page writes.

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

Commit the project file to give a team the same video tools.

## Configure AI Assistant

*Settings → Tools → AI Assistant → Model Context Protocol → Add*, then paste
the same block. Local servers use `command` and `args`; the `url` form is for
remote servers, which is what `watch-skill serve --http` would be.

## Smoke test (3 steps)

1. Ask: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what
   happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

- Junie and AI Assistant keep separate MCP configuration. Setting one up
  does not configure the other.
- A remote setup is `watch-skill serve --http` (port 8747, `/mcp`), entered
  as a `url` rather than a command. Keep it on loopback or put a bearer
  token in front of it — see [Configuration](../configuration.md).
