<!-- Copy this file to docs/agents/<your-agent>.md and replace every
     {{TOKEN}} below. `python scripts/validate_agent_docs.py` fails on any
     that are left, so a half-filled page cannot be merged. -->

# Watch Skill in {{AGENT_NAME}}

**Status: doc-verified ☑** — config matches {{AGENT_NAME}}'s official docs;
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

Config lives at `{{CONFIG_PATH}}`.

<!-- Give the user-level AND project-level paths if both exist. Then the
     exact block. Keep the fence language tag right (json/jsonc/toml/yaml)
     — validate_agent_docs.py parses it by that tag, and the block below
     must still parse once your values are in it. -->

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uv",
      "args": ["--directory", "{{WATCH_SKILL_CHECKOUT}}", "run", "watch-skill", "serve"]
    }
  }
}
```

## Smoke test (3 steps)

1. Open {{AGENT_NAME}}'s chat: *"Watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens
   at 0:10."*
2. Approve the `watch_video` tool call.
3. Follow up: *"what color is the bird?"* — should call `ask_video` and
   answer from the index without re-processing.

## Notes

<!-- Anything the next user will trip on: default MCP timeouts too short
     for a first watch, sandboxed runtimes that need ~/.watch-skill/
     mounted, image blocks not rendered, etc. -->
