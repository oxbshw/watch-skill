---
name: setup-watch-skill
description: One-shot setup for Watch Skill — installs the engine, bootstraps ffmpeg/yt-dlp, registers the MCP server in every detected AI agent (with backups), and configures the user's preferred vision provider. Run once after installing the plugin.
argument-hint: "[--provider <anthropic|openai|gemini|openrouter|ollama> | --skip-vision]"
allowed-tools: Bash, Read, AskUserQuestion
license: MIT
user-invocable: true
---

# /setup-watch-skill

Set up Watch Skill end-to-end so `/watch` and the `watch-skill` MCP tools work
in this agent and every other agent on the machine. Do the steps in order and
stop at the first hard failure, reporting the `fix` the tool prints.

## Step 1 — Ensure the engine is installed

Watch Skill's brains are the `watch-skill` Python CLI; this plugin is the thin
Claude Code surface. Check whether it's already on PATH:

```bash
watch-skill --version
```

If that fails, install it with **uv** (which also bootstraps its own Python —
no system Python needed). Prefer `uv`; fall back to `pipx`, then `pip`:

```bash
# preferred: isolated tool install straight from the repo
uv tool install "watch-skill[all] @ git+https://github.com/oxbshw/watch-skill" \
  || pipx install "watch-skill[all] @ git+https://github.com/oxbshw/watch-skill" \
  || pip install --user "watch-skill[all] @ git+https://github.com/oxbshw/watch-skill"
```

If `uv` itself is missing, install it first (`winget install astral-sh.uv` on
Windows, or `curl -fsSL https://astral.sh/uv/install.sh | sh` on macOS/Linux),
open a fresh shell so PATH updates, then re-run the install line above.

Re-run `watch-skill --version` and confirm it prints a version before going on.

## Step 2 — Self-healing doctor

```bash
watch-skill doctor
```

`doctor` downloads ffmpeg / yt-dlp into a managed bin dir on first run. Exit 0
means ready. If it reports fixes, let it apply them and re-run once. Only
surface a check to the user if it still fails after that.

## Step 3 — Register the MCP server in every agent

```bash
watch-skill setup --yes
```

This detects Claude Code, Claude Desktop, Cursor, Codex, Windsurf, and Gemini
CLI, backs up each config it touches, and writes the `watch-skill` MCP server
into all of them with a surgical merge (no existing keys are dropped). It
prints exactly which files it changed and where the backups are.

## Step 4 — Configure a vision backend (recommended)

Scene descriptions, visual verification, and the loop critic need a vision-capable
model. This choice is independent of the agent: every skill, MCP client, framework
adapter, and REST caller uses the same configured backend.

Respect an explicit provider choice. Cloud providers accept their own API key;
Ollama is the optional local path:

```bash
watch-skill setup-vision --provider anthropic --api-key <KEY>
watch-skill setup-vision --provider openai --api-key <KEY>
watch-skill setup-vision --provider gemini --api-key <KEY>
watch-skill setup-vision --provider openrouter --api-key <KEY>
watch-skill setup-vision --provider ollama
```

Use `--model <name>` when the user wants the same vision model for both tiers, or
`--cheap-model` and `--strong-model` to route bulk perception and final verification
separately. Never ask the user to paste a key into chat when it can be read from a
local environment variable or entered directly in their terminal.

If no choice was given, ask which supported provider they already use; do not steer
them toward Ollama or any one vendor. `--skip-vision` remains valid because
transcription, OCR, indexing, and search work without a model provider.

## Step 5 — Report

Print a short summary: engine version, doctor status, which agents were
configured (and their backup paths), the chosen vision backend, and this
next step:

> Restart your agents, then try:  **/watch** `<any video URL>`  — or just say
> "watch this video: …" to use the MCP tools directly.
