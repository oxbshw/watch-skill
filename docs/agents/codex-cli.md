# AgentVision in Codex CLI (OpenAI)

**Status: machine-configured ◐** — config written by `agentvision setup` on
a real machine; `codex mcp list` shows agentvision enabled and the server
command answers MCP `initialize`. A full codex chat session was not run.

## Install

```powershell
git clone https://github.com/oxbshw/agentvision && cd agentvision
uv sync --extra all
uv run agentvision doctor
```

## Configure

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agentvision]
command = "uv"
args = ["--directory", "C:\\path\\to\\agentvision", "run", "agentvision", "serve"]
```

(Codex CLI ≥ 0.20; older versions use the same table under `[mcp_servers]`.)

## Smoke test (3 steps)

1. `codex` → in the session run `/mcp` to confirm `agentvision` is connected.
2. Prompt: *"Use agentvision to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
3. Follow up: *"list the videos agentvision has indexed"* → `list_videos`.

## Notes

- Codex consumes the text report (frame paths + transcript). The
  `adapters/agents-md/AGENTS.md` block teaches Codex when to reach for
  each tool — paste it into your repo's `AGENTS.md`.
