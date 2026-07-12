---
name: configuring-vision
version: "1.0.0"
description: The user wants to connect an LLM or vision provider, already has an API key, asks "can I use OpenAI/Anthropic/Gemini/OpenRouter", wants local Ollama, or needs different cheap and strong models. Use this to configure provider-neutral visual understanding without tying Watch Skill to one agent or model vendor.
license: MIT
user-invocable: true
allowed-tools: Bash, Read
---

# Configuring vision

Watch Skill's agent surface and model backend are separate choices. Claude Code,
Codex, Cursor, OpenClaw, framework agents, and REST clients all call the same engine;
the engine can send selected frames to any supported vision provider.

## Supported providers

```bash
watch-skill setup-vision --provider anthropic --api-key <KEY>
watch-skill setup-vision --provider openai --api-key <KEY>
watch-skill setup-vision --provider gemini --api-key <KEY>
watch-skill setup-vision --provider openrouter --api-key <KEY>
watch-skill setup-vision --provider ollama
```

Prefer a key the user already has. Do not claim Ollama is required, and do not ask
the user to reveal a secret in chat. They can set the matching environment variable
or run the command privately in their terminal.

## Route bulk work and verification separately

One model can serve both tiers:

```bash
watch-skill setup-vision --provider openai --api-key <KEY> --model <vision-model>
```

Or use a cheaper model for scene descriptions and a stronger model for uncertain
answers and loop critiques:

```bash
watch-skill setup-vision --provider openrouter --api-key <KEY> \
  --cheap-model <fast-vision-model> --strong-model <strong-vision-model>
```

Add `--verify` to make one live probe call. If it fails, report the structured error
and its `fix`; never echo the key.

## No provider is also valid

Without a vision API, Watch Skill still acquires video, reads captions, runs local
transcription and OCR, indexes evidence, and searches it. Visual synthesis degrades
to timestamped evidence instead of guessing.
