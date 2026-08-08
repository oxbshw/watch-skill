# Watch Skill in Roo Code

**Status: doc-verified ☑** — config matches the official Roo Code MCP docs;
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

Roo Code reads two levels. Project scope is `.roo/mcp.json` in the repository
root; global scope is `mcp_settings.json`, reachable from the MCP panel. When
a server name appears in both, the project file wins.

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

Commit `.roo/mcp.json` to give a whole team the same video tools.

## Smoke test (3 steps)

1. Ask Roo: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me
   what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- Roo substitutes `${env:VAR}` when it loads the config, so a provider key
  can be referenced instead of pasted:
  `"env": {"WATCHSKILL_ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}"}`.
- Add `watch_video` and `ask_video` to `alwaysAllow` once you trust them; the
  loop tools are worth leaving on manual approval, since `loop_video_gen` and
  `loop_game` run commands you supply (see [SECURITY.md](../../SECURITY.md)).
