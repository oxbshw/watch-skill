# ADR-006: Memory authority is the MemoryEvent ledger

- Status: Accepted
- Date: 2026-08-27

## Context

An agent that sees and hears but forgets is a tool, not a colleague. But
"memory" implemented as accumulating free text produces an opaque profile the
user cannot inspect, correct or delete, and a permanent target for injection.

## Decision

Three authorities stay separate:

| Authority | Owns | Does not own |
|---|---|---|
| DSH Context | what the current turn needs | long-term truth about the user or the world |
| Watch Core | source, observation, evidence, time, freshness, verdict | user identity or personalization policy |
| Watch Memory | knowledge, preferences, decisions, lessons, procedures | evidence truth, verification policy, system prompt, permissions |

The **MemoryEvent ledger is the legal source of truth** for every create,
edit, confirm, dispute, supersede, forget, import and promotion. Markdown
projections, full-text and vector indexes, and entity graphs are rebuildable
caches. Raw sources and evidence revisions remain immutable at Watch Core.

The unit is a typed `MemoryRecord` carrying kind, subject scope, scope id,
content, origin, source refs, evidence refs, confidence, status, sensitivity,
validity window, timestamps, supersession links, and original language.

Trust rules: a direct user statement outranks inference; a recent correction
supersedes an older inference immediately within the same scope; repetition
raises confidence but does not promote situational behavior to a global
preference; preferences carry contextual exceptions; sensitive or protected
traits are never inferred; and high confidence never grants a record authority
to change permissions, egress, or a financial or security action.

Memory never crosses `user / profile / workspace / project / session`
boundaries without an explicit policy. Retrieved pages, transcripts and
imported Markdown stay untrusted data and can never become system instructions
or an `explicit_user` record.

Implementation is a Cordis Host service in
`packages/watch/memory`, backed by SQLite locally with a storage adapter for
hosted and team deployments. No third process is created for memory alone, and
the existing Python media index is not ported to TypeScript.

## Release gates

Zero cross-user or cross-workspace leakage; provenance, scope, status and an
inclusion reason on every injected memory; correction taking effect on the next
turn; and `Forget` removing the record from retrieval, projections, indexes and
export.
