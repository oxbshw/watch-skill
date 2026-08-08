# Watch Skill in Kilo Code

<img src="../assets/agents/kilocode.webp" alt="Kilo Code mechanic avatar repairing a filmstrip" width="360">

**Status: doc-verified ☑** — config matches the current kilo.ai docs;
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

Kilo v7+ reads one JSONC config for CLI, VS Code, and JetBrains alike:
global `~/.config/kilo/kilo.jsonc`, or per-project `kilo.jsonc` /
`.kilo/kilo.jsonc`. (The old extension-era `mcp_settings.json` is no
longer read — migrate if you still have one.)

```jsonc
{
  "mcp": {
    "watch-skill": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"],
      "enabled": true,
      "timeout": 300000 // ms; first watch of a long video is a real pipeline
    }
  }
}
```

The VS Code extension also has a UI path: Settings → MCP → Add Server →
Local (stdio).

## Smoke test (3 steps)

1. Open Kilo chat: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- Default MCP timeout is 10 s for local servers — far too short for a
  first watch. Set it as above or the pipeline gets killed mid-download.
