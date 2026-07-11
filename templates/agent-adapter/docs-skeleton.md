# Watch Skill in YOUR-AGENT

**Status: doc-verified ☑** — config matches YOUR-AGENT's official docs;
not executed here.
<!-- Grades: machine-tested ✅ (you ran a chat session end-to-end) /
     machine-configured ◐ (config written + agent's own tooling accepts it)
     / doc-verified ☑ (matches current official docs). Pick honestly —
     reviewers will ask what you ran. -->

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

<!-- Where does the config live? User-level AND project-level paths if
     both exist. Then the exact block. Keep the fence language tag right
     (json/jsonc/toml/yaml) — validate.py parses it by that tag. -->

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]
    }
  }
}
```

## Smoke test (3 steps)

1. Open YOUR-AGENT's chat: *"Watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens
   at 0:10."*
2. Approve the `watch_video` tool call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

<!-- Anything the next user will trip on: default MCP timeouts too short
     for a first watch, sandboxed runtimes that need ~/.watch-skill/
     mounted, image blocks not rendered, etc. -->
