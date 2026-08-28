# Reconnect policy

Every request made while the Bridge is not ready triggers a reconnect. Against
an engine that fails on contact, that used to mean a fresh Watch Core process
per request. Disposing the abandoned transport stopped them accumulating, but
the churn remained: twenty requests started twenty engines, each one handshaking
and dying.

The Bridge now stops trying after a bounded number of consecutive failures and
tells callers when it will try again.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `failuresBeforeOpen` | 3 | consecutive connection failures before the circuit opens |
| `initialCooldownMs` | 1000 | first wait after the circuit opens |
| `maxCooldownMs` | 30000 | ceiling; the wait doubles up to this and no further |

All three are on `WatchCoreService.Config` and validated by the loader schema,
so a deployment can widen or tighten them without a code change.

## Behaviour

A single attempt runs at a time. Callers arriving while one is in flight share
it rather than starting their own, which is what keeps four concurrent
`connect()` calls to one spawned process.

When the circuit is open, `connect()` returns immediately with:

    bridge.unavailable   retryable: true   details.retryAfterMs: <ms>

No process is started. `retryAfterMs` is what makes this different from a
timeout: a caller can wait the stated time, and a UI can say when rather than
only that something is wrong.

When the cooldown expires, exactly one probe is admitted. If it fails the
circuit re-opens and the wait doubles, capped at `maxCooldownMs`. If it
succeeds, the session proceeds.

A non-retryable transport failure opens the circuit at once rather than counting
to the threshold. `bridge.protocol_violation` is the case: the engine and this
Workspace cannot read each other's frames, and starting the same engine again
produces the same frame. Counting it to three would spawn two more processes to
learn something already known. A crash (`bridge.core_exited`) is retryable and
counts normally, because a crashed engine may come back.

## What clears the breaker

A completed request, not a handshake.

This is the one place the implementation departs from the obvious reading of
"reset after a successful handshake", and it is deliberate. An engine that
handshakes cleanly and then fails every request -- which is exactly the
`protocol_violation` case -- would reset the backoff on every reconnect and
spawn once per request forever. A handshake proves the engine started. Only a
completed request proves it works.

## Disposal

Disposing the Bridge stops admitting connections, cancels the attempt in
flight, and disposes the transport, which terminates the child. A request after
disposal returns `bridge.disposed` and starts nothing.

Note that cordis unregisters the service when its fiber disposes, so
`ctx.watchCore` is `undefined` afterwards. The guard inside the service is
reachable only through a reference taken beforehand, which is what the test
does.

## Observable state

`reconnectState` returns counts and timings for Diagnostics:

    { consecutiveFailures, circuitOpen, retryAfterMs, cooldownMs }

Numbers and a boolean. Nothing there can carry a command line, a path or an
environment value, so it is safe to render and safe to log.

## Evidence

`tests/reconnect-policy.test.mjs`, 14 tests. The clock is injected through
`globalThis.__watchBridgeClock__`, so no test sleeps through a cooldown. Process
counts come from a file the fixture appends its pid to, which is exact and
behaves the same on every platform.

| Scenario | Requests | Engines started |
| --- | --- | --- |
| Concurrent callers, healthy engine | 4 | 1 |
| Permanent protocol failure | 20 | 1 |
| Crash after readiness | 12 | 3 |
| Silent handshake, 300 ms deadline | 8 | 3 |
| Requests after a failed probe | 10 | 0 |

Backoff measured with a 4 s ceiling: 1000, 2000, 4000, 4000, 4000 ms.

Also covered: a missing executable, disposal during a connection attempt,
requests after disposal, and that no engine outlives the Bridge in any of them.
