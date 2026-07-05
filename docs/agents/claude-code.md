# Watch Skill in Claude Code

**Status: machine-tested ✅** (this repo's MCP server runs registered in
Claude Code on the development machine; all tools exercised end-to-end.
Last live run 2026-07-06: the `/watch` skill adapter processed a real
7-minute YouTube video inside a Claude Code session — doctor green,
25 scene-aware frames, OCR on 24, captions transcript, indexed for
follow-ups — with no manual intervention).

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor        # bootstraps ffmpeg + yt-dlp
```

## Register the MCP server

```powershell
claude mcp add watch-skill -- uv --directory "C:\path\to\watch-skill" run watch-skill serve
```

Or per-project via `.mcp.json` in your project root:

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

`pip` install instead of a checkout? Use `"command": "watch-skill", "args": ["serve"]`.

## Smoke test (3 steps)

1. Restart Claude Code, then run `/mcp` — `watch-skill` should be listed as connected.
2. Ask: *"Use watch-skill to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens at 0:10."*
3. Ask a follow-up: *"Ask the same video what the bird is doing"* — it should answer via `ask_video` in seconds, without re-downloading.

## Notes

- Tool responses include frames as real images (Claude sees them inline),
  capped at 12 per response.
- The Claude Skill adapter (`adapters/claude-skill/`) offers `/watch` as a
  slash command on top of the same engine — see [that README](../../adapters/claude-skill/skills/watch/SKILL.md).
