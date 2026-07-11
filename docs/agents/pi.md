# Watch Skill in Pi

**Status: doc-verified ☑** — matches the pi-coding-agent docs; not
executed here.

Pi deliberately ships no MCP client ("MCP servers are overkill for most
use cases" — their words, and for a CLI-first tool they have a point).
Pi's native extension surface is skills: CLI tools with instructions.
Watch Skill is a CLI, so this is the honest path — no adapter code.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
uv tool install .   # `watch-skill` on PATH — Pi skills shell out to it
```

## Configure

Add the skills library as a Pi skills directory — the SKILL.md files
document the CLI exactly the way Pi skills expect:

```
pi --skills-dir C:\path\to\watch-skill\adapters\claude-skill\skills
```

(or add the directory to your Pi settings' skills paths; Pi also loads
skills from packages, so a `pi package` wrapping the same directory
works for sharing.)

Prefer MCP anyway? The third-party `pi-mcp-adapter` extension adds MCP
client support to Pi; feed it the standard entry:

```json
{
  "mcpServers": {
    "watch-skill": { "command": "watch-skill", "args": ["serve"] }
  }
}
```

## Smoke test (3 steps)

1. `pi "Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ - what happens at 0:10?"`
2. Pi should run `watch-skill watch ...` per the skill instructions and
   answer with timestamps.
3. Follow up with a question about the same video — the skill directs it
   through `watch-skill ask`, not a re-watch.

## Notes

- `watch-skill ask` prints text-first evidence, so Pi's no-vision setups
  still get grounded answers; frame paths are in the output when looking
  is warranted.
