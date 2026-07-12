# Watch Skill in Codex CLI (OpenAI)

<img src="../assets/agents/codex-cli.webp" alt="Codex CLI avatar feeding film through a command-line terminal" width="360">

**Status: machine-configured ◐** — config written by `watch-skill setup` on
a real machine; `codex mcp list` shows watch-skill enabled and the server
command answers MCP `initialize`. A full codex chat session was not run.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.watch-skill]
command = "uv"
args = ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]
```

(Codex CLI ≥ 0.20; older versions use the same table under `[mcp_servers]`.)

## Smoke test (3 steps)

1. `codex` → in the session run `/mcp` to confirm `watch-skill` is connected.
2. Prompt: *"Use watch-skill to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
3. Follow up: *"list the videos watch-skill has indexed"* → `list_videos`.

## Notes

- Codex consumes the text report (frame paths + transcript). The
  `adapters/agents-md/AGENTS.md` block teaches Codex when to reach for
  each tool — paste it into your repo's `AGENTS.md`.
