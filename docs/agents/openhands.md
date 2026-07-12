# Watch Skill in OpenHands

<img src="../assets/agents/openhands.webp" alt="OpenHands avatars inspecting a frame under a desk lamp" width="360">

**Status: doc-verified ☑** — config matches the official OpenHands MCP
docs; not executed here.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

OpenHands takes stdio MCP servers in `config.toml` under `[mcp]`
(or Settings → MCP in the UI):

```toml
[mcp]
stdio_servers = [
    {name="watch-skill", command="uv", args=["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]}
]
```

OpenHands' docs recommend MCP proxies for production reliability; direct
stdio is their documented path for local single-user setups, which is
exactly what a local video index is.

## Smoke test (3 steps)

1. Start a conversation: *"Watch
   https://www.youtube.com/watch?v=aqz-KE-bpKQ and tell me what happens
   at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- OpenHands often runs the agent inside a sandboxed runtime. The index
  lives under `~/.watch-skill/` of whatever environment runs the server —
  if the runtime is ephemeral, mount that path or the memory resets with
  the sandbox.
