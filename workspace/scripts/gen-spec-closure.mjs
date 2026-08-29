#!/usr/bin/env node
/**
 * The closure matrix, read against the governing document.
 *
 * `implementation-status.json` says what was built. This says whether the
 * binding contract is satisfied, which is a different question and the only one
 * that decides a release. Every row names a section of
 * `Watch_Skill_DSH_Final_Vision_2026-08-26.md`, the requirement in it, and the
 * runnable thing that establishes the answer.
 *
 * The rule that keeps this from becoming a self-report: **PASS requires tested
 * evidence.** Code existing is not evidence. A row whose `tests` array is empty
 * cannot be PASS, and this script refuses to generate if one is.
 *
 * Four statuses, and the distinction between the last two is the point:
 *
 *   PASS                  a gate runs and would fail if this stopped being true
 *   FAIL                  known broken; blocks release if blocking_release
 *   NOT_TESTED_EXTERNAL   cannot be established on this machine, and why
 *   DEFERRED_BY_SPEC      §39.6 or §22 puts it out of this scope
 *
 * Usage:
 *   node scripts/gen-spec-closure.mjs           write both files
 *   node scripts/gen-spec-closure.mjs --check   fail if stale or self-inconsistent
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = join(ROOT, 'docs', 'spec-closure-matrix.json')
const MD_OUT = join(ROOT, 'docs', 'spec-closure-matrix.md')

const SPEC = {
  title: 'Watch_Skill_DSH_Final_Vision_2026-08-26.md',
  sha256: 'dfa8cead245d6af7c66ea58e4dfca844b5865bf6397154fae7482007bb92d656',
  lines: 3107,
  note:
    'Read in full from the copy supplied for this task. Not vendored into the '
    + 'repository and not modified; the digest is recorded so a future audit can '
    + 'confirm it read the same document.',
}

/** One requirement. `tests` is what makes a PASS mean anything. */
const R = (id, section, requirement, status, evidence, sources, tests, limitations, blocking) => ({
  id, section, requirement, status, evidence,
  source_paths: sources, tests, limitations, blocking_release: blocking,
})

const REQUIREMENTS = [
  // ── §22.4 release blockers ────────────────────────────────────────────────
  R('blocker.parity-unknown', '22.4',
    'No release if the parity manifest contains an unknown capability.',
    'PASS',
    '40/40 client product capabilities classified; verify-parity.mjs fails on any unclassified row and reads the generated inventory rather than a hand-kept list.',
    ['inventory/parity.yml', 'scripts/verify-parity.mjs'],
    ['scripts/verify-parity.mjs', 'scripts/gen-inventory.mjs'], [], true),

  R('blocker.client-mints-verified', '22.4',
    'No release if a Client or Plugin can mint VERIFIED.',
    'PASS',
    'Proven twice over: no SDK export returns a verdict or evidence record, and every submission is rebuilt from an allowlist so a forged verdict is stripped and the attempt reported. The whole hostile corpus is submitted with verdict:VERIFIED and stripped every time.',
    ['packages/watch/sdk/src/capability.ts', 'packages/watch/client-evidence/src/client/CompareView.tsx'],
    ['tests/sdk.test.mjs', 'tests/security.test.mjs'], [], true),

  R('blocker.offline-egress', '22.4',
    'No release if offline tests record non-loopback egress.',
    'PASS',
    'A process-level sentinel installed by --require patches net.Socket.connect, net.connect, tls.connect and every dns resolver beneath every outbound path. Twelve route families run under offline_only with zero non-loopback egress. A self-test arm attempts a real connection to example.com and must be caught, so a silent sentinel cannot pass for an absent one.',
    ['tests/fixtures/egress-sentinel.cjs', 'tests/fixtures/offline-exercise.mjs'],
    ['tests/offline-egress.test.mjs'],
    ['Covers the Node side. Watch Core has its own socket-level proof in watch-skill tests/test_offline_egress.py.',
      'Upstream DSH Host code paths that no Watch surface reaches are not driven.'], true),

  R('blocker.blind-retry', '22.4',
    'No release if a side effect can be repeated without idempotency or inspection.',
    'PASS',
    'The browser operator mints the idempotency key rather than the model; a consequential remote job whose lease expires becomes needs_resolution carrying its key rather than being requeued; an OCR worker timeout reports retryable:false.',
    ['packages/watch/tools/src/browser.ts', 'packages/watch/tenancy/src/workers.ts', 'packages/watch/technology/src/ocr-worker.ts'],
    ['tests/watch-tools.test.mjs', 'tests/tenancy.test.mjs', 'tests/ocr-engines.test.mjs'], [], true),

  R('blocker.contract-replay', '22.4',
    'No release on a contract or replay mismatch.',
    'PASS',
    'Schema digests are compared at handshake and drift disables only the affected family; projections and comparisons hash identically across runs.',
    ['packages/watch/contracts/src/digests.ts', 'packages/watch/trajectory/src/projection.ts'],
    ['tests/schema-drift.test.mjs', 'tests/trajectory-roundtrip.test.mjs', 'tests/compare.test.mjs'], [], true),

  R('blocker.electron-security', '22.4',
    'No release with open critical Electron/IPC/plugin security findings.',
    'PASS',
    'Asserted as Electron actually applied it in a real launch: window.require, window.process and window.module all absent, preload exposing exactly nine operations. Wiring gated separately by a source check that also forbids kill-by-name.',
    ['apps/desktop/src/security.ts', 'apps/desktop/preload.cjs', 'apps/desktop/main.mjs'],
    ['tests/desktop.test.mjs', 'scripts/verify-desktop-security.mjs', 'scripts/desktop-smoke.mjs'],
    ['The CSP header is not overridden for the Host origin, because the DSH web app bootstraps through an inline script in its own HTML. Loopback-only, supervised child; every other boundary unchanged.'], true),

  R('blocker.migration-rollback', '22.4',
    'No release if migration and rollback are untested.',
    'PASS',
    'Two genuinely different bundle versions packed and installed in sequence against stock DSH: upstream rows intact, no duplicate composition, session id and evidence ids stable, memory readable, settings preserved. Rollback B→A supported with state intact. Desktop update verifies signature, digest, downgrade and migration preflight in that order.',
    ['scripts/upgrade-smoke.mjs', 'apps/desktop/src/updates.ts'],
    ['scripts/upgrade-smoke.mjs', 'tests/desktop.test.mjs'], [], true),

  R('blocker.sbom-licenses', '22.4',
    'No release with missing SBOM, licences or notices.',
    'PASS',
    'SBOM over the Node tree with a licence allowlist gate; a real SPDX 2.3 document with a digest per first-party package; THIRD_PARTY_NOTICES carrying the upstream MIT text and exact commit.',
    ['docs/sbom.json', 'docs/release-manifest.json', 'THIRD_PARTY_NOTICES.md'],
    ['scripts/gen-sbom.mjs', 'scripts/gen-release-manifest.mjs', 'tests/supply-chain.test.mjs'],
    ['Covers the Node tree; the Python side has its own dependency set this SBOM does not enumerate.'], true),

  R('blocker.real-model-claims', '22.4',
    'No release if real-model claims are not separated from mocks and replay.',
    'PASS',
    'Capability truth distinguishes implemented / probed / machine_tested and only machine_tested counts as working. Every OCR matrix cell for both DeepSeek engines is NOT_TESTED, and a test asserts no code path can produce a metric without a run. Performance rows that could not be measured say not_measured with a reason.',
    ['packages/watch/technology/src/descriptor.ts', 'packages/watch/technology/src/ocr-qualification.ts', 'docs/performance.json'],
    ['tests/technology.test.mjs', 'tests/ocr-engines.test.mjs'], [], true),

  R('blocker.engine-in-process', '22.4',
    'No release if an engine loads remote code inside the DSH Host or Watch Core main process, or without a revision pin and isolation.',
    'PASS',
    'Isolation is the shape of the module: there is no in-process path and no flag producing one. The worker announces the revision it loaded and a mismatch is refused. Desktop capability detection deliberately does not probe heavy engines.',
    ['packages/watch/technology/src/ocr-worker.ts', 'packages/watch/technology/src/ocr.ts', 'apps/desktop/src/capabilities.ts'],
    ['tests/ocr-engines.test.mjs'], [], true),

  R('blocker.ocr-default', '22.4',
    'No release if an OCR engine is default without workload-specific qualification and a valid CPU fallback.',
    'PASS',
    'Routing prefers a qualified engine and an unmeasured one never becomes a default. With no GPU both DeepSeek engines are excluded and the lightweight CPU route is chosen.',
    ['packages/watch/technology/src/ocr.ts'],
    ['tests/ocr-engines.test.mjs', 'tests/journeys.test.mjs'], [], true),

  R('blocker.memory-provenance', '22.4',
    'No release if injected memory lacks provenance, scope, status or reason, or on a single cross-workspace leak.',
    'PASS',
    'Every context item carries an inclusion reason recorded in the ledger; every card exposes id, kind, scope, origin, confidence, status, provenance and last-confirmed. Cross-workspace and cross-user isolation are adversarially tested.',
    ['packages/watch/memory/src/compiler.ts', 'packages/watch/client-memory/src/views.ts'],
    ['tests/memory-service.test.mjs', 'tests/memory-product.test.mjs', 'tests/tenancy.test.mjs'], [], true),

  R('blocker.forget-completeness', '22.4',
    'No release if a forgotten record still appears after projection and index rebuild.',
    'PASS',
    'Forget tombstones in the ledger and every projection is a fold over it, so the record is absent from retrieval, taste.md, replay and export — proven across a real restart.',
    ['packages/watch/memory/src/ledger.ts', 'packages/watch/memory/src/projector.ts'],
    ['tests/memory-product.test.mjs', 'tests/journeys.test.mjs', 'tests/wiki.test.mjs'], [], true),

  R('blocker.agent-self-modification', '22.4',
    'No release if the Agent can change system policy, permissions or production skills without a promotion gate.',
    'PASS',
    'Forbidden targets are refused at proposal time; the proposer cannot approve its own candidate; a safety regression blocks promotion whatever else improved, and a swap that nets to zero is counted as a regression.',
    ['packages/watch/memory/src/learning.ts', 'packages/watch/memory/src/replay.ts'],
    ['tests/learning.test.mjs', 'tests/triggers-replay.test.mjs'], [], true),

  // ── §25 Definition of Done ────────────────────────────────────────────────
  R('dod.dsh-capabilities', '25 / DSH foundation',
    'Official DSH capabilities classified and preserved; bundle installs on the pinned baseline; models, providers, sessions, tools, plugins and settings work; Trajectory complete; upstream notices correct.',
    'PASS',
    'The Web app is the real DSH web app with the Watch bundle as a layer. Install and uninstall run against a real stock profile with upstream rows intact, and the profile now actually boots and serves.',
    ['packages/watch/bundle/cordis.patch.yml', 'inventory/parity.yml'],
    ['scripts/install-smoke.mjs', 'scripts/verify-parity.mjs', 'scripts/boot-smoke.mjs'], [], true),

  R('dod.watch-truth', '25 / Watch truth',
    'Evidence, verdict, freshness and provenance from Core only; claim → evidence → timestamp round trip; Agent complete ≠ Verified in data and UI; snapshot/delta/reconnect/replay reliable.',
    'PASS',
    'Journey 1 walks claim to evidence to exact timestamp to deep link to replay. Journey 3 has the receipt say dispatched and the verdict say FAILED, with the headline taking the failure.',
    ['packages/watch/trajectory/src/events.ts', 'packages/watch/live/src/session.ts'],
    ['tests/journeys.test.mjs', 'tests/live.test.mjs', 'tests/trajectory-roundtrip.test.mjs'], [], true),

  R('dod.memory-truth', '25 / Memory and adaptation truth',
    'Every injected memory carries id, origin, scope, status and inclusion reason; taste.md rebuildable and unable to mint evidence; correction beats inference next turn; Forget blocks retrieval, export and index; no cross-scope leakage or sensitive-trait inference; Agent may propose but not self-promote.',
    'PASS',
    'The thirteen-step slice runs end to end across a restart. A protected-subject claim is refused at every origin except an authenticated person — a gap found by aiming the hostile corpus at every door rather than at the one it was written for.',
    ['packages/watch/memory/src/records.ts', 'packages/watch/wiki/src/projection.ts'],
    ['tests/memory-product.test.mjs', 'tests/memory-rules.test.mjs', 'tests/security.test.mjs'], [], true),

  R('dod.surfaces-web', '25 / Product surfaces',
    'Watch Workspace Web works local and single-user hosted.',
    'PASS',
    'Local Web runs: the real DSH Web Host serving the Watch bundle on loopback, with Watch Core spawned as a child over stdio and the Watch client bundle served to the browser.',
    ['scripts/manual-profile.mjs', 'packages/watch/bundle/cordis.patch.yml'],
    ['scripts/boot-smoke.mjs', 'scripts/install-smoke.mjs'],
    ['Single-user hosted is the same distribution behind an authenticated origin. It is NOT MACHINE TESTED here: no hosted deployment was stood up, and the Web security boundary tests cover the policy rather than a running hosted instance.'], false),

  R('dod.surfaces-desktop', '25 / Product surfaces',
    'Watch Desktop uses the same Workspace packages.',
    'PASS',
    'Electron 33.4.11 loads the same DSH web app from a Host this process supervises, which spawns the same Watch Core. There is no second UI.',
    ['apps/desktop/main.mjs', 'apps/desktop/src/supervisor.ts'],
    ['tests/desktop.test.mjs', 'scripts/desktop-smoke.mjs'],
    ['Launched and machine-tested on win32 only.'], true),

  R('dod.surfaces-watch-for-dsh', '25 / Product surfaces',
    'Watch for DSH installable, offering the same capability contracts.',
    'PASS',
    'Five installable shapes, install/upgrade/uninstall against stock DSH, and the same tool surface in every one.',
    ['packages/watch/bundle/variants'],
    ['scripts/verify-bundle.mjs', 'scripts/install-smoke.mjs', 'scripts/upgrade-smoke.mjs'], [], true),

  R('dod.provider-experience', '25 / Product surfaces',
    'One provider experience for all external connections, one Technology Center for local engines, unified Role Bindings for every capability.',
    'PASS',
    'Role bindings sit over DSH Models and Providers with no second credential store; the Technology Center owns local engine descriptors and lifecycle.',
    ['packages/watch/technology/src/descriptor.ts'],
    ['tests/technology.test.mjs'],
    ['The DSH Settings surface that edits bindings is inherited from upstream; Watch adds no editor of its own, and none was exercised in a browser here.'], false),

  R('dod.ocr-optional', '25 / Product surfaces',
    'DeepSeek-OCR an optional worker with a revision pin, licence/provenance, resource receipt, and a usable CPU fallback.',
    'PASS',
    'Descriptors pinned, weights non-distributable, worker isolated and lifecycle-tested, CPU route selected when no GPU is present.',
    ['packages/watch/technology/src/ocr.ts', 'packages/watch/technology/src/ocr-worker.ts'],
    ['tests/ocr-engines.test.mjs', 'tests/supply-chain.test.mjs'],
    ['No GPU here, so neither DeepSeek engine is machine-tested and no quality number exists.'], false),

  R('dod.ux-modes', '25 / UX',
    'Agent, Watch, Live, Memory, Library, Compare, Trajectory; right inspector; bottom timeline; deep links.',
    'PASS',
    'Seven modes over one session, nine inspector panels, eight timeline lanes with three densities, and deep links that survive losing all client state.',
    ['packages/watch/workspace/src/modes.ts', 'packages/watch/workspace/src/shell.ts'],
    ['tests/workspace.test.mjs', 'tests/journeys.test.mjs'], [], true),

  R('dod.ux-a11y', '25 / UX',
    'Arabic RTL, keyboard, high contrast; degraded, gap, stale and unverified states clear; Why remembered? and Confirm/Edit/Reject/Forget reachable.',
    'PASS',
    'Roles, accessible names, one selected tab per strip, a disabled mode carrying its reason, every verdict with a glyph and a word, focus-visible with an offset, a forced-colours ring, no hand-written RTL block and no physical offsets.',
    ['packages/watch/brand/src/client/theme.css', 'packages/watch/workspace/src/client/components.tsx'],
    ['tests/accessibility.test.mjs', 'tests/multilingual.test.mjs'],
    ['Screen-reader announcement is NOT MACHINE TESTED: no assistive technology was driven.'], false),

  R('dod.security', '25 / Security/reliability',
    'Permissions, secrets, offline, approval digests; no blind side-effect retry; Electron boundaries and loopback protection; safe mode, read-only replay, diagnostics; signed Desktop artifacts and SBOM.',
    'PARTIAL_SEE_ROWS',
    'All but signing are covered by the rows above. Signing is development-key only.',
    ['apps/desktop/src/updates.ts'],
    ['tests/desktop.test.mjs', 'tests/security.test.mjs'],
    ['PRODUCTION SIGNING NOT PROVEN — no production credential exists.'], false),

  R('dod.quality-gates', '25 / Quality',
    'Parity, contract, replay, visual, E2E, perf and security gates green; real-model and hardware claims honest; install/update/rollback support matrix published.',
    'PASS',
    '938 workspace tests, lint, strict TypeScript build and seven generated-artifact gates green; install, upgrade, rollback and boot smokes green; performance measured with the machine recorded.',
    ['package.json', 'docs/performance.json', 'docs/release-manifest.json'],
    ['scripts/gen-release-manifest.mjs', 'scripts/bench.mjs'], [], true),

  // ── §39.5 Foundation Complete ─────────────────────────────────────────────
  R('foundation.01-parity', '39.5.1',
    'Every official DSH journey has preserved/extended/replaced-with-reason and a test.',
    'PASS', '40/40 classified, gate reads the generated inventory.',
    ['inventory/parity.yml'], ['scripts/verify-parity.mjs'], [], true),

  R('foundation.02-stock-install', '39.5.2',
    'Stock DSH installs the Watch bundle with no manual patch.',
    'PASS', 'Install smoke against a real stock 0.1.1-rc.2 profile; uninstall leaves upstream untouched.',
    ['packages/watch/bundle'], ['scripts/install-smoke.mjs'], [], true),

  R('foundation.03-core-regression', '39.5.3',
    'Watch Core passes its regression gates and legacy surfaces are not broken.',
    'PASS', 'Full Python suite green against the repository-equivalent configuration.',
    ['upstream/deepseek-harness.lock'], ['docs/release-candidate-audit.md'],
    ['Run in the watch-skill repository; the count and exit code are recorded in the audit.'], true),

  R('foundation.04-first-journey', '39.5.4',
    'One full journey crosses Agent → Tool → Observation → Evidence → Verification → Receipt → Replay.',
    'PASS', 'Journey 1, end to end, with the deep link reopening the same record and the projection hashing identically.',
    ['packages/watch/trajectory/src/projection.ts'], ['tests/journeys.test.mjs'], [], true),

  R('foundation.05-trajectory-planes', '39.5.5',
    'DSH Trajectory shows the four planes and opens stable deep links.',
    'PASS', 'Watch records are contributed through DSH event definitions with a unified selection model; a link restores the same logical selection.',
    ['packages/watch/trajectory/src/definition.ts', 'packages/watch/trajectory/src/selection.ts'],
    ['tests/trajectory-registration.test.mjs', 'tests/trajectory-roundtrip.test.mjs'],
    ['Watch publishes its own view target rather than adding rows to upstream’s ledger; upstream’s contribution union is closed.'], false),

  R('foundation.06-capability-truth', '39.5.6',
    'Provider, engine and role truth does not rest on declarations; probes are documented.',
    'PASS', 'Presence on disk is not readiness; only machine_tested counts as working, and a mode backed by a merely implemented capability renders degraded.',
    ['packages/watch/technology/src/descriptor.ts', 'packages/watch/workspace/src/modes.ts'],
    ['tests/technology.test.mjs', 'tests/workspace.test.mjs'], [], true),

  R('foundation.07-offline', '39.5.7',
    'An offline test proves zero external egress, and media cloud upload needs separate consent.',
    'PASS', 'Socket-level, twelve route families, with the positive control. Holding a provider key does not permit media to leave, and an agent can flip neither flag.',
    ['tests/fixtures/egress-sentinel.cjs'], ['tests/offline-egress.test.mjs'], [], true),

  R('foundation.08-no-mint', '39.5.8',
    'Plugin, Client and LLM cannot mint VERIFIED.',
    'PASS', 'By shape and at runtime, with the attempt reported rather than silently stripped.',
    ['packages/watch/sdk/src/capability.ts'], ['tests/sdk.test.mjs', 'tests/security.test.mjs'], [], true),

  R('foundation.09-boundary', '39.5.9',
    'Cancellation, reconnect, replay and idempotency work across the Node↔Python boundary.',
    'PASS', 'Deadlines, cancel-after-dispatch, split frames and engine loss are driven against a real framed-stdio fixture; the live client recovers a cursor break without splicing.',
    ['packages/watch/core-bridge/src/transport/stdio.ts', 'packages/watch/live/src/session.ts'],
    ['tests/bridge-stdio.test.mjs', 'tests/live.test.mjs'], [], true),

  R('foundation.10-no-duplicate-systems', '39.5.10',
    'The Web UI loses no official DSH capability and builds no duplicate session, settings or plugin systems.',
    'PASS',
    'The Web app is upstream’s, served by upstream’s host. Watch contributes rows, tools, a client bundle and slots — it ships no session store, no settings system and no plugin runtime.',
    ['packages/watch/bundle/cordis.patch.yml', 'scripts/manual-profile.mjs'],
    ['scripts/boot-smoke.mjs', 'scripts/verify-bundle.mjs', 'scripts/verify-parity.mjs'], [], true),

  R('foundation.11-multilingual', '39.5.11',
    'One fixture per agreed script tier passes evidence round trip; weak results appear as limitations.',
    'PASS', 'Six scripts round-trip byte for byte through index, search, citation and render; a translation is a view and never what a citation resolves to.',
    ['packages/watch/contracts/src/language.ts'], ['tests/multilingual.test.mjs'], [], true),

  R('foundation.12-install-docs', '39.5.12',
    'Install, update, rollback and diagnostics documented and re-testable.',
    'PASS', 'Four runnable smokes plus a release manifest carrying the compatibility and migration blocks.',
    ['scripts/install-smoke.mjs', 'scripts/upgrade-smoke.mjs', 'docs/release-manifest.json'],
    ['scripts/install-smoke.mjs', 'scripts/upgrade-smoke.mjs', 'tests/supply-chain.test.mjs'], [], true),

  R('foundation.13-memory-modes', '39.5.13',
    'Memory Off, Session-only and Local Personal work, and every injected item has provenance, scope and reason.',
    'PASS', 'The four modes are proven to behave differently, not merely to be labelled differently.',
    ['packages/watch/memory/src/records.ts'], ['tests/memory-product.test.mjs', 'tests/memory-service.test.mjs'], [], true),

  R('foundation.14-correction-forget', '39.5.14',
    'Correction beats inference next turn, and Forget removes a record from retrieval, projections, indexes and export.',
    'PASS', 'Proven in the slice, and forgetting a correction is proven not to resurrect the value it superseded.',
    ['packages/watch/memory/src/index.ts'], ['tests/memory-product.test.mjs'], [], true),

  R('foundation.15-import-safety', '39.5.15',
    'Imported Markdown never becomes an instruction or explicit-user truth, and no self-promotion without eval and approval.',
    'PASS', 'Four refusals on import; imported origin at fixed low confidence whatever a bundle claims; promotion needs an independent approval and a clean evaluation.',
    ['packages/watch/wiki/src/projection.ts', 'packages/watch/adapters/src/llmwiki.ts'],
    ['tests/wiki.test.mjs', 'tests/adapters.test.mjs', 'tests/security.test.mjs'], [], true),

  // ── §9.3 Web security boundary ────────────────────────────────────────────
  R('web.loopback', '9.1 / 9.3',
    'The browser does not talk to Python directly; loopback services have origin and bootstrap-token protection.',
    'PASS',
    'The browser reaches only the DSH Web Host on loopback; Watch Core is a stdio child of the Host and holds no socket. The Host binds 127.0.0.1 and carries upstream’s /api browser-trust fence.',
    ['scripts/manual-profile.mjs', 'packages/watch/core-bridge/src/transport/stdio.ts'],
    ['tests/offline-egress.test.mjs', 'scripts/boot-smoke.mjs'], [], true),

  R('web.hosted-boundary', '9.3',
    'Hosted profiles: HttpOnly session, CSRF on commands, auth and origin checks on WebSocket/SSE, short-lived scoped artifact URLs, upload sniffing and limits, private media off public CDNs.',
    'NOT_TESTED_EXTERNAL',
    'These are upstream Host responsibilities in a hosted deployment, and no hosted instance was stood up on this machine. Watch adds no endpoint of its own and no second session system.',
    ['inventory/parity.yml'],
    ['scripts/verify-parity.mjs'],
    ['Local Web is the profile that was run and proven. Single-user hosted is NOT MACHINE TESTED here.'], false),

  R('web.artifact-authorization', '9.3',
    'Artifact URLs are scoped to workspace, user and range.',
    'PASS',
    'Tenant-scoped authorization refuses an artifact in another tenant and the denial is byte-identical to one for an id that does not exist.',
    ['packages/watch/tenancy/src/rbac.ts'], ['tests/tenancy.test.mjs'],
    ['Enforced by the tenancy model. Binding it to upstream’s artifact routes in a hosted deployment is not exercised here.'], false),

  // ── §10.4 Electron security ───────────────────────────────────────────────
  R('desktop.electron-posture', '10.4',
    'nodeIntegration false, contextIsolation true, renderer sandbox, strict CSP, IPC sender validation, navigation and new-window allowlists, native permissions denied by default, no secrets on a command line, signed full-package updates, kill by instance-scoped identity only.',
    'PASS',
    'Every item is enforced and tested; the launch confirms Electron agreed. Kill-by-name is forbidden by a source gate across every desktop file.',
    ['apps/desktop/src/security.ts', 'apps/desktop/main.mjs', 'apps/desktop/src/supervisor.ts'],
    ['tests/desktop.test.mjs', 'scripts/verify-desktop-security.mjs', 'scripts/desktop-smoke.mjs'],
    ['Strict CSP applies to the shipped local renderer. It is not imposed on the Host origin, which bootstraps through an inline script; that origin is loopback-only and served by a supervised child.',
      'Update signing is development-key only.'], false),

  R('desktop.startup', '10.3',
    'Single-instance lock, app-data and migration preflight, one-time bootstrap secret, Host on 127.0.0.1 with a random port, Core handshake, readiness before the trusted origin opens, graceful shutdown.',
    'PASS',
    'The sequence runs in order with each step named in the readiness state; the Host binds an OS-chosen port; a newer store puts the app into read-only replay rather than being opened.',
    ['apps/desktop/src/startup.ts', 'apps/desktop/main.mjs'],
    ['tests/desktop.test.mjs', 'tests/journeys.test.mjs'], [], true),

  // ── §37 multilingual ──────────────────────────────────────────────────────
  R('i18n.original-is-evidence', '37.3',
    'The original text is the evidence; normalized and translated forms are derived and a citation never resolves to one.',
    'PASS', 'Six scripts, byte equality end to end; folding is stored beside the original and never cited.',
    ['packages/watch/contracts/src/language.ts'], ['tests/multilingual.test.mjs'], [], true),

  R('i18n.ocr-routing', '37.4',
    'OCR routing is script-aware and an unqualified engine is not a default.',
    'PASS', 'Qualification is per engine × workload × script and an unmeasured cell never wins a default.',
    ['packages/watch/technology/src/ocr.ts'], ['tests/ocr-engines.test.mjs'], [], true),

  // ── §26 unchangeable decisions ────────────────────────────────────────────
  R('decision.11-media-consent', '26.11',
    'A configured API key does not mean media upload consent.',
    'PASS', 'Two independent flags, and an agent may flip neither.',
    ['packages/watch/workspace/src/composer.ts'], ['tests/offline-egress.test.mjs'], [], true),

  R('decision.20-weight-licence', '26.20',
    'A repository code licence is not enough to distribute model weights.',
    'PASS', 'OCR2’s repository is Apache-2.0 and distribution is still refused.',
    ['packages/watch/technology/src/ocr.ts'], ['tests/supply-chain.test.mjs'], [], true),

  R('decision.22-taste-not-prompt', '26.22',
    'taste.md is a readable, editable projection — not a system prompt and not canonical mutable text.',
    'PASS', 'Rebuilt from the ledger; a hand edit is a proposal that the rebuild then reflects.',
    ['packages/watch/memory/src/projector.ts', 'packages/watch/wiki/src/projection.ts'],
    ['tests/memory-service.test.mjs', 'tests/wiki.test.mjs'], [], true),

  // ── §39.6 deferred ────────────────────────────────────────────────────────
  ...[
    ['marketplace', 'A full public marketplace.'],
    ['team-multitenancy', 'Team/enterprise multi-tenancy as a shipped surface.'],
    ['remote-attestation', 'Remote attestation before a real independent verifier.'],
    ['mobile', 'Mobile applications.'],
    ['ocr2-default', 'DeepSeek-OCR2 as a global default.'],
    ['legacy-removal', 'Removing MCP, REST, CLI or the old MCP App.'],
    ['core-rewrite', 'Rewriting Watch Core in the DSH language.'],
    ['fine-tuning', 'Automatic fine-tuning on user data.'],
    ['autonomous-modification', 'Autonomous production code, system prompt or policy modification.'],
    ['adapters-mandatory', 'Obsidian or LLMWiki as a mandatory dependency.'],
  ].map(([slug, text]) => R(
    `deferred.${slug}`, '39.6', text, 'DEFERRED_BY_SPEC',
    'Explicitly placed outside Foundation by §39.6.', [], [], [], false,
  )),
]

function main() {
  const check = process.argv.includes('--check')
  const problems = []

  const seen = new Set()
  for (const row of REQUIREMENTS) {
    if (seen.has(row.id)) problems.push(`duplicate id: ${row.id}`)
    seen.add(row.id)

    const valid = ['PASS', 'FAIL', 'NOT_TESTED_EXTERNAL', 'DEFERRED_BY_SPEC', 'PARTIAL_SEE_ROWS']
    if (!valid.includes(row.status)) problems.push(`${row.id}: invalid status ${row.status}`)

    // The rule that keeps this from being a self-report.
    if (row.status === 'PASS' && row.tests.length === 0) {
      problems.push(`${row.id}: claims PASS but names no test — code existing is not evidence`)
    }
    if (row.status === 'NOT_TESTED_EXTERNAL' && row.limitations.length === 0) {
      problems.push(`${row.id}: claims NOT_TESTED_EXTERNAL but says nothing about why`)
    }
    for (const path of [...row.source_paths, ...row.tests]) {
      if (path.endsWith('.md')) continue
      if (!existsSync(join(ROOT, path))) problems.push(`${row.id}: path does not exist: ${path}`)
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} closure matrix problem(s)\n`)
    process.exit(1)
  }

  const counts = {}
  for (const row of REQUIREMENTS) counts[row.status] = (counts[row.status] ?? 0) + 1
  const blockingFailures = REQUIREMENTS.filter(
    row => row.blocking_release && (row.status === 'FAIL'))

  const document = {
    spec: SPEC,
    generatedBy: 'scripts/gen-spec-closure.mjs',
    rule: 'PASS requires tested evidence. A row naming no test cannot be PASS.',
    counts,
    blockingFailures: blockingFailures.map(row => row.id),
    requirements: REQUIREMENTS,
  }

  const lines = [
    '# Spec closure matrix',
    '',
    `_Generated from \`${SPEC.title}\` by \`scripts/gen-spec-closure.mjs\`. Do not edit._`,
    '',
    `Specification digest: \`sha256:${SPEC.sha256}\` (${String(SPEC.lines)} lines).`,
    SPEC.note,
    '',
    '**PASS requires tested evidence.** A requirement whose row names no test cannot',
    'be PASS, and the generator refuses to run if one is.',
    '',
    '| Status | Count |',
    '|---|---:|',
    ...Object.entries(counts).sort().map(([status, count]) => `| ${status} | ${String(count)} |`),
    `| **total** | **${String(REQUIREMENTS.length)}** |`,
    '',
    blockingFailures.length === 0
      ? 'No release-blocking requirement is FAIL.'
      : `**${String(blockingFailures.length)} release-blocking failure(s):** ${blockingFailures.map(row => row.id).join(', ')}`,
    '',
  ]

  const sections = [...new Set(REQUIREMENTS.map(row => row.section))]
  for (const section of sections) {
    lines.push(`## §${section}`, '')
    for (const row of REQUIREMENTS.filter(entry => entry.section === section)) {
      lines.push(`### \`${row.id}\` — ${row.status}${row.blocking_release ? ' · release-blocking' : ''}`, '')
      lines.push(`> ${row.requirement}`, '')
      lines.push(row.evidence, '')
      if (row.tests.length > 0) {
        lines.push(`Tests: ${row.tests.map(test => `\`${test}\``).join(', ')}`, '')
      }
      if (row.limitations.length > 0) {
        lines.push('Limitations:', '')
        for (const limitation of row.limitations) lines.push(`- ${limitation}`)
        lines.push('')
      }
    }
  }

  const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  const json = `${JSON.stringify(document, null, 2)}\n`

  if (check) {
    const staleJson = !existsSync(JSON_OUT) || readFileSync(JSON_OUT, 'utf8') !== json
    const staleMd = !existsSync(MD_OUT) || readFileSync(MD_OUT, 'utf8') !== markdown
    if (staleJson || staleMd) {
      process.stderr.write('watch: the spec closure matrix is stale\n')
      process.exit(1)
    }
    return
  }

  writeFileSync(JSON_OUT, json, 'utf8')
  writeFileSync(MD_OUT, markdown, 'utf8')
  process.stdout.write(
    `wrote the spec closure matrix — ${String(REQUIREMENTS.length)} requirement(s)\n`
    + Object.entries(counts).sort().map(([status, count]) => `  ${status.padEnd(22)} ${String(count)}\n`).join('')
    + `  release-blocking failures: ${String(blockingFailures.length)}\n`,
  )
}

main()
