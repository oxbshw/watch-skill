# Watch Skill in OpenCode

**Status: doc-verified ☑** — config matches the official opencode.ai MCP
docs; not executed here.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Project: `opencode.json` in the repo root. Global:
`~/.config/opencode/opencode.json`. Local servers use `"type": "local"`
with the command as an array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "watch-skill": {
      "type": "local",
      "command": ["uv", "--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"],
      "enabled": true
    }
  }
}
```

## Smoke test (3 steps)

1. `opencode`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- `"enabled": false` parks the server without deleting the entry — handy
  when you want video tools only in certain projects (put the entry in
  the project `opencode.json` instead of the global one).
