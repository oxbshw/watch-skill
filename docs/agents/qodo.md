# Watch Skill in Qodo Command

<img src="../assets/agents/qodo.webp" alt="Qodo detective avatar inspecting video evidence" width="360">

**Status: doc-verified ☑** — config matches docs.qodo.ai; not executed
here.

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

Project-root `mcp.json` makes the server available to all your Qodo
agents:

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
