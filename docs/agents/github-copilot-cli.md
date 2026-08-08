# Watch Skill in GitHub Copilot CLI

<img src="../assets/agents/github-copilot-cli.webp" alt="GitHub Copilot CLI avatar winding a film reel beside a terminal" width="360">

**Status: doc-verified ☑** — config matches the official Copilot CLI docs;
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

Then run `watch-skill setup`, which writes the config pointing at your
checkout rather than the published package.

</details>

## Configure

Copilot CLI reads `~/.copilot/mcp-config.json` (user level) or
`.copilot/mcp-config.json` in the repo. `stdio` is the type to pick — it
keeps the entry compatible with VS Code and the Copilot cloud agent:

```json
{
  "mcpServers": {
    "watch-skill": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"]
    }
  }
}
```

There is also an interactive path: run `copilot`, then `/mcp add` and fill
in the same command. CLI flag `--additional-mcp-config` takes precedence
over both files if you want a one-off.

## Smoke test (3 steps)

1. `copilot`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
2. Approve the `watch_video` tool call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

- Repository-level config loads first; user-level extends/overrides it.
  Put watch-skill at user level once, use it in every repo.
- Set `COPILOT_HOME` if you keep your config somewhere non-default.
