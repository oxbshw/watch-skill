# 09 — Framework adapters (LangChain, CrewAI, OpenAI Agents SDK)

Watch Skill's tool belt (`watch_video`, `ask_video`, `search_videos`) as
native tools for agent frameworks. Adapters are thin by contract — every one
wraps the same three core calls; all logic stays in the engine. Full guide
(incl. LlamaIndex, AutoGen, Vercel AI SDK via REST, and the n8n node spec):
[docs/agents/frameworks.md](../../docs/agents/frameworks.md).

Each example builds a small local clip whose content exists only in its
pixels, watches + indexes it through the adapter's `watch_video` tool, then
asks a real question through `ask_video` — the exact call path an agent's
LLM uses once it picks the tool (bring your own model/API key to drive
selection automatically).

## Run

```
uv run --no-sync python examples/09-framework-adapters/langchain_example.py
uv run --no-sync python examples/09-framework-adapters/crewai_example.py
uv run --no-sync python examples/09-framework-adapters/openai_agents_example.py
```

Each needs its framework extra: `pip install "watch-skill[langchain]"` (or
`crewai` / `openai-agents`).

## Example output (real run on this machine)

```
tool: watch_video -> watching C:\...\release clip.mp4
video_id: 07b59c3ac03932af
title: release clip.mp4
duration: 00:03
frames indexed: 1

tool: ask_video -> What release version number is shown in the video?
confidence: 0.665
Evidence:
- [00:01] (ocr) RELEASE v3.14
...
LANGCHAIN ADAPTER: PASSED
```

All three examples were run live on this machine (CrewAI and the OpenAI
Agents SDK produce the same flow through their own tool objects).

For MCP clients and REST consumers, continue with
[06 — Agent integration](../06-agent-integration/). The
[example catalog](../README.md) lists every integration path.
