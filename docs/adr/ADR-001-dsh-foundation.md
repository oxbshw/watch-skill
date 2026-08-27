# ADR-001: DeepSeek Harness is the long-term agent foundation

- Status: Accepted
- Date: 2026-08-27
- Baseline: `deepseek-ai/deepseek-harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`0.1.1-rc.2`)

## Context

Watch Skill owns a mature perception, evidence and verification engine in
Python, and a narrow web surface that is not an agent workspace. Building an
agent runtime, session model, context lifecycle, provider UX, plugin system and
workspace shell from scratch would consume the entire engineering budget and
compete with a project that already does all of it well.

The source audit at the pinned commit found 247 workspace packages, a Cordis
plugin runtime with Host and Client halves, 44 UI extension slots, profile
bundle installation through the CLI, and a published npm release of every
package at the pinned version.

## Decision

DeepSeek Harness is the agent foundation for the Watch product, not a temporary
shell and not a visual reference. Watch consumes DSH as **pinned published npm
packages**, never as a fork.

Consequences that follow directly:

1. There is no roadmap phase for replacing DSH subsystems. A replacement
   requires a proven Watch requirement, an inadequate extension seam, a
   benchmarked alternative with migration and rollback, and its own ADR.
2. Watch does not build a parallel agent loop, plugin runtime or model gateway.
3. Watch code lives in separate packages composed through Cordis and slots.
   A direct upstream patch is permitted only where no extension seam exists,
   and carries a failing test, an ADR and a removal plan. The current patch
   budget is zero.
4. Removing a dependency is not a success metric. The success metric is the
   quality of verified outcomes.

## Rejected alternatives

- **Fork the monorepo.** Sync cost grows without bound and every upstream
  security fix becomes a merge. The npm release removes the need entirely.
- **Reimplement the workspace in Next.js on top of the existing Watch UI.**
  This is the position the product is moving away from: it produces a chat
  window beside a video player, not an evidence-native workspace.
- **Wait for full parity before any Watch integration.** Closing hundreds of
  packages before the first value slice risks building a shell with no product.

## Revisit trigger

Loss of the Cordis loader or the client extension seams, or a sustained sync
cost above the agreed patch budget across two release periods.
