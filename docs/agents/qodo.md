# Watch Skill in Qodo Command

**Status: doc-verified ☑** — config matches docs.qodo.ai; not executed
here.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Project-root `mcp.json` makes the server available to all your Qodo
agents:

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

Then reference it from an agent's TOML under its `tools` section, e.g.
a QA agent that reviews screen recordings:

```toml
[commands.review_recording]
description = "Watch a screen recording and produce a bug report"
instructions = """
Watch the given recording with watch_video, then call extract_bug_report
and present the result with timestamps.
"""
tools = ["watch-skill"]
```

## Smoke test (3 steps)

1. `qodo chat`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- An agent-specific server (not shared) can live in that agent's TOML
  instead of the shared `mcp.json` — same fields.
