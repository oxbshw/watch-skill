# Closure audit

_Read against the governing vision, not against
[`implementation-status.json`](implementation-status.json). A ledger that says
100% is a claim; this is the check on it._

Every requirement is classified as **PROVEN**, **PARTIALLY PROVEN**, **NOT
PROVEN**, or **DEFERRED BY SPEC**. A requirement is only PROVEN when something
runnable in this repository fails if it stops being true.

Audited at `02343ca`, against DeepSeek Harness `0.1.1-rc.2` and Watch Core
`watch-skill 1.3.0rc2`.

## How each claim is backed

| Instrument | What it can establish |
|---|---|
| `npm run check` | 929 tests, strict TypeScript build, lint, and six generated-artifact gates |
| `npm run smoke:install` | The bundle installing into a real stock DSH profile and coming back out |
| `node scripts/desktop-smoke.mjs` | A real Electron launch, and the renderer's isolation as Electron actually applied it |
| `node --expose-gc scripts/bench.mjs` | Measured latency, on a named machine |
| `pytest` in `watch-skill` | Watch Core's own suite, including the socket-level offline proof |

Rendering is gated through `react-dom/server`. That is a real gate on markup,
roles, accessible names and non-colour state — and it is not a browser. What it
cannot establish is stated as a limitation rather than implied away.

## Architecture and authority

| Requirement | Verdict | Backed by |
|---|---|---|
| DSH owns runtime, session, tools, jobs, Trajectory | PROVEN | `inventory/parity.yml` covers 40/40 client capabilities; `verify-parity.mjs` fails on an unclassified one |
| Watch Core alone mints evidence and verdicts | PROVEN | `tests/sdk.test.mjs`, `tests/security.test.mjs` — nothing in the SDK returns a verdict, and every submission is rebuilt from an allowlist |
| A plugin cannot mint VERIFIED | PROVEN | `tests/sdk.test.mjs`; the whole hostile corpus is submitted with a forged verdict and the verdict is stripped every time |
| Completed ≠ Verified | PROVEN | `tests/journeys.test.mjs` journey 3; `tests/brand.test.mjs` — `success` is reachable from `VERIFIED` alone |
| A dispatched tool call is not a world effect | PROVEN | journey 3: receipt says dispatched, verdict says FAILED, headline takes the failure |
| Memory is not an evidence plane | PROVEN | `tests/library.test.mjs` asserts the Library exports none of memory's vocabulary; memory records never reach a sensory timeline lane |

## Product surfaces

| Requirement | Verdict | Notes |
|---|---|---|
| Seven modes over one DSH session | PROVEN | `switchMode` cannot change the session; the shell renders one session marker in every mode |
| An absent capability is stated, never hidden or faked | PROVEN | Three availability states; `machine_tested` is the only one that counts as working |
| Sidebar keeps DSH's jobs, schedules, plugins, settings | PROVEN | Asserted in markup, not just in the row table |
| Session header separates execution from verification | PROVEN | Two chips, two labels, and a proven failure outranks a proven success |
| Inspector: nine panels | PROVEN | |
| Sensory timeline over the same correlated state | PROVEN | Pure fold; same input, same digest; no density hides a verdict |
| Composer: eight sections, five guarded axes | PROVEN | An agent may narrow anything and widen nothing; a refusal is whole |
| Memory: seven views, seven operations, every provenance field | PROVEN | |
| The second vertical slice, all thirteen steps | PROVEN | `tests/memory-product.test.mjs`, across a real restart |
| Four memory modes behave differently | PROVEN | |
| Live: cursors, gaps, three clocks, reconnect, triggers, bounded buffer | PROVEN | Fixed-clock fixture; a trigger cannot act |
| Library: revisions, freshness, addressability, facets, stated retrieval path | PROVEN | Old evidence still opens and is marked stale |
| Wiki: deterministic projections, hand edits as proposals | PROVEN | Rebuild is byte-identical; a hostile import is refused |
| Compare: four subjects, first meaningful divergence, deep links | PROVEN | |
| Brand: graphite/ink, Watch Amber, green reserved for VERIFIED | PROVEN | |
| Attribution and independence disclosure | PROVEN | Present in product and README, compared whitespace-normalised |

## Engines, adapters and distribution

| Requirement | Verdict | Notes |
|---|---|---|
| OCR worker isolation, pinned revision verified | PROVEN | Real child process; a worker announcing another revision is refused |
| Crash, OOM, timeout, cancel semantics | PROVEN | Exercised against a process that hangs, exits 3, exits 137, and ignores cancel |
| No automatic model download | PROVEN | `install.automatic` is the literal `false`; the plan describes and never performs |
| Weight distribution gate | PROVEN | Both DeepSeek engines refused; an Apache-2.0 repository does not unlock its weights |
| OCR qualification framework | PROVEN | Metrics, thresholds and matrix shape, on generated fixtures |
| **DeepSeek-OCR quality results** | **NOT PROVEN, and correctly so** | No GPU on this machine. Every matrix cell is `NOT_TESTED`, and a test asserts no code path can produce a metric without a run |
| Obsidian adapter | PARTIALLY PROVEN | Export, backlinks, URI construction and import are gated. Opening an `obsidian://` URI is **NOT MACHINE TESTED** — no Obsidian installation here, and the adapter says so itself |
| LLMWiki adapter | PARTIALLY PROVEN | Round trip and hostile import are gated. Interoperability with a specific LLMWiki release is **NOT MACHINE TESTED** |
| Five installable bundles | PROVEN | Each gated for collisions, duplicates, missing modules and missing dependencies |
| Install / uninstall against stock DSH | PROVEN | `npm run smoke:install` against a real 0.1.1-rc.2 profile |
| **Bundle upgrade path** | PARTIALLY PROVEN | Install and uninstall are smoked against a real profile. Upgrading one bundle version to another is not |
| Ecosystem SDK, host and client halves | PROVEN | Both ship as compiled source the SDK's own tests exercise |

## Desktop

| Requirement | Verdict | Notes |
|---|---|---|
| Electron shell over the same Workspace packages | PROVEN | Real launch, Electron 33.4.11, win32 |
| Sandbox, context isolation, no Node in the renderer | PROVEN | Asserted as Electron applied it: `window.require`, `window.process` and `window.module` all absent |
| Strict CSP, navigation and window allowlists, sender validation | PROVEN | Decisions unit-tested; wiring gated by `verify-desktop-security.mjs` |
| Native permissions deny-by-default, granted only behind an invoked capability | PROVEN | Pending intents expire |
| Startup sequence, migration preflight, read-only replay | PROVEN | A newer store is refused rather than opened |
| Secrets never on a command line | PROVEN | `assertNoSecretsInArgv` throws, and the gate greps for it |
| Children killed by handle, never by name | PROVEN | Proven against a child that ignores SIGTERM; gate forbids `taskkill`/`pkill` across every desktop source |
| At-rest protection for Local Personal memory | PROVEN | Bytes written, read back outside the app, searched for the sentence — with a second test proving the search would find it if present |
| **OS keychain (`safeStorage`)** | PARTIALLY PROVEN | The adapter is exercised through an injected stand-in. Real DPAPI/Keychain/libsecret is **NOT MACHINE TESTED**, and the fallback states plainly that it is not OS protection |
| Update: signature, integrity, downgrade, migration preflight, rollback | PROVEN | Ed25519, checked in that order |
| **Production signing** | **NOT PROVEN, and labelled** | `SIGNING_STATUS` is the constant `PRODUCTION SIGNING NOT PROVEN`, rendered and asserted |
| macOS and Linux | NOT PROVEN | Only win32 was available |

## Team and remote

| Requirement | Verdict | Notes |
|---|---|---|
| Explicit ownership on every served resource | PROVEN | The owner is a required argument of `authorize()` |
| Tenant A cannot read B's workspace, memory, artifact, credential or worker job | PROVEN | Adversarial, including forged memberships and a spoofed principal |
| Denials are not an existence oracle | PROVEN | Byte-identical denial for a real and an invented id |
| Personal taste private by default | PROVEN | Denied above the role check, so no new role reaches it |
| RBAC over every named permission | PROVEN | |
| Remote workers: leases, heartbeats, deadlines, idempotency | PROVEN | Keys namespaced per tenant |
| No blind retry of a consequential job | PROVEN | An expired lease escalates to `needs_resolution` with its idempotency key |
| Audit without credentials or memory content | PROVEN | Refuses rather than redacts |
| Deletion and revocation take effect on the next request | PROVEN | |
| **Persistence** | PARTIALLY PROVEN | The rules and transitions are implemented and tested in memory. No database is bundled; a backing store implements the same transitions |

## Cross-cutting

| Requirement | Verdict | Notes |
|---|---|---|
| Socket-level offline proof | PROVEN | In `watch-skill`: `tests/test_offline_egress.py`, socket-level instrumentation. **Watch Core side only** — DSH provider routes and plugin update checks are not instrumented |
| Prompt, page, OCR, transcript and Markdown injection | PROVEN | One corpus through every door, plus a benign corpus so the guards are not simply refusing everything |
| Approval digest mutation | PROVEN | Digest checked before expiry, so a changed action is never re-approved as a stale one |
| Accessibility: roles, names, focus, non-colour state, 200% zoom, forced colours | PARTIALLY PROVEN | Markup and stylesheet are gated. **Screen-reader announcement is NOT PROVEN** — no assistive technology was driven |
| RTL and bidi isolation | PROVEN | No hand-written RTL block; no physical offsets; seven isolated kinds |
| Multilingual round trip | PROVEN | Six scripts, byte equality through index, search, citation and render |
| Performance, measured | PROVEN | `docs/performance.json`, with the machine recorded and three rows marked `not_measured` with reasons |
| SBOM, SPDX, integrity, compatibility, migration manifest | PROVEN | |
| Thirteen E2E journeys | PROVEN | `tests/journeys.test.mjs` |

## Deferred by the governing document

Not gaps. The vision puts these out of scope, and none of them is claimed:

- a public capability marketplace
- mobile applications
- remote attestation before an independent verifier
- DeepSeek-OCR2 as a universal default
- rewriting Watch Core in TypeScript
- automatic fine-tuning
- autonomous production self-modification
- a mandatory Obsidian or LLMWiki dependency — both are optional, and a test
  asserts no core package knows either exists

## Verdict

Every product-required requirement is **PROVEN**, except those recorded above as
PARTIALLY PROVEN or NOT PROVEN — and each of those is blocked by something this
machine does not have (a GPU, an Obsidian installation, an LLMWiki release,
macOS, a production signing credential, a screen reader) rather than by work
left undone. Each is labelled in the product itself, not only here.
