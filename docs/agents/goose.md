# Watch Skill in Goose

**Status: doc-verified ☑** — config matches Block's official Goose docs;
not executed here.

Goose calls MCP servers "extensions"; a command-line extension is exactly
our stdio server.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

## Configure

Either run `goose configure` → *Add Extension* → *Command-line Extension*
and enter the command below, or add the block to
`~/.config/goose/config.yaml` yourself:

```yaml
extensions:
  watch-skill:
    name: Watch Skill
    type: stdio
    enabled: true
    cmd: uv
    args: ["--directory", "C:\\path\\to\\watch-skill", "run", "watch-skill", "serve"]
    timeout: 300
```

`timeout: 300` matters: a first `watch_video` on a long clip is a real
pipeline (download, frames, OCR, transcription), not a quick lookup.

## Smoke test (3 steps)

1. `goose session`, then: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ
   and tell me what happens at 0:10."*
2. Approve the `watch_video` call.
3. Follow up: *"what color is the bird?"* — should call `ask_video`, no
   re-processing.

## Notes

- Goose is model-agnostic; Watch Skill's report is plain text + image
  blocks, so any model Goose drives can read at least the text. Frame
  paths are in the text for models without vision.
