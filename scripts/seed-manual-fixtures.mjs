#!/usr/bin/env node
/**
 * Deterministic demo data for the manual-test profile.
 *
 * Everything written here is marked as demo data, in the record itself and not
 * only in a filename, because the one thing this must never do is put something
 * into the product that reads like a real observation. §17.2 is unambiguous
 * about untrusted observed content, and a fixture that looked like a provider
 * result would be exactly the confusion the product exists to prevent.
 *
 * So:
 *
 * - memory records are written through the real `WatchMemoryService`, at the
 *   real origins, subject to the real admission rules. Nothing is inserted
 *   behind them.
 * - the browser, verification and live fixtures are written as JSON the
 *   surfaces read, and every one carries `demo: true` and a `note` saying so.
 * - no fixture claims a verdict. A `VERIFIED` fixture records what Watch Core
 *   *would* return so the surface can be exercised; it is labelled as a
 *   fixture, and nothing in it is presented as an engine result.
 *
 * Usage: node scripts/seed-manual-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import WatchMemoryService from '@watchskill/dsh-memory'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.WATCH_MANUAL_HOME ?? 'G:/watch-manual/dsh-home'
const MEMORY_DIR = join(HOME, 'watch-memory')
const FIXTURE_DIR = join(HOME, 'watch-fixtures')

/** The scope the manual profile works in. */
const SCOPE = {
  userId: 'demo_user',
  workspaceId: 'demo_workspace',
  projectId: 'demo_project',
  sessionId: 'demo_session',
}

/** Every fixture says what it is, in the data. */
const DEMO = {
  demo: true,
  note:
    'DEMO / MANUAL TEST DATA. Deterministic local fixture. Not a provider result, '
    + 'not a machine-tested measurement, and not evidence minted by Watch Core.',
}

function write(name, value) {
  writeFileSync(join(FIXTURE_DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return join(FIXTURE_DIR, name)
}

async function seedMemory() {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal',
    directory: MEMORY_DIR,
    writeProjections: true,
  })
  const written = []
  try {
    const memory = ctx.watchMemory

    // 9 — an explicit preference. `explicit_user` requires an authenticated
    // action, which seeding is; anything weaker would be admitted at a lower
    // origin and that is the rule working, not a limitation.
    const preference = memory.remember({
      kind: 'preference',
      content: 'DEMO: in this project, answer with the citation first, then the detail',
      origin: 'explicit_user',
      subjectScope: 'project',
      scopeId: SCOPE.projectId,
    }, { userAuthenticated: true })
    written.push(['preference', preference.memoryId, preference.status])

    // A decision and a lesson, so Decisions and Lessons are not empty.
    const decision = memory.remember({
      kind: 'decision',
      content: 'DEMO: this workspace runs the type build before the tests',
      origin: 'explicit_user',
      subjectScope: 'project',
      scopeId: SCOPE.projectId,
    }, { userAuthenticated: true })
    written.push(['decision', decision.memoryId, decision.status])

    const lesson = memory.remember({
      kind: 'lesson',
      content: 'DEMO: a page saying "Saved" is not evidence the row was written',
      origin: 'explicit_user',
      subjectScope: 'workspace',
      scopeId: SCOPE.workspaceId,
    }, { userAuthenticated: true })
    written.push(['lesson', lesson.memoryId, lesson.status])

    const failure = memory.remember({
      kind: 'failure',
      content: 'DEMO: the Friday deploy broke the migration and was rolled back',
      origin: 'explicit_user',
      subjectScope: 'project',
      scopeId: SCOPE.projectId,
    }, { userAuthenticated: true })
    written.push(['failure', failure.memoryId, failure.status])

    // 12 — a multilingual record, so RTL rendering has something real to show.
    const arabic = memory.remember({
      kind: 'preference',
      content: 'DEMO: اكتب الملخصات بالعربية المصرية، واترك أسماء الملفات كما هي',
      origin: 'explicit_user',
      subjectScope: 'user',
      scopeId: SCOPE.userId,
      locale: 'ar-EG',
    }, { userAuthenticated: true })
    written.push(['arabic preference', arabic.memoryId, arabic.status])

    // 10 — a correction scenario: an inferred preference that a later explicit
    // one supersedes. Left un-corrected so the tester can perform the
    // correction themselves and watch it take effect.
    const inferred = memory.remember({
      kind: 'preference',
      content: 'DEMO: seems to prefer very short replies',
      origin: 'inferred',
      subjectScope: 'user',
      scopeId: SCOPE.userId,
      confidence: 0.55,
    })
    written.push(['inferred (to correct)', inferred.memoryId, inferred.status])

    // 11 — a record specifically for the Forget journey.
    const forgettable = memory.remember({
      kind: 'fact',
      content: 'DEMO: forget me — this record exists so Forget can be tested end to end',
      origin: 'explicit_user',
      subjectScope: 'project',
      scopeId: SCOPE.projectId,
    }, { userAuthenticated: true })
    written.push(['forget target', forgettable.memoryId, forgettable.status])

    // Compile once so "Why remembered?" has an inclusion trace to show.
    const packet = memory.compile(SCOPE)
    written.push(['context packet', `${String(packet.items.length)} item(s)`, `${String(packet.tokenEstimate)} tokens`])

    return written
  } finally {
    await fiber.dispose()
  }
}

function seedFixtures() {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const paths = []

  // 1 & 2 — an indexed source and a citation into it.
  paths.push(write('01-recorded-source.json', {
    ...DEMO,
    sourceId: 'demo_src_installer',
    kind: 'video',
    title: 'DEMO: installer walkthrough',
    locator: 'demo://fixtures/installer-walkthrough',
    revisions: [{
      sourceRevisionId: 'demo_src_installer@r1',
      revision: 1,
      contentDigest: 'sha256:demo-installer-r1',
      observedAt: '2026-08-28T09:00:00.000Z',
      durationMs: 420_000,
      indexState: 'indexed',
      scripts: ['Latin'],
    }],
    citation: {
      evidenceId: 'demo_ev_frame_252',
      sourceRevisionId: 'demo_src_installer@r1',
      temporalRange: { startMs: 252_000, endMs: 252_500 },
      modality: 'visual',
      text: 'Installer reported error 0x80070643',
    },
  }))

  // 3 — a VERIFIED shape.
  paths.push(write('03-verified.json', {
    ...DEMO,
    verificationId: 'demo_ver_ok',
    expectation: 'the status row shows Succeeded after the deploy',
    verdict: 'VERIFIED',
    evidenceRefs: ['demo_ev_post_deploy'],
    checks: [{ checkId: 'row-present', passed: true, detail: 'status=Succeeded' }],
  }))

  // 4 — the false-success case the product exists for.
  paths.push(write('04-browser-false-success.json', {
    ...DEMO,
    scenario: 'The page says success and the world says otherwise.',
    receipt: {
      idempotencyKey: 'demo_idem_submit_1',
      terminalState: 'dispatched',
      resolvedTarget: 'button#submit',
      inputDigest: 'sha256:demo-submit-1',
    },
    pageText: 'Saved successfully.',
    worldEvidence: { httpStatus: 500, body: 'internal error: write rejected' },
    verification: {
      verificationId: 'demo_ver_false_success',
      verdict: 'FAILED',
      reason: 'The page reported success; the API returned 500 and no row was written.',
      evidenceRefs: ['demo_ev_api_500'],
    },
  }))

  // 5 — an action with no executable expectation.
  paths.push(write('05-unverified.json', {
    ...DEMO,
    scenario: 'An action was dispatched with no expectation, so nothing was proven.',
    receipt: { idempotencyKey: 'demo_idem_click_2', terminalState: 'dispatched' },
    verification: {
      verificationId: 'demo_ver_none',
      verdict: 'UNVERIFIED',
      reason: 'No executable expectation was supplied for this action.',
      evidenceRefs: [],
    },
  }))

  // 6 — a live session with a real gap in it.
  paths.push(write('06-live-session.json', {
    ...DEMO,
    sessionId: 'demo_live_1',
    target: 'demo://fixtures/deploy-stream',
    kind: 'stream',
    events: [
      { seq: 1, cursor: 'c1', kind: 'status', at: 0, mediaMs: 0, text: 'capture started' },
      { seq: 2, cursor: 'c2', kind: 'speech', at: 2_000, mediaMs: 2_000, text: 'starting the deployment' },
      { seq: 3, cursor: 'c3', kind: 'ocr', at: 4_000, mediaMs: 4_000, text: 'Deploy: in progress' },
      { seq: 4, cursor: 'c4', kind: 'gap', at: 4_000, mediaMs: 4_000, text: 'capture gap', range: { startMs: 4_000, endMs: 30_000 } },
      { seq: 9, cursor: 'c9', kind: 'speech', at: 30_000, mediaMs: 30_000, text: 'and it went through' },
      { seq: 10, cursor: 'c10', kind: 'ocr', at: 31_000, mediaMs: 31_000, text: 'Deploy: succeeded' },
    ],
    gaps: [{ startMs: 4_000, endMs: 30_000 }],
  }))

  // 7 — a source whose revision moved on, so old evidence is STALE.
  paths.push(write('07-library-stale.json', {
    ...DEMO,
    sourceId: 'demo_src_status_page',
    revisions: [
      { sourceRevisionId: 'demo_src_status_page@r1', revision: 1, indexState: 'stale', observedAt: '2026-08-01T10:00:00.000Z' },
      { sourceRevisionId: 'demo_src_status_page@r2', revision: 2, indexState: 'indexed', observedAt: '2026-08-28T10:00:00.000Z' },
    ],
    oldEvidence: {
      evidenceId: 'demo_ev_status_r1',
      sourceRevisionId: 'demo_src_status_page@r1',
      temporalRange: { startMs: 0, endMs: 1_000 },
      expectedFreshness: 'stale',
      stillAddressable: true,
      supersededBy: 'demo_src_status_page@r2',
    },
  }))

  // 8 — before and after, where the first divergence is not the one that matters.
  paths.push(write('08-compare-before-after.json', {
    ...DEMO,
    left: { runId: 'demo_run_before', verdict: 'FAILED' },
    right: { runId: 'demo_run_after', verdict: 'VERIFIED' },
    divergences: [
      { channel: 'visual', atMs: 1_200, kind: 'changed', summary: 'a different frame was captured' },
      { channel: 'verification', atMs: 9_000, kind: 'changed', summary: 'verdict FAILED → VERIFIED' },
    ],
    firstDivergence: { channel: 'visual', atMs: 1_200 },
    firstMeaningfulDivergence: { channel: 'verification', atMs: 9_000 },
  }))

  // 12 — multilingual evidence, six scripts.
  paths.push(write('12-multilingual.json', {
    ...DEMO,
    samples: [
      { id: 'latin', text: 'Deploy succeeded at 12:30, and the health check is green.', direction: 'ltr' },
      { id: 'arabic', text: 'تَمَّ النَّشْرُ بِنَجاحٍ في الساعة 12:30، وفحص السلامة أخضر.', direction: 'rtl' },
      { id: 'han', text: '部署成功，健康检查为绿色。', direction: 'ltr' },
      { id: 'cyrillic', text: 'Развёртывание прошло успешно, проверка состояния зелёная.', direction: 'ltr' },
      { id: 'devanagari', text: 'तैनाती सफल रही, और स्वास्थ्य जाँच हरी है।', direction: 'ltr' },
      { id: 'mixed', text: 'فشل الطلب POST /api/v2/deploy عند 12:30 مع رمز 500.', direction: 'mixed' },
    ],
  }))

  // 13 — two tenants, for the isolation check.
  paths.push(write('13-team-tenants.json', {
    ...DEMO,
    tenants: [
      { tenantId: 'demo_tenant_a', workspaceId: 'demo_ws_a', user: 'demo_ana', role: 'admin' },
      { tenantId: 'demo_tenant_b', workspaceId: 'demo_ws_b', user: 'demo_bea', role: 'owner' },
    ],
    sharedResource: { kind: 'evidence', resourceId: 'demo_ev_shared_a', tenantId: 'demo_tenant_a' },
    expectation: 'demo_bea must not be able to read demo_ev_shared_a, and the denial must not confirm it exists.',
  }))

  return paths
}

async function main() {
  mkdirSync(MEMORY_DIR, { recursive: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })

  const fixtures = seedFixtures()
  const memory = await seedMemory()

  process.stdout.write(
    '\nMANUAL FIXTURES SEEDED\n'
    + `  memory ledger:  ${MEMORY_DIR}\n`
    + memory.map(([label, id, extra]) => `    ${label.padEnd(22)} ${id} ${extra}\n`).join('')
    + `  fixture files:  ${FIXTURE_DIR}\n`
    + fixtures.map(path => `    ${path}\n`).join('')
    + '\n  Every record and file is marked demo:true / DEMO:. None of it is a\n'
    + '  provider result, and none of it is a machine-tested measurement.\n',
  )
}

await main()
