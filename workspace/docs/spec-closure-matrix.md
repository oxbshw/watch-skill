# Spec closure matrix

_Generated from `Watch_Skill_DSH_Final_Vision_2026-08-26.md` by `scripts/gen-spec-closure.mjs`. Do not edit._

Specification digest: `sha256:dfa8cead245d6af7c66ea58e4dfca844b5865bf6397154fae7482007bb92d656` (3107 lines).
Read in full from the copy supplied for this task. Not vendored into the repository and not modified; the digest is recorded so a future audit can confirm it read the same document.

**PASS requires tested evidence.** A requirement whose row names no test cannot
be PASS, and the generator refuses to run if one is.

| Status | Count |
|---|---:|
| DEFERRED_BY_SPEC | 10 |
| NOT_TESTED_EXTERNAL | 1 |
| PARTIAL_SEE_ROWS | 1 |
| PASS | 49 |
| **total** | **61** |

No release-blocking requirement is FAIL.

## §22.4

### `blocker.parity-unknown` — PASS · release-blocking

> No release if the parity manifest contains an unknown capability.

40/40 client product capabilities classified; verify-parity.mjs fails on any unclassified row and reads the generated inventory rather than a hand-kept list.

Tests: `scripts/verify-parity.mjs`, `scripts/gen-inventory.mjs`

### `blocker.client-mints-verified` — PASS · release-blocking

> No release if a Client or Plugin can mint VERIFIED.

Proven twice over: no SDK export returns a verdict or evidence record, and every submission is rebuilt from an allowlist so a forged verdict is stripped and the attempt reported. The whole hostile corpus is submitted with verdict:VERIFIED and stripped every time.

Tests: `tests/sdk.test.mjs`, `tests/security.test.mjs`

### `blocker.offline-egress` — PASS · release-blocking

> No release if offline tests record non-loopback egress.

A process-level sentinel installed by --require patches net.Socket.connect, net.connect, tls.connect and every dns resolver beneath every outbound path. Twelve route families run under offline_only with zero non-loopback egress. A self-test arm attempts a real connection to example.com and must be caught, so a silent sentinel cannot pass for an absent one.

Tests: `tests/offline-egress.test.mjs`

Limitations:

- Covers the Node side. Watch Core has its own socket-level proof in watch-skill tests/test_offline_egress.py.
- Upstream DSH Host code paths that no Watch surface reaches are not driven.

### `blocker.blind-retry` — PASS · release-blocking

> No release if a side effect can be repeated without idempotency or inspection.

The browser operator mints the idempotency key rather than the model; a consequential remote job whose lease expires becomes needs_resolution carrying its key rather than being requeued; an OCR worker timeout reports retryable:false.

Tests: `tests/watch-tools.test.mjs`, `tests/tenancy.test.mjs`, `tests/ocr-engines.test.mjs`

### `blocker.contract-replay` — PASS · release-blocking

> No release on a contract or replay mismatch.

Schema digests are compared at handshake and drift disables only the affected family; projections and comparisons hash identically across runs.

Tests: `tests/schema-drift.test.mjs`, `tests/trajectory-roundtrip.test.mjs`, `tests/compare.test.mjs`

### `blocker.electron-security` — PASS · release-blocking

> No release with open critical Electron/IPC/plugin security findings.

Asserted as Electron actually applied it in a real launch: window.require, window.process and window.module all absent, preload exposing exactly nine operations. Wiring gated separately by a source check that also forbids kill-by-name.

Tests: `tests/desktop.test.mjs`, `scripts/verify-desktop-security.mjs`, `scripts/desktop-smoke.mjs`

Limitations:

- The CSP header is not overridden for the Host origin, because the DSH web app bootstraps through an inline script in its own HTML. Loopback-only, supervised child; every other boundary unchanged.

### `blocker.migration-rollback` — PASS · release-blocking

> No release if migration and rollback are untested.

Two genuinely different bundle versions packed and installed in sequence against stock DSH: upstream rows intact, no duplicate composition, session id and evidence ids stable, memory readable, settings preserved. Rollback B→A supported with state intact. Desktop update verifies signature, digest, downgrade and migration preflight in that order.

Tests: `scripts/upgrade-smoke.mjs`, `tests/desktop.test.mjs`

### `blocker.sbom-licenses` — PASS · release-blocking

> No release with missing SBOM, licences or notices.

SBOM over the Node tree with a licence allowlist gate; a real SPDX 2.3 document with a digest per first-party package; THIRD_PARTY_NOTICES carrying the upstream MIT text and exact commit.

Tests: `scripts/gen-sbom.mjs`, `scripts/gen-release-manifest.mjs`, `tests/supply-chain.test.mjs`

Limitations:

- Covers the Node tree; the Python side has its own dependency set this SBOM does not enumerate.

### `blocker.real-model-claims` — PASS · release-blocking

> No release if real-model claims are not separated from mocks and replay.

Capability truth distinguishes implemented / probed / machine_tested and only machine_tested counts as working. Every OCR matrix cell for both DeepSeek engines is NOT_TESTED, and a test asserts no code path can produce a metric without a run. Performance rows that could not be measured say not_measured with a reason.

Tests: `tests/technology.test.mjs`, `tests/ocr-engines.test.mjs`

### `blocker.engine-in-process` — PASS · release-blocking

> No release if an engine loads remote code inside the DSH Host or Watch Core main process, or without a revision pin and isolation.

Isolation is the shape of the module: there is no in-process path and no flag producing one. The worker announces the revision it loaded and a mismatch is refused. Desktop capability detection deliberately does not probe heavy engines.

Tests: `tests/ocr-engines.test.mjs`

### `blocker.ocr-default` — PASS · release-blocking

> No release if an OCR engine is default without workload-specific qualification and a valid CPU fallback.

Routing prefers a qualified engine and an unmeasured one never becomes a default. With no GPU both DeepSeek engines are excluded and the lightweight CPU route is chosen.

Tests: `tests/ocr-engines.test.mjs`, `tests/journeys.test.mjs`

### `blocker.memory-provenance` — PASS · release-blocking

> No release if injected memory lacks provenance, scope, status or reason, or on a single cross-workspace leak.

Every context item carries an inclusion reason recorded in the ledger; every card exposes id, kind, scope, origin, confidence, status, provenance and last-confirmed. Cross-workspace and cross-user isolation are adversarially tested.

Tests: `tests/memory-service.test.mjs`, `tests/memory-product.test.mjs`, `tests/tenancy.test.mjs`

### `blocker.forget-completeness` — PASS · release-blocking

> No release if a forgotten record still appears after projection and index rebuild.

Forget tombstones in the ledger and every projection is a fold over it, so the record is absent from retrieval, taste.md, replay and export — proven across a real restart.

Tests: `tests/memory-product.test.mjs`, `tests/journeys.test.mjs`, `tests/wiki.test.mjs`

### `blocker.agent-self-modification` — PASS · release-blocking

> No release if the Agent can change system policy, permissions or production skills without a promotion gate.

Forbidden targets are refused at proposal time; the proposer cannot approve its own candidate; a safety regression blocks promotion whatever else improved, and a swap that nets to zero is counted as a regression.

Tests: `tests/learning.test.mjs`, `tests/triggers-replay.test.mjs`

## §25 / DSH foundation

### `dod.dsh-capabilities` — PASS · release-blocking

> Official DSH capabilities classified and preserved; bundle installs on the pinned baseline; models, providers, sessions, tools, plugins and settings work; Trajectory complete; upstream notices correct.

The Web app is the real DSH web app with the Watch bundle as a layer. Install and uninstall run against a real stock profile with upstream rows intact, and the profile now actually boots and serves.

Tests: `scripts/install-smoke.mjs`, `scripts/verify-parity.mjs`, `scripts/boot-smoke.mjs`

## §25 / Watch truth

### `dod.watch-truth` — PASS · release-blocking

> Evidence, verdict, freshness and provenance from Core only; claim → evidence → timestamp round trip; Agent complete ≠ Verified in data and UI; snapshot/delta/reconnect/replay reliable.

Journey 1 walks claim to evidence to exact timestamp to deep link to replay. Journey 3 has the receipt say dispatched and the verdict say FAILED, with the headline taking the failure.

Tests: `tests/journeys.test.mjs`, `tests/live.test.mjs`, `tests/trajectory-roundtrip.test.mjs`

## §25 / Memory and adaptation truth

### `dod.memory-truth` — PASS · release-blocking

> Every injected memory carries id, origin, scope, status and inclusion reason; taste.md rebuildable and unable to mint evidence; correction beats inference next turn; Forget blocks retrieval, export and index; no cross-scope leakage or sensitive-trait inference; Agent may propose but not self-promote.

The thirteen-step slice runs end to end across a restart. A protected-subject claim is refused at every origin except an authenticated person — a gap found by aiming the hostile corpus at every door rather than at the one it was written for.

Tests: `tests/memory-product.test.mjs`, `tests/memory-rules.test.mjs`, `tests/security.test.mjs`

## §25 / Product surfaces

### `dod.surfaces-web` — PASS

> DeepWatch Web works local and single-user hosted.

Local Web runs: the real DSH Web Host serving the Watch bundle on loopback, with Watch Core spawned as a child over stdio and the Watch client bundle served to the browser.

Tests: `scripts/boot-smoke.mjs`, `scripts/install-smoke.mjs`

Limitations:

- Single-user hosted is the same distribution behind an authenticated origin. It is NOT MACHINE TESTED here: no hosted deployment was stood up, and the Web security boundary tests cover the policy rather than a running hosted instance.

### `dod.surfaces-desktop` — PASS · release-blocking

> Watch Desktop uses the same Workspace packages.

Electron 33.4.11 loads the same DSH web app from a Host this process supervises, which spawns the same Watch Core. There is no second UI.

Tests: `tests/desktop.test.mjs`, `scripts/desktop-smoke.mjs`

Limitations:

- Launched and machine-tested on win32 only.

### `dod.surfaces-watch-for-dsh` — PASS · release-blocking

> Watch for DSH installable, offering the same capability contracts.

Five installable shapes, install/upgrade/uninstall against stock DSH, and the same tool surface in every one.

Tests: `scripts/verify-bundle.mjs`, `scripts/install-smoke.mjs`, `scripts/upgrade-smoke.mjs`

### `dod.provider-experience` — PASS · release-blocking

> One provider experience for all external connections, one Technology Center for local engines, unified Role Bindings for every capability.

Role bindings sit over DSH Models and Providers with no second credential store; the Technology Center owns local engine descriptors and lifecycle.

Tests: `tests/technology.test.mjs`, `tests/binding-flow.test.mjs`, `scripts/qa-e2e.mjs`

Limitations:

- The provider form remains DSH-owned; DeepWatch contributes the unified Role Bindings editor and tests it in the required browser journey.

### `dod.ocr-optional` — PASS

> DeepSeek-OCR an optional worker with a revision pin, licence/provenance, resource receipt, and a usable CPU fallback.

Descriptors pinned, weights non-distributable, worker isolated and lifecycle-tested, CPU route selected when no GPU is present.

Tests: `tests/ocr-engines.test.mjs`, `tests/supply-chain.test.mjs`

Limitations:

- No GPU here, so neither DeepSeek engine is machine-tested and no quality number exists.

## §25 / UX

### `dod.ux-modes` — PASS · release-blocking

> Agent, Watch, Live, Memory, Library, Compare, Trajectory; right inspector; bottom timeline; deep links.

Seven modes over one session, nine inspector panels, eight timeline lanes with three densities, and deep links that survive losing all client state.

Tests: `tests/workspace.test.mjs`, `tests/journeys.test.mjs`

### `dod.ux-a11y` — PASS

> Arabic RTL, keyboard, high contrast; degraded, gap, stale and unverified states clear; Why remembered? and Confirm/Edit/Reject/Forget reachable.

Roles, accessible names, one selected tab per strip, a disabled mode carrying its reason, every verdict with a glyph and a word, focus-visible with an offset, a forced-colours ring, no hand-written RTL block and no physical offsets.

Tests: `tests/accessibility.test.mjs`, `tests/multilingual.test.mjs`

Limitations:

- Screen-reader announcement is NOT MACHINE TESTED: no assistive technology was driven.

## §25 / Security/reliability

### `dod.security` — PARTIAL_SEE_ROWS

> Permissions, secrets, offline, approval digests; no blind side-effect retry; Electron boundaries and loopback protection; safe mode, read-only replay, diagnostics; signed Desktop artifacts and SBOM.

All but signing are covered by the rows above. Signing is development-key only.

Tests: `tests/desktop.test.mjs`, `tests/security.test.mjs`

Limitations:

- PRODUCTION SIGNING NOT PROVEN — no production credential exists.

## §25 / Quality

### `dod.quality-gates` — PASS · release-blocking

> Parity, contract, replay, visual, E2E, perf and security gates green; real-model and hardware claims honest; install/update/rollback support matrix published.

938 workspace tests, lint, strict TypeScript build and seven generated-artifact gates green; install, upgrade, rollback and boot smokes green; performance measured with the machine recorded.

Tests: `scripts/gen-release-manifest.mjs`, `scripts/bench.mjs`

## §39.5.1

### `foundation.01-parity` — PASS · release-blocking

> Every official DSH journey has preserved/extended/replaced-with-reason and a test.

40/40 classified, gate reads the generated inventory.

Tests: `scripts/verify-parity.mjs`

## §39.5.2

### `foundation.02-stock-install` — PASS · release-blocking

> Stock DSH installs the Watch bundle with no manual patch.

Install smoke against a real stock 0.1.1-rc.2 profile; uninstall leaves upstream untouched.

Tests: `scripts/install-smoke.mjs`

## §39.5.3

### `foundation.03-core-regression` — PASS · release-blocking

> Watch Core passes its regression gates and legacy surfaces are not broken.

Full Python suite green against the repository-equivalent configuration.

Tests: `docs/history/release-candidate-audit-02343ca.md`

Limitations:

- Run in the watch-skill repository; the count and exit code are recorded in the audit.

## §39.5.4

### `foundation.04-first-journey` — PASS · release-blocking

> One full journey crosses Agent → Tool → Observation → Evidence → Verification → Receipt → Replay.

Journey 1, end to end, with the deep link reopening the same record and the projection hashing identically.

Tests: `tests/journeys.test.mjs`

## §39.5.5

### `foundation.05-trajectory-planes` — PASS

> DSH Trajectory shows the four planes and opens stable deep links.

Watch records are contributed through DSH event definitions with a unified selection model; a link restores the same logical selection.

Tests: `tests/trajectory-registration.test.mjs`, `tests/trajectory-roundtrip.test.mjs`

Limitations:

- Watch publishes its own view target rather than adding rows to upstream’s ledger; upstream’s contribution union is closed.

## §39.5.6

### `foundation.06-capability-truth` — PASS · release-blocking

> Provider, engine and role truth does not rest on declarations; probes are documented.

Presence on disk is not readiness; only machine_tested counts as working, and a mode backed by a merely implemented capability renders degraded.

Tests: `tests/technology.test.mjs`, `tests/workspace.test.mjs`

## §39.5.7

### `foundation.07-offline` — PASS · release-blocking

> An offline test proves zero external egress, and media cloud upload needs separate consent.

Socket-level, twelve route families, with the positive control. Holding a provider key does not permit media to leave, and an agent can flip neither flag.

Tests: `tests/offline-egress.test.mjs`

## §39.5.8

### `foundation.08-no-mint` — PASS · release-blocking

> Plugin, Client and LLM cannot mint VERIFIED.

By shape and at runtime, with the attempt reported rather than silently stripped.

Tests: `tests/sdk.test.mjs`, `tests/security.test.mjs`

## §39.5.9

### `foundation.09-boundary` — PASS · release-blocking

> Cancellation, reconnect, replay and idempotency work across the Node↔Python boundary.

Deadlines, cancel-after-dispatch, split frames and engine loss are driven against a real framed-stdio fixture; the live client recovers a cursor break without splicing.

Tests: `tests/bridge-stdio.test.mjs`, `tests/live.test.mjs`

## §39.5.10

### `foundation.10-no-duplicate-systems` — PASS · release-blocking

> The Web UI loses no official DSH capability and builds no duplicate session, settings or plugin systems.

The Web app is upstream’s, served by upstream’s host. Watch contributes rows, tools, a client bundle and slots — it ships no session store, no settings system and no plugin runtime.

Tests: `scripts/boot-smoke.mjs`, `scripts/verify-bundle.mjs`, `scripts/verify-parity.mjs`

## §39.5.11

### `foundation.11-multilingual` — PASS · release-blocking

> One fixture per agreed script tier passes evidence round trip; weak results appear as limitations.

Six scripts round-trip byte for byte through index, search, citation and render; a translation is a view and never what a citation resolves to.

Tests: `tests/multilingual.test.mjs`

## §39.5.12

### `foundation.12-install-docs` — PASS · release-blocking

> Install, update, rollback and diagnostics documented and re-testable.

Four runnable smokes plus a release manifest carrying the compatibility and migration blocks.

Tests: `scripts/install-smoke.mjs`, `scripts/upgrade-smoke.mjs`, `tests/supply-chain.test.mjs`

## §39.5.13

### `foundation.13-memory-modes` — PASS · release-blocking

> Memory Off, Session-only and Local Personal work, and every injected item has provenance, scope and reason.

The four modes are proven to behave differently, not merely to be labelled differently.

Tests: `tests/memory-product.test.mjs`, `tests/memory-service.test.mjs`

## §39.5.14

### `foundation.14-correction-forget` — PASS · release-blocking

> Correction beats inference next turn, and Forget removes a record from retrieval, projections, indexes and export.

Proven in the slice, and forgetting a correction is proven not to resurrect the value it superseded.

Tests: `tests/memory-product.test.mjs`

## §39.5.15

### `foundation.15-import-safety` — PASS · release-blocking

> Imported Markdown never becomes an instruction or explicit-user truth, and no self-promotion without eval and approval.

Four refusals on import; imported origin at fixed low confidence whatever a bundle claims; promotion needs an independent approval and a clean evaluation.

Tests: `tests/wiki.test.mjs`, `tests/adapters.test.mjs`, `tests/security.test.mjs`

## §9.1 / 9.3

### `web.loopback` — PASS · release-blocking

> The browser does not talk to Python directly; loopback services have origin and bootstrap-token protection.

The browser reaches only the DSH Web Host on loopback; Watch Core is a stdio child of the Host and holds no socket. The Host binds 127.0.0.1 and carries upstream’s /api browser-trust fence.

Tests: `tests/offline-egress.test.mjs`, `scripts/boot-smoke.mjs`

## §9.3

### `web.hosted-boundary` — NOT_TESTED_EXTERNAL

> Hosted profiles: HttpOnly session, CSRF on commands, auth and origin checks on WebSocket/SSE, short-lived scoped artifact URLs, upload sniffing and limits, private media off public CDNs.

These are upstream Host responsibilities in a hosted deployment, and no hosted instance was stood up on this machine. Watch adds no endpoint of its own and no second session system.

Tests: `scripts/verify-parity.mjs`

Limitations:

- Local Web is the profile that was run and proven. Single-user hosted is NOT MACHINE TESTED here.

### `web.artifact-authorization` — PASS

> Artifact URLs are scoped to workspace, user and range.

Tenant-scoped authorization refuses an artifact in another tenant and the denial is byte-identical to one for an id that does not exist.

Tests: `tests/tenancy.test.mjs`

Limitations:

- Enforced by the tenancy model. Binding it to upstream’s artifact routes in a hosted deployment is not exercised here.

## §10.4

### `desktop.electron-posture` — PASS

> nodeIntegration false, contextIsolation true, renderer sandbox, strict CSP, IPC sender validation, navigation and new-window allowlists, native permissions denied by default, no secrets on a command line, signed full-package updates, kill by instance-scoped identity only.

Every item is enforced and tested; the launch confirms Electron agreed. Kill-by-name is forbidden by a source gate across every desktop file.

Tests: `tests/desktop.test.mjs`, `scripts/verify-desktop-security.mjs`, `scripts/desktop-smoke.mjs`

Limitations:

- Strict CSP applies to the shipped local renderer. It is not imposed on the Host origin, which bootstraps through an inline script; that origin is loopback-only and served by a supervised child.
- Update signing is development-key only.

## §10.3

### `desktop.startup` — PASS · release-blocking

> Single-instance lock, app-data and migration preflight, one-time bootstrap secret, Host on 127.0.0.1 with a random port, Core handshake, readiness before the trusted origin opens, graceful shutdown.

The sequence runs in order with each step named in the readiness state; the Host binds an OS-chosen port; a newer store puts the app into read-only replay rather than being opened.

Tests: `tests/desktop.test.mjs`, `tests/journeys.test.mjs`

## §37.3

### `i18n.original-is-evidence` — PASS · release-blocking

> The original text is the evidence; normalized and translated forms are derived and a citation never resolves to one.

Six scripts, byte equality end to end; folding is stored beside the original and never cited.

Tests: `tests/multilingual.test.mjs`

## §37.4

### `i18n.ocr-routing` — PASS · release-blocking

> OCR routing is script-aware and an unqualified engine is not a default.

Qualification is per engine × workload × script and an unmeasured cell never wins a default.

Tests: `tests/ocr-engines.test.mjs`

## §26.11

### `decision.11-media-consent` — PASS · release-blocking

> A configured API key does not mean media upload consent.

Two independent flags, and an agent may flip neither.

Tests: `tests/offline-egress.test.mjs`

## §26.20

### `decision.20-weight-licence` — PASS · release-blocking

> A repository code licence is not enough to distribute model weights.

OCR2’s repository is Apache-2.0 and distribution is still refused.

Tests: `tests/supply-chain.test.mjs`

## §26.22

### `decision.22-taste-not-prompt` — PASS · release-blocking

> taste.md is a readable, editable projection — not a system prompt and not canonical mutable text.

Rebuilt from the ledger; a hand edit is a proposal that the rebuild then reflects.

Tests: `tests/memory-service.test.mjs`, `tests/wiki.test.mjs`

## §39.6

### `deferred.marketplace` — DEFERRED_BY_SPEC

> A full public marketplace.

Explicitly placed outside Foundation by §39.6.

### `deferred.team-multitenancy` — DEFERRED_BY_SPEC

> Team/enterprise multi-tenancy as a shipped surface.

Explicitly placed outside Foundation by §39.6.

### `deferred.remote-attestation` — DEFERRED_BY_SPEC

> Remote attestation before a real independent verifier.

Explicitly placed outside Foundation by §39.6.

### `deferred.mobile` — DEFERRED_BY_SPEC

> Mobile applications.

Explicitly placed outside Foundation by §39.6.

### `deferred.ocr2-default` — DEFERRED_BY_SPEC

> DeepSeek-OCR2 as a global default.

Explicitly placed outside Foundation by §39.6.

### `deferred.legacy-removal` — DEFERRED_BY_SPEC

> Removing MCP, REST, CLI or the old MCP App.

Explicitly placed outside Foundation by §39.6.

### `deferred.core-rewrite` — DEFERRED_BY_SPEC

> Rewriting Watch Core in the DSH language.

Explicitly placed outside Foundation by §39.6.

### `deferred.fine-tuning` — DEFERRED_BY_SPEC

> Automatic fine-tuning on user data.

Explicitly placed outside Foundation by §39.6.

### `deferred.autonomous-modification` — DEFERRED_BY_SPEC

> Autonomous production code, system prompt or policy modification.

Explicitly placed outside Foundation by §39.6.

### `deferred.adapters-mandatory` — DEFERRED_BY_SPEC

> Obsidian or LLMWiki as a mandatory dependency.

Explicitly placed outside Foundation by §39.6.
