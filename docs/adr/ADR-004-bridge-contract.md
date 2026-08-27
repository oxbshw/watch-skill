# ADR-004: Bridge transport, schema, cancellation and idempotency

- Status: Accepted
- Date: 2026-08-27

## Context

The Workspace runs on Node; the perception and verification engine runs on
Python. Every Watch capability crosses that boundary, so the boundary's
semantics decide whether the product is trustworthy under reconnection,
cancellation and retry.

## Decision

### Transport

- **Local:** JSON-RPC 2.0 over stdio to a child process. No port, no CORS, no
  shared secret between Node and Python.
- **Remote:** authenticated HTTPS plus WebSocket or SSE by stream kind.
- Large media never travels inside JSON. Events carry artifact references.

### Schema

Pydantic models in Watch Core are the semantic source. CI emits JSON Schema
2020-12 with a version and digest; TypeScript types are generated from that
schema and validated at runtime on the Node boundary. Shared fixtures test
Python serialize against TypeScript validate in both directions.

### Handshake

Returns Core version and build, negotiated protocol version, per-capability
truth (`implemented` / `machine_tested` / `probed` / `unavailable`), schema
digests, a policy summary, and limits. A protocol mismatch disables only the
affected Watch features and reports both versions with a fix; DSH itself stays
openable in degraded or review mode.

### Long operations

Every long operation carries a deadline, a cancellation token, progress
events, exactly one terminal state, and a correlation id.

### Side effects

Every side-effecting command carries `operation_id`, `idempotency_key`,
`input_digest`, `expected_resource_version` where one exists, and `approval_id`
where policy requires one. A reconnect replays the same receipt or reports a
conflict. **A click, upload or submit is never silently reissued.**

### Event recovery

`snapshot(cursor) → subscribe(next cursor) → delta recovery → resnapshot on gap`.
Projections are idempotent on `event_id`. A sequence gap is never filled by
guessing; dropped and coalesced counts stay visible. Preview frames are
latest-wins; audit, verdict and action events are durable and never dropped.

The Bridge is a transport. It never becomes a second store of truth.
