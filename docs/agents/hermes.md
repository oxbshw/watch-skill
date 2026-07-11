# Watch Skill in Hermes Agent (and Hermes-style harnesses)

**Status: doc-verified ☑** — matches the hermes-agent docs; not executed
here.

Hermes Agent (Nous Research) and harnesses like it extend through
skills — instruction files over CLI tools — rather than a plugin store.
Watch Skill's skills library is exactly that shape.

## Install

```powershell
git clone https://github.com/oxbshw/watch-skill && cd watch-skill
uv sync --extra all
uv run watch-skill doctor
uv tool install .   # `watch-skill` on PATH for the skills to call
```

## Configure

Two working paths, pick one:

**Skills.** Add the library to the harness's skills directory (Hermes
bundles skills as directories with instruction files; copy or symlink
ours):

```
adapters/claude-skill/skills/  →  your hermes skills dir
```

**AGENTS.md.** Hermes-style harnesses read repo instructions. Drop
[`adapters/agents-md/AGENTS.md`](../../adapters/agents-md/AGENTS.md)
into the project root — it teaches any instruction-following agent the
full CLI contract (watch → ask → loop) with no client support needed at
all.

For a networked setup, Hermes exposes an OpenAI-compatible endpoint and
can call HTTP tools; run `watch-skill api` and use the REST recipe in
[frameworks.md](frameworks.md) (OpenAPI at `/openapi.json`).

## Smoke test (3 steps)

1. Ask: *"Watch https://www.youtube.com/watch?v=aqz-KE-bpKQ — what
   happens at 0:10?"* — the agent should run `watch-skill watch`.
2. Check for `t=MM:SS` citations in the answer.
3. Follow up about the same video — expect `watch-skill ask`, not a
   re-watch.

## Notes

- This page doubles as the recipe for any agent whose only extension
  points are "instructions + a shell": skills dir if it has one,
  `AGENTS.md` if it doesn't, REST if it can't even shell out.
