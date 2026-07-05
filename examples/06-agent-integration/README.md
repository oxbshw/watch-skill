# 06 — Agent integration (MCP + REST)

Wire Watch Skill into an agent you are building. Regular users never need
this — `watch-skill setup` configures every supported agent automatically
(see [docs/agents/](../../docs/agents/README.md)); this example is for
agent **builders**.

`agent_integration.py` drives the MCP server exactly the way an agent
framework does: connect, discover the 13 tools, call them. It uses the
in-process FastMCP client (same protocol as a spawned stdio server), so it
runs offline against whatever is already indexed.

## Run

```
uv run --no-sync python examples/06-agent-integration/agent_integration.py
```

## Example output

Real run on this machine (trimmed):

```
connected: 13 tools exposed
  - watch_video: FIRST LOOK at any video — use when given a video you have NOT analyzed
  - ask_video: ANY follow-up question about a video you (or anyone) already watched —
  - get_moment: Zoom into ONE SPECIFIC MOMENT of an indexed video — use when the user
  ...

--- list_videos ---
# Indexed videos

- `4b0f48e4f4ae6e02` — Me at the zoo (00:19, transcript: captions, analyzed 2026-07-05 19:38:48)
...

--- stats ---
answers served: 21
tokens saved: ~140,462 vs raw-frame injection
```

## Wiring a real agent

**MCP over stdio** — what `watch-skill setup` writes; add it to any MCP
client yourself:

```json
{
  "mcpServers": {
    "watch-skill": {
      "command": "uv",
      "args": ["run", "--project", "/path/to/watch-skill", "watch-skill", "serve"]
    }
  }
}
```

**MCP over streamable HTTP** — for clients that prefer a URL:

```
watch-skill serve --http --port 8747      # then point the client at http://127.0.0.1:8747
```

**REST** — the universal adapter for non-MCP frameworks. Every MCP tool
has a REST twin ([mapping table](../../docs/tools/README.md#rest-twins)),
and the OpenAPI spec generates a client with zero custom code:

```
watch-skill api --port 8748
curl -X POST http://127.0.0.1:8748/v1/answer \
  -H "Content-Type: application/json" \
  -d '{"video": "4b0f48e4f4ae6e02", "question": "what animal appears?"}'
```

When exposing the API beyond localhost, set
`WATCHSKILL_API_BEARER_TOKEN` — the server refuses non-loopback binds
without it.
