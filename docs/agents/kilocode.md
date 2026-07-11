# Watch Skill in Kilo Code

**Status: doc-verified ☑** — config matches the current kilo.ai docs;
not executed here.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

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
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"],
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
