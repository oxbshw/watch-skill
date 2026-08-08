# Watch Skill in Gemini CLI

<img src="../assets/agents/gemini-cli.webp" alt="Gemini CLI avatar comparing two projected film frames" width="360">

**Status: config verified against official docs, not machine-tested ☑**
(Gemini CLI is not installed on the development machine — please report issues.)

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

Edit `~/.gemini/settings.json` (create it if missing):

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"],
      "timeout": 600000
    }
  }
}
```

The generous `timeout` matters: first-time `watch_video` on a long video can
exceed Gemini CLI's default tool timeout.

## Smoke test (3 steps)

1. `gemini` → `/mcp` should list `watch-skill` and its tools.
2. Prompt: *"Use watch-skill to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
3. Follow up: *"ask that video what appears at the end"* → `ask_video`.
