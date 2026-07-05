# AgentVision in Claude Code

**Status: machine-tested ✅** (this repo's MCP server runs registered in
Claude Code on the development machine; all tools exercised end-to-end).

## Install

```powershell
git clone https://github.com/oxbshw/agentvision && cd agentvision
uv sync --all-extras
uv run agentvision doctor        # bootstraps ffmpeg + yt-dlp
```

## Register the MCP server

```powershell
claude mcp add agentvision -- uv --directory "C:\path\to\agentvision" run agentvision serve
```

Or per-project via `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agentvision": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\agentvision", "run", "agentvision", "serve"]
    }
  }
}
```

`pip` install instead of a checkout? Use `"command": "agentvision", "args": ["serve"]`.

## Smoke test (3 steps)

1. Restart Claude Code, then run `/mcp` — `agentvision` should be listed as connected.
2. Ask: *"Use agentvision to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Ask a follow-up: *"Ask the same video what the bird is doing"* — it should answer via `ask_video` in seconds, without re-downloading.

## Notes

- Tool responses include frames as real images (Claude sees them inline),
  capped at 12 per response.
- The Claude Skill adapter (`adapters/claude-skill/`) offers `/watch` as a
  slash command on top of the same engine — see [that README](../../adapters/claude-skill/skills/watch/SKILL.md).
