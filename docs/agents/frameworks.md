# Framework adapters

<img src="../assets/agents/frameworks.webp" alt="Framework mascots collaborating around one video-analysis engine" width="360">

MCP already covers Claude Code/Desktop, Cursor, Cline, Windsurf, Codex,
Gemini CLI, and VS Code (see the per-agent guides in this directory). For
agent *frameworks*, Watch Skill ships thin native adapters — three tools
(`watch_video`, `ask_video`, `search_videos`) wrapping the same core calls.
Adapters never add logic; everything stays in the engine.

Install the engine plus the extra for your framework:

```bash
pip install "watch-skill[langchain]"     # or crewai / openai-agents / llamaindex / autogen
```

## LangChain / LangGraph

```python
from watch_skill.integrations.langchain import get_watch_tools

agent = create_agent(model, tools=get_watch_tools())
agent.invoke({"messages": [("user", "Watch https://youtu.be/… and summarize it")]})
```

Tools are `langchain_core` `StructuredTool`s — anything consuming
langchain-core tools (LangGraph included) uses them unchanged.
Runnable proof: `examples/09-framework-adapters/langchain_example.py`.

## CrewAI

```python
from watch_skill.integrations.crewai import get_watch_tools

analyst = Agent(role="video analyst", goal="answer questions about videos",
                backstory="…", tools=get_watch_tools())
```

Runnable proof: `examples/09-framework-adapters/crewai_example.py`.

## OpenAI Agents SDK

```python
from agents import Agent
from watch_skill.integrations.openai_agents import get_watch_tools

agent = Agent(name="video analyst", tools=get_watch_tools())
```

Runnable proof: `examples/09-framework-adapters/openai_agents_example.py`.

## LlamaIndex

```python
from watch_skill.integrations.llamaindex import get_watch_tools

agent = FunctionAgent(tools=get_watch_tools(), llm=llm)
```

Tools are `llama_index.core.tools.FunctionTool` objects
(verified against the LlamaIndex tools documentation; adapter unit-tested).

## AutoGen (v0.4+)

```python
from autogen_agentchat.agents import AssistantAgent
from watch_skill.integrations.autogen import get_watch_tools

agent = AssistantAgent(name="analyst", model_client=client, tools=get_watch_tools())
```

Tools are `autogen_core.tools.FunctionTool` objects
(verified against the AutoGen 0.4 tools documentation; adapter unit-tested).

## Vercel AI SDK (TypeScript) — via REST

The AI SDK is TypeScript, so it consumes Watch Skill over the REST surface.
Start the server (`watch-skill serve --http`, default port 8748) and define a
tool with `zod`:

```ts
import { generateText, tool } from "ai";
import { z } from "zod";

const askVideo = tool({
  description: "Ask a question about an indexed video; returns evidence with timestamps.",
  inputSchema: z.object({ video: z.string(), question: z.string() }),
  execute: async ({ video, question }) => {
    const res = await fetch("http://127.0.0.1:8748/v1/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video, question }),
    });
    return await res.json();
  },
});
```

(Verified against the Vercel AI SDK tool-calling documentation; the endpoint
contract is this repo's own REST surface — see below.)

## n8n — community node spec

Until a packaged community node ships, use the **HTTP Request** node against
the REST surface. A dedicated node should follow this spec:

- **Node**: `n8n-nodes-watch-skill`, credential = optional bearer token
  (`WATCHSKILL_API_BEARER_TOKEN`), base URL of a running `watch-skill serve --http`.
- **Operations** (one per resource):
  - `Watch` → `POST /v1/watch` `{source, start?, end?, max_frames?}` — returns
    `video_id` + report; long-running, so enable "retry on fail" off and a
    generous timeout.
  - `Ask` → `POST /v1/ask` `{video, question}` — retrieval-only evidence.
  - `Answer` → `POST /v1/answer` `{video, question}` — the self-healing
    answer with confidence + honest-floor flag.
  - `Search` → `GET /v1/search?q=…` — across every indexed video.
  - `Doctor` → `POST /v1/doctor` — health/bootstrap check.
- **Trigger node** (v0.8): the Monitor Loop's webhook/event system will emit
  events (`condition`, `detections[]`, `source`, timestamps) an n8n trigger
  can subscribe to; today the same data lands in `events.jsonl` under the
  monitor's loop directory and can be tailed with the local-file trigger.

## Everything else — REST/OpenAPI (the universal fallback)

Any framework that can call HTTP can use Watch Skill:

```bash
watch-skill serve --http           # OpenAPI schema at /docs and /openapi.json
```

Endpoints: `POST /v1/watch`, `POST /v1/ask`, `POST /v1/answer`,
`GET /v1/videos/{video}/moment`, `GET /v1/search`, `POST /v1/doctor`,
plus the loop family. The interactive schema at `/docs` is generated from
the same models the MCP tools use.
