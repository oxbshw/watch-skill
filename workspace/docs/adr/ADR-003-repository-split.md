# ADR-003: Two repositories, one product

- Status: Superseded by [ADR-010](ADR-010-single-repository.md)
- Date: 2026-08-27
- Superseded: 2026-08-29

> The two repositories became one. What this ADR decided, and why, is
> left as written; ADR-010 records what replaced it and what the split
> cost that this document did not anticipate.

## Context

Watch Core is a Python engine with a PyPI release train, an MCP server, a REST
surface, a CLI and framework adapters. The Workspace is a TypeScript
distribution over DSH with an npm and desktop release train that follows
upstream's cadence. Forcing both into one repository couples release trains
that move at different speeds and makes Python consumers install hundreds of
Node packages.

## Decision

| Half | Contents | Release train |
|---|---|---|
| Watch Skill | Python Core, MCP, REST, CLI, contracts, Agent Skills, evals | PyPI / Core semver |
| DeepWatch | DSH downstream distribution, Watch DSH plugins, Memory service, Web, Desktop | npm / Desktop releases |

**Status: the release trains are split; the repositories are not.** Both
halves live in `oxbshw/watch-skill` today — the Python Core at the root and
DeepWatch under `workspace/` — and each ships on its own train from its own
tag prefix. What this ADR decides is the *boundary*, which is enforced whether
or not the directories ever move: no import crosses it, the contract is a
versioned schema rather than a shared type, and each half builds and tests
without the other. Splitting the directories later is then a move, not a
redesign. Nothing in this document should be read as naming a repository that
exists.

`watch-skill` is the semantic source of truth for Watch contracts. It emits
versioned JSON Schema; `watch-workspace` generates TypeScript from that schema
and validates at the Node boundary. The schema digest travels in the Bridge
handshake, so a mismatch is a negotiated, visible failure rather than a runtime
surprise.

Packages under `packages/watch/` compose into all three surfaces — Web,
Desktop, and the installable `Watch for DSH` bundle. Building a separate
implementation per surface requires an ADR justifying why the capability cannot
be composed from one source.

## Consequences

- The Python engine keeps running headless with no Node present, and DSH keeps
  booting with no Watch present. Both directions are tested.
- Upstream sync and Watch feature work never share a pull request.
- The upstream checkout under `upstream/deepseek-harness/` is script-managed,
  git-ignored, and used only for audit and inventory generation.
