# ADR-008: Self-learning is governed by evaluation and promotion

- Status: Accepted
- Date: 2026-08-27

## Context

Continuous improvement is a real product requirement. Ungoverned
self-modification is a security and correctness failure that is very hard to
detect after the fact, because the system that changed is also the system
reporting on the change.

## Decision

The agent may **propose**. It may not **promote**.

Candidate kinds the agent may create: `LessonCandidate`,
`RoutingRuleCandidate`, `PromptPatchCandidate` (non-governing templates only),
`SkillPatchCandidate`, `WorkflowCandidate`, and `EvalCase` (after redaction).

Every promotion passes:

```
Candidate
→ isolated branch or sandbox
→ replay on approved fixtures
→ compare quality, cost, latency, safety
→ reviewer or signed policy approval
→ versioned activation
→ canary and rollback
```

The agent may never change, on its own: the system prompt, verification
authority, a permission preset, a plugin trust tier, production code, signing
keys, or retention policy.

In v1, "learning" means auditable improvement to memory, routing and skills. It
does not mean gradient training on user data, and automatic fine-tuning is out
of scope.

Subagents inherit a limited read scope; their default mutation capability is
propose-only.

## Release gate

A release is blocked if the agent can modify system policy, permissions or a
production skill without passing the promotion gate, and if a candidate that
fails evaluation can still be promoted or cannot be rolled back.
