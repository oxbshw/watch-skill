# Add your agent in ~20 minutes

Watch Skill speaks MCP (stdio + streamable HTTP), REST/OpenAPI, plain
CLI, and ships a SKILL.md skills library. If your agent can use any one
of those, it can watch video — the work is one config block and one doc
page.

## The 20 minutes

1. **Find the surface.** Your agent's CURRENT docs (not memory, not a
   blog from last year): does it have MCP config? A skills directory?
   Neither → it gets the `AGENTS.md` or REST recipe.
2. **Copy the skeleton.** `docs-skeleton.md` → `docs/agents/your-agent.md`.
   Fill in the config paths and the exact block. Keep the fence language
   tag accurate (`json`/`jsonc`/`toml`/`yaml`).
3. **Validate.**

   ```powershell
   python templates/agent-adapter/validate.py docs/agents/your-agent.md
   ```

   Zero broken blocks or the PR check fails.
4. **Grade honestly.** doc-verified ☑ if you only matched the docs;
   machine-configured ◐ if the agent's own tooling accepted the config
   on your machine; machine-tested ✅ only if you ran the 3-step smoke
   test in a real session. Say which in the PR.
5. **Add the matrix row** in `docs/agents/README.md`, keeping the table
   sorted roughly by surface type.

That's the whole contribution. If you machine-tested, paste the smoke
test transcript (or a screenshot) in the PR — it upgrades the row's
grade for everyone.

## Which config shape?

Most MCP agents use one of these three; check the docs page of a
similar agent in `docs/agents/` first:

- `mcpServers` JSON object (Claude Desktop, Cursor, Copilot CLI, Kimi,
  Qwen Code, Qodo, Agent Zero...)
- TOML section (Codex CLI, OpenHands)
- YAML extensions block (Goose)

Skills-directory agents (OpenClaw, Pi, Hermes-style) skip config
entirely — point them at `adapters/claude-skill/skills/`.
