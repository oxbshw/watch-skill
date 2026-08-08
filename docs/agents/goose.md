# Watch Skill in Goose

<img src="../assets/agents/goose.webp" alt="Goose avatar carrying and stamping video evidence" width="360">

**Status: doc-verified ☑** — config matches Block's official Goose docs;
not executed here.

Goose calls MCP servers "extensions"; a command-line extension is exactly
our stdio server.

## Install

```bash
uvx --from "watch-skill[standard]" watch-skill doctor
```

`uvx` fetches the package on first use and needs no checkout. Prefer a
permanent install? `pipx install "watch-skill[standard]"`, then use
`"command": "watch-skill", "args": ["serve"]` in the config below.

<details>
<summary>From source instead (contributors)</summary>

```bash
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
```

Then run `watch-skill setup`, which writes the config pointing at your
checkout rather than the published package.

</details>

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
    cmd: uvx
    args: ["--from", "watch-skill[standard]", "watch-skill", "serve"]
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
