# Working on Watch Skill

Read this before changing anything. It is the short version of
[CONTRIBUTING.md](CONTRIBUTING.md) and the rules in
[docs/DECISIONS.md](docs/DECISIONS.md).

## What this project is

A local-first video layer for AI agents. It turns video into a persistent,
searchable index with timestamped evidence, and closes a capture → critique →
fix → proof loop over an agent's own work. Python 3.11+, MIT.

## Layout

| Path | What lives there |
|---|---|
| `src/watch_skill/` | The engine. All logic. |
| `src/watch_skill/surfaces/` | MCP, CLI, REST. Thin wrappers only. |
| `skills/` | The ten agent skills. Canonical location — the skills CLI reads it. |
| `commands/` | Slash commands for the Claude Code plugin. |
| `adapters/` | Framework and harness adapters. No engine logic. |
| `tests/` | Mirrors the `src/` layout. |
| `docs/agents/` | One page per supported agent, each with an honest status. |

## Commands

```bash
uv sync --extra all              # full dev environment
uv run pytest -m "not network"   # the offline suite — must be green
uv run ruff check .              # lint
uv run watch-skill doctor        # check the binaries the engine needs
```

Tests marked `network` hit the real internet and are excluded from the merge
gate. Do not add network calls to the offline suite.

## Rules that are not negotiable

- **The engine is agent-agnostic.** No harness-specific branching in
  `src/watch_skill/`. That belongs in `adapters/` or a skill.
- **Surfaces stay thin.** MCP, CLI, and REST wrap the same functions. A
  behaviour that exists in one and not the others is a bug.
- **Every bug fix ships a regression test**, and the test must fail against
  the old code. Verify that; do not assume it.
- **Index changes are forward migrations.** Never rewrite history in the
  schema; add a migration.
- **MCP tool names are a contract.** Renaming one breaks every configured
  agent. Add, don't rename.
- **Privacy invariants are tested** in `tests/test_privacy.py` and listed in
  [SECURITY.md](SECURITY.md). The video never leaves the machine; no cookies
  or logins; cloud speech-to-text is opt-in. Breaking one is a security bug.
- **Every network or provider boundary asks the policy first.** Call
  `policy.guard_egress(...)` before the request is built and before a key is
  read. Constructing a provider client and going around it is a security bug,
  not a shortcut. `tests/test_policy.py` runs the engine with every provider
  key set and asserts offline mode leaks nothing.
- **Identity is the bytes.** Never key an artifact off a source string. New
  content is a new revision (`watch_skill.identity`); a source string resolves
  through the alias table. A read that presents stored artifacts as current
  evidence goes through `store.require_current` first.
- **Absent evidence is never a pass.** No frames, no OCR, an unreachable
  model, a timed-out check — all `inconclusive`. If you add a code path that
  can end in a verdict, the failure branch is `inconclusive` or `error`, and
  it ships with a test that proves it.
- **Say "proof" only when required deterministic checks passed and the
  attestation verifies.** Otherwise it is evidence, a before/after comparison,
  or an advisory visual verdict. Never describe a hash as a signature.
- **Errors carry a `fix`.** Every raised `WatchSkillError` needs a code and a
  sentence telling the reader what to do. `tests/test_error_fix_audit.py`
  enforces it.
- **Claims are checked.** Prices live in a dated `prices.json`; benchmark
  numbers come from a recorded run; an agent page says whether it was
  machine-tested or only doc-verified. Do not write a claim you have not
  verified, and do not upgrade a status you did not earn.

## Adding things

- **A vision provider**: an entry in `src/watch_skill/vision/registry.py`.
  If it speaks OpenAI's `/chat/completions`, use `_openai_compatible(...)` and
  write no request code. Add the model defaults to
  `health/vision_setup.py` and a price to `vision/prices.json` — moving that
  file's `as_of` date is part of the edit.
- **An agent**: start from `templates/agent-integration/`. One config block, one
  page in `docs/agents/`, one validation run.
- **A skill**: a directory under `skills/` with a `SKILL.md`. The
  `description` is a trigger surface — write the phrasings a user would
  actually type, not a summary.

## Commits

A conventional prefix, then a plain declarative subject saying what changed
and why — not what you did to find out.

- Author each commit with the human identity accountable for the change.
- Describe the product change and the reason for it. Nothing else belongs in
  a commit message.
- Keep the `Co-Authored-By` trailers of real human co-authors.
- Do not add co-author trailers for anything that is not a person, and do not
  add generated-by notices.

`npm run verify:commits` (in `workspace/`) checks commit metadata on a branch
and fails on any of the above. It reads authorship and trailers only — it does
not police prose, and product documentation about supported integrations is
unaffected by it.

Do not rewrite shared history unless the maintainer has asked you to.

## Style

Match the file you are editing. Comments explain *why*, never *what*. If a
line needs a comment to say what it does, rewrite the line.
