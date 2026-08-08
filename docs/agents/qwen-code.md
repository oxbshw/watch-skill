# Watch Skill in Qwen Code

<img src="../assets/agents/qwen-code.webp" alt="Qwen Code avatar assembling frames into a timeline" width="360">

**Status: doc-verified ☑** — config matches the official Qwen Code docs;
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

Global: `~/.qwen/settings.json`. Project: `.qwen/settings.json` in the
repo. Servers go under the top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"],
      "timeout": 300000
    }
  }
}
```

`timeout` is in milliseconds here — 300000 gives a first `watch_video`
on a long clip room to finish.

## Smoke test (3 steps)

1. `qwen`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and
   tell me what happens at 0:10."*
2. Approve the `watch_video` call. `/mcp` inside the session shows the
   server and its tools if you want to check first.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- If you use `mcp.allowed` in settings to pin the server list, add
  `"watch-skill"` to it — otherwise the server is configured but never
  connected.
