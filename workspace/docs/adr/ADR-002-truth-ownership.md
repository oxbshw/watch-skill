# ADR-002: Watch Core is the only issuer of evidence and verdicts

- Status: Accepted
- Date: 2026-08-27

## Context

The product's entire claim is that it can answer "did this actually work?"
independently of what the agent says. That claim is worth nothing if any
plugin, client, or model can assert success. The failure mode is not a bug; it
is the product ceasing to mean anything.

## Decision

`EvidenceRecord` and verification `Verdict` are produced by Watch Core alone.

- A plugin — including a first-party Watch plugin — emits a *candidate
  observation* or a *verification request*. It never emits `verified: true` as
  a fact.
- Watch Core validates source revision, artifact digest, clock, freshness and
  policy before minting a record.
- A model-based verifier is an input to a contract, never the authority. A
  deterministic contract plus Watch policy remains the authority.
- The client renders; it does not decide.

```
Plugin output          → candidate
Watch Core validation  → EvidenceRecord
Verification contract  → Verdict
Client rendering       → presentation only
```

Agent execution state, evidence health and verification state are three
separate state machines in the data model and in the UI. `Agent: completed`
with `Verification: UNVERIFIED` is a normal, honestly-rendered outcome and is
never shown as green. Green is reserved for `VERIFIED` and for deterministic
success with no ambiguity.

`confidence` never substitutes for a verdict. A confidence of 0.99 does not
turn `UNVERIFIED` into `VERIFIED`.

## Consequences

- The verification endpoint rejects an unauthorized producer and any artifact
  that is not hash-bound.
- A release is blocked if any path allows a client or plugin to mint
  `VERIFIED`.
- Watch Memory may cite evidence but may not create it. A generated wiki page
  or a `taste.md` entry is never usable as evidence.

## Revisit trigger

None that preserves the product. Any discovered path that mints `VERIFIED`
outside Core is a release blocker, not a design input.
