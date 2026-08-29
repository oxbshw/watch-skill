# ADR-003: Two repositories, one product

- Status: Accepted
- Date: 2026-08-27

## Context

Watch Core is a Python engine with a PyPI release train, an MCP server, a REST
surface, a CLI and framework adapters. The Workspace is a TypeScript
distribution over DSH with an npm and desktop release train that follows
upstream's cadence. Forcing both into one repository couples release trains
that move at different speeds and makes Python consumers install hundreds of
Node packages.

## Decision

| Repository | Contents | Release train |
|---|---|---|
| `watch-skill` | Python Core, MCP, REST, CLI, contracts, Agent Skills, evals | PyPI / Core semver |
| `watch-workspace` | DSH downstream distribution, Watch DSH plugins, Memory service, Web, Desktop | npm / Desktop releases |

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
