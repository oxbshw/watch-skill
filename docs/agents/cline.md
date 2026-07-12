# Watch Skill in Cline (VS Code extension)

<img src="../assets/agents/cline.webp" alt="Cline explorer avatar pinning video evidence to a board" width="360">

**Status: config verified against official docs, not machine-tested ☑**
(Cline is not installed on the development machine — please report issues.)

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Cline → MCP Servers icon → *Configure MCP Servers*, which opens
`cline_mcp_settings.json`. Add:

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"],
      "disabled": false,
      "autoApprove": ["ask_video", "search_videos", "list_videos", "get_moment"]
    }
  }
}
```

`autoApprove` keeps the read-only retrieval tools frictionless; leave
`watch_video`/`capture`/`loop_*` on manual approval.

## Smoke test (3 steps)

1. The MCP Servers panel should show `watch-skill` with a green status.
2. Chat: *"Use watch-skill to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
3. Follow up: *"ask that video what animal appears first"* → `ask_video`.
