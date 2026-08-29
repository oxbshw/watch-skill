# ADR-007: `taste.md` is a projection, not a prompt

- Status: Accepted
- Date: 2026-08-27

## Context

A free-text file the agent edits about the user is the fastest route to
personality drift, unexplainable behavior, and durable prompt injection. It is
also the most tempting shortcut.

## Decision

`taste.md` is a **materialized, human-readable view of structured preference
records**. It is not a database, not a system prompt, and not a file the agent
rewrites at will.

- Every entry shows scope, confidence, origin, source, last-confirmed date and
  status, and keeps explicit and inferred preferences visually separate.
- The user can Confirm, Edit, Reject, Forget or Move Scope on any entry.
- The agent may not move a high-impact preference to `active` without approval.
- The file never stores secrets or raw sensitive content.
- It is never injected wholesale into a system prompt; the Context Compiler
  selects the minimum useful packet and records why each item was included.
- A human edit to the Markdown is read as a diff, validated, and applied as a
  `USER_EDIT` event; the projection is then regenerated. The ledger is never
  overwritten silently.

`identity.md` describes the agent's intended identity and constraints. It
changes by version and approval, never by accumulating the mood of the last
session.

Activation policy by record type:

| Type | Behavior |
|---|---|
| explicit, low risk | active after visible confirmation or a direct instruction |
| inferred, low risk | proposed, then auto-active above a tunable threshold |
| contextual | project-scoped only |
| sensitive or high impact | never auto-activated; explicit approval per policy |
| protected-trait inference | prohibited by default |

## Interoperability

Obsidian and LLM Wiki are optional adapters over the Markdown projection. They
may open, export, backlink and import; they may never mint evidence, become a
runtime dependency, or turn memory edits into commands.
