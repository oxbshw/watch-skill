# AgentVision in Gemini CLI

**Status: config verified against official docs, not machine-tested ☑**
(Gemini CLI is not installed on the development machine — please report issues.)

## Install

```powershell
git clone https://github.com/agentvision/agentvision && cd agentvision
uv sync --all-extras
uv run agentvision doctor
```

## Configure

Edit `~/.gemini/settings.json` (create it if missing):

```json
{
  "mcpServers": {
    "agentvision": {
      "command": "uv",
      "args": ["--directory", "C:\\path\\to\\agentvision", "run", "agentvision", "serve"],
      "timeout": 600000
    }
  }
}
```

The generous `timeout` matters: first-time `watch_video` on a long video can
exceed Gemini CLI's default tool timeout.

## Smoke test (3 steps)

1. `gemini` → `/mcp` should list `agentvision` and its tools.
2. Prompt: *"Use agentvision to watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
3. Follow up: *"ask that video what appears at the end"* → `ask_video`.
