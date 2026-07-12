# Watch Skill in OpenClaw

<img src="../assets/agents/openclaw.webp" alt="OpenClaw lobster avatar cutting and splicing film" width="360">

**Status: doc-verified ☑** — matches the openclaw.ai skills docs; not
executed here.

OpenClaw's native extension surface is the same one we ship: directories
of `SKILL.md` files. No MCP config needed — the CLI-wrapping skills work
as-is.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
uv tool install .   # puts `watch-skill` on PATH, which the skills call
```

## Configure

Point OpenClaw's skill discovery at the skills library (it scans any
configured root for `SKILL.md`, up to 6 levels deep). In your OpenClaw
config, under `skills.load`:

```json
{
  "skills": {
    "load": {
      "extraDirs": ["C:\\path\\to\\watch-skill\\adapters\\claude-skill\\skills"]
    }
  }
}
```

That picks up all of them: `watching-videos`, `asking-with-evidence`,
`the-loop`, `learning-from-mistakes`, `extracting-structure`,
`video-memory`, `sharing-results`, `configuring-vision`,
`recovering-from-errors`, plus `/watch`.

## Smoke test (3 steps)

1. Ask: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ — what
   happens at 0:10?"* — the `watching-videos` skill should fire and run
   `watch-skill watch`.
2. Check the reply cites `t=MM:SS` timestamps from the report.
3. Follow up: *"what color is the bird?"* — the `asking-with-evidence`
   skill should run `watch-skill ask`, not re-watch.

## Notes

- Our frontmatter carries `name`, `description`, `version`, `license`,
  `allowed-tools`. OpenClaw ignores keys it doesn't know; the trigger
  description is what matters.
- The skills call the `watch-skill` CLI, so the `uv tool install .` step
  (or `pip install watch-skill`) is what makes them portable here.
