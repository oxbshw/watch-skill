# Phase 2 closure report

What was built, what it rests on, and what is genuinely proven.

## Baselines

| | |
|---|---|
| DeepSeek Harness | `0.1.1-rc.2` @ `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Watch Core | `watch-skill` `1.3.0rc2`, Bridge protocol 1 |
| Upstream patches required | **none** — patch budget remains zero |

## The DSH seams actually used

Read off the pinned source, not assumed.

| Seam | Package | What Watch does with it |
|---|---|---|
| `ctx.conversationEvents.register()` | `@deepseek-ai/dsh-client-runtime` | Registers a `ConversationNodeDefinition` that claims Watch tool calls and results — the same registry `ui-trajectory` uses for its own records |
| `ctx.conversationViews.register()` | `@deepseek-ai/dsh-client-runtime` | Registers the `watchEvidence` view target with its own builder, the arrangement upstream already uses for `chat` and `trajectory` |
| `ConversationViewSnapshotMap` | `@deepseek-ai/dsh-client-runtime` | Merge-extensible via `declare module`; how a target publishes its snapshot type |
| `conversation.view` slot | `@deepseek-ai/dsh-client-ui-conversation` | Where a view target's tab mounts |
| `tool.call.toolview` slot | `@deepseek-ai/dsh-client-ui-tool` | Keyed per-tool rendering for the verdict and evidence cards |
| Session event log | `@deepseek-ai/dsh-session` | The single event store. Watch adds none of its own. |

### The limitation, and what was done about it

`ui-trajectory`'s README states it plainly:

> Record and timeline selection are local to Trajectory, with no anchor deep
> links.

And its `TrajectoryContribution` union is closed inside upstream's own package,
so a Watch row cannot be added to the existing Trajectory ledger without
patching upstream.

Two consequences, handled without a patch:

1. **Watch publishes its own view target** (`watchEvidence`) over the same
   events, rather than injecting rows into `trajectory`. Additive by
   construction; removing the bundle removes the target and nothing else
   changes.
2. **Watch owns the canonical selection** for Watch-related records
   (`WatchSelectionStore`), and drives Trajectory's local selection from it.
   This is the smallest additive extension around what DSH already has — it
   replaces nothing upstream owns, and if DSH later grows anchor deep links,
   this collapses into them.

## Authority boundaries

| Owner | Owns | Does not own |
|---|---|---|
| DSH | the session, its event log, turns, tools, trajectory | evidence, verdicts, memory |
| Watch Core | sources, evidence, verdicts, receipts | the session log, personalization |
| Watch Memory | preferences, decisions, lessons | evidence, verdicts |

The rule that keeps these honest: **a Watch trajectory record carries stable
foreign identifiers and presentation metadata, never a mutable payload.** An
`evidenceId` is a handle Watch Core resolves. A test asserts the evidence text
does not appear anywhere in a serialized record, because a second copy would
eventually disagree with Core and the disagreement would be invisible.

## Watch event types

Ten, defined in `@watchskill/dsh-trajectory`. Five are produced today from
tool results; the rest are defined and reachable but only emitted once their
capability is wired.

`source.bound` · `observation.created` · `evidence.created` ·
`verification.requested` · `verification.completed` ·
`browser.action.dispatched` · `browser.action.receipt` ·
`memory.context.injected` · `memory.record.corrected` ·
`memory.record.forgotten`

Namespacing is dot-delimited and domain-prefixed; DSH's own types are
slash-delimited (`tool/call`, `turn/start`). The two namespaces cannot collide
however either side grows, and a test asserts it.

Every record carries: session, turn, step, callId, correlationId, sourceId,
sourceRevisionId, evidenceIds, verificationId, verdict, receiptId,
temporalRange, artifactId, memoryIds.

## Deep links

```
#watch=<url-encoded params>
```

| Param | Meaning |
|---|---|
| `w` `s` | workspace, session |
| `r` | trajectory record |
| `e` | evidence |
| `src` `rev` | source, source revision |
| `v` `rc` `m` | verification, receipt, memory |
| `t` `te` | start and end, in milliseconds |
| `tab` | inspector panel |

A **fragment**, not a query string: these identifiers point at someone's
private session and a fragment is never sent to a server. Identifiers only —
a link carrying evidence text would be a copy nobody could invalidate when the
source changed.

Unknown parameters are ignored rather than rejected, so a link from a newer
build still opens the part this one understands. An unknown `tab` is dropped
rather than injected. A fragment that is not a Watch link, or that names no
session, leaves the current selection alone instead of clearing it to a
half-restored state.

## Replay model

`project(events, sessionId)` is a pure fold over DSH's session events: no
clock, no network, no model, nothing regenerated. The live view builder and
replay call the same extraction, and a test asserts their projections hash
identically — live and replay are the same picture by construction, not by
agreement.

`projectionHash()` covers record ids, types, sequence numbers, source
revisions, evidence ids, verification ids, verdicts, receipts, memory ids,
temporal ranges and redaction. It deliberately excludes wall-clock times and
summary text, so improving a label does not read as a changed record while a
changed verdict does.

Replay performs no side effects: it calls no model, reacquires no media, reruns
no browser action, and mints neither evidence nor a verdict. Nothing in the
fold can — every value it produces comes from an event it was handed.

## The tested vertical slice

| Step | Where it is proven |
|---|---|
| Agent turn → Watch tool call → result | `tests/trajectory-roundtrip.test.mjs` |
| Result → Watch record in DSH's own event system | `tests/trajectory-registration.test.mjs` |
| Citation → evidence → trajectory record | round-trip suite |
| Trajectory record → same evidence, timestamp, receipt | round-trip suite |
| Exact source revision and timestamp resolved | round-trip suite |
| Inspector state derived from the same selection | `EvidenceInspector`, selection suite |
| Verification → verdict → receipt | live-engine suite, demo fixtures |
| Deep link → destroy state → reopen → same selection | round-trip + selection-store suites |
| Replay → same projection hash | replay suite |
| `Completed != Verified` | round-trip, tools, presentation suites |
| Memory lifecycle without evidence authority | memory-in-ledger suite |

### Demo fixtures

Deterministic, local, no public site.

| Outcome | Fixture |
|---|---|
| `VERIFIED` | a required `http_request` check against a live local endpoint |
| `UNVERIFIED` | an expectation stated in prose; nothing executable checked |
| `FAILED` **while the page says success** | the page renders "Your order was placed"; `/api/order` returns 500. A system reading the screen reports success. Watch checks the thing that decides, and refuses. |

The false-success fixture asserts the page really does claim success before
asserting Watch refuses it — otherwise the test would pass for the wrong reason
if the fixture ever changed. A further test proves the origin allowlist
actually enforces, so the others cannot pass whether or not it does anything.

## Memory in the ledger

Memory records show **that** memory influenced a turn and **which** record did,
using stable ids and safe display metadata. They carry no memory text, no
evidence ids and no verdict — memory is not an evidence plane and cannot be
cited as one.

A sensitive record is marked `redacted`: the row still appears, because hiding
that memory influenced a turn would be worse than showing one whose content is
withheld. Its summary is replaced rather than omitted, and a test asserts the
reason text does not leak through it.

## Known limitations

- **Watch rows are a separate view target, not rows in DSH's `trajectory`
  ledger.** Upstream's contribution union is closed. Adding to it would need an
  upstream patch; the target is additive and costs nothing to remove.
- **The Evidence Inspector is functionality-first.** It shows real resolved
  data with no fabricated verification state, but the visual design is Phase 3.
- **`browser.action.dispatched`, `verification.requested`, `source.bound` and
  `observation.created`** are defined and reachable; only some are emitted by
  the current tool surface.
- **Deep links restore a selection, not a scroll position.** DSH's Trajectory
  virtualization is its own, and Watch does not reach into it.
- **The demo fixtures verify over HTTP rather than through a live browser.**
  The browser operator is tested separately at the Bridge boundary; a
  Playwright-driven end-to-end fixture is not yet a release gate.

## Exit gates

| Gate | Result |
|---|---|
| `npm run inventory:check` | pass — inventory matches the pinned baseline |
| `npm run verify:parity` | pass — 40/40 DSH client products classified |
| `npm run verify:bundle` | pass — 4 additive rows, no collision with 137 baseline rows |
| `npm run build` (`tsc -b`, strict) | pass |
| `npm run verify:client` | pass — 1 bundle matches the DSH loader contract |
| `npm test` | pass — 187 / 187 |
| live-engine integration | pass — 15 / 15 against `watch-skill bridge` |
| `npm run smoke:install` | pass — installs **and** uninstalls cleanly on stock DSH `0.1.1-rc.2` |
| `watch-skill` pytest | 1925 passed, 33 skipped, **1 failed**, exit code 1 |

### The one red

`tests/test_plugin_packaging.py::test_bundled_mcp_server_is_path_based_not_repo_bound`

Pre-existing and unrelated to Phase 2. The repository's `.mcp.json` carries an
uncommitted local edit to a `uv --directory <repo>` form for local
development, and the test correctly refuses to let that ship. It was present
before this work started and was deliberately not touched.

Nothing in Phase 2 depends on it, and no Phase 2 gate is red.

### Typecheck and lint

`tsc -b` is the typecheck, under `strict` plus `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noUnusedLocals` and `noUnusedParameters`.

**No separate linter is configured in this repository yet.** Saying the lint
gate passed would be untrue; there is no lint gate. Adding one is Phase 3
groundwork, and it should be upstream's `oxlint` configuration so the two
codebases agree on style rather than diverging.
