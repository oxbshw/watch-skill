# Watch Skill in Zed

<img src="../assets/agents/zed.webp" alt="Zed avatar sprinting with a trail of film frames" width="360">

**Status: doc-verified ☑** — config matches Zed's official context-server
docs; not executed here.

Zed calls MCP servers **context servers**, and the settings key is
`context_servers` rather than `mcpServers`. The shape differs from every
other client in this matrix, so copying a Cursor or Cline block here will not
work.

## Install

```bash
uvx --from "watch-skill[standard]" watch-skill doctor
```

`uvx` fetches the package on first use and needs no checkout. Prefer a
permanent install? `pipx install "watch-skill[standard]"`, then use
`"path": "watch-skill"` with `"args": ["serve"]` below.

<details>
<summary>From source instead (contributors)</summary>

```bash
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

</details>

## Configure

Open settings with `cmd+,` (macOS) or edit the file directly:
`~/.config/zed/settings.json`, or `%APPDATA%\Zed\settings.json` on Windows.

```json
{
  "context_servers": {
    "watch-skill": {
      "source": "custom",
      "command": {
        "path": "uvx",
        "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"],
        "env": {}
      }
    }
  }
}
```

Zed restarts the context-server process when the file is saved, so there is
no need to restart the editor.

## Smoke test (3 steps)

1. Open the agent panel and ask: *"Watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at
   0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

- Zed's native `context_servers` speaks **stdio only**. `watch-skill serve
  --http` will not attach here; use the default stdio form above.
- Provider keys belong in the `env` block if you do not want them in a shell
  profile — Zed passes it to the spawned process.
- Nothing about vision is required to start: transcription, OCR, indexing,
  and search all run locally with no key.
