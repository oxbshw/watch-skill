/**
 * Core's verdict has to arrive on the receipt it is about.
 *
 * It did not. In a clean room built from the release artifacts, with a real
 * provider and a real Core over stdio, Core ran three contracts and returned
 * three real verdicts — two `pass` and one `fail`, on disk, re-readable with
 * `watch-skill verify show`. Every one of the thirteen execution receipts in
 * the Library read `verdict: null`, so the Library's VERIFIED/FAILED filter
 * matched nothing and Compare reported two verification records as *"only on
 * one side"*, each labelled `unchecked`.
 *
 * The half that was already tested is the Library index: given a verdict
 * revision it stores and finds it, which `library-receipt-index.test.mjs`
 * proves by calling `addLive` with a verdict already set. That test cannot fail
 * for the reason this defect existed, because it never runs the listener that
 * is supposed to *produce* the revision. This file mounts the real
 * `@deepwatch/dsh-tools` plugin — the one that ships — and drives it through
 * the same events the Host emits.
 *
 * The three properties that matter, and each of them was a way to get this
 * wrong:
 *
 *  - **Order does not decide the outcome.** An attestation can arrive before
 *    the receipt it belongs to. Dropping it then is how an authoritative
 *    result gets discarded for a race, so it is held and applied when the
 *    receipt appears.
 *  - **Repeat delivery is harmless.** The same attestation twice leaves one
 *    record with one verdict, not two records or a moved revision.
 *  - **A verdict is never invented or moved.** A null stays null, a verdict is
 *    never overwritten by an absence, and an attestation whose key matches no
 *    receipt never lands on a different one.
 *
 * ADR-002 is untouched: nothing here decides a verdict. Core's answer is
 * carried, and `pass`, `fail` and `inconclusive` stay three different things.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, 'packages', 'watch', 'tools', 'lib', 'index.js')

const toolsPlugin = await import(pathToFileURL(TOOLS).href)

/**
 * The id the product gives one execution's receipt.
 *
 * Named through the product rather than restated here. The receipt's natural
 * identity is its idempotency key, which is a path shape the query contract
 * refuses -- a row that could be listed and not opened. Asking the product
 * what it calls the record keeps these tests honest if that answer changes
 * again.
 */
const recordIdFor = toolsPlugin.receiptRecordId

const BASE = mkdtempSync(join(tmpdir(), 'watch-verdict-join-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })
let rooms = 0
const freshWorkspace = () => {
  rooms += 1
  const dir = join(BASE, `ws-${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The settled record shape the ledger announces. */
const receiptEvent = (over = {}) => ({
  version: 1,
  sessionId: 'session-1',
  turnId: 'agent-1#1',
  callId: 'c1',
  attempt: 1,
  idempotencyKey: 'session-1/agent-1#1/c1#1',
  toolName: 'watch_verify',
  state: 'completed',
  startedAt: '2026-09-04T00:00:00.000Z',
  endedAt: '2026-09-04T00:00:01.000Z',
  sideEffect: 'unknown',
  scope: 'not_applicable',
  paths: [],
  inputSummary: '{}',
  outputSummary: 'ok',
  ...over,
})

/** The attestation shape `observation.attest` settles into. */
const attestationEvent = (over = {}) => ({
  idempotencyKey: 'session-1/agent-1#1/c1#1',
  contractId: 'op_1',
  coreVerdict: 'VERIFIED',
  coreReason: 'all checks passed',
  verificationId: 'vr_abc123',
  state: 'answered',
  at: '2026-09-04T00:00:02.000Z',
  ...over,
})

class StubService extends Service {
  constructor(ctx, name) { super(ctx, name) }
}

/** Mount the shipped tools plugin with the services it injects. */
async function mount() {
  const workspace = freshWorkspace()
  const ctx = new Context()
  await ctx.plugin(class Tools extends Service {
    constructor(c) { super(c, 'tools') }
    register() {}
  })
  await ctx.plugin(class Core extends Service {
    constructor(c) { super(c, 'watchCore') }
    async request() { return {} }
  })
  await ctx.plugin(class Prompt extends Service {
    constructor(c) { super(c, 'systemPrompt') }
    section() {}
  })
  await ctx.plugin(class Llm extends Service {
    constructor(c) { super(c, 'llm') }
  })
  await ctx.plugin(class Provenance extends Service {
    constructor(c) { super(c, 'watchProvenance') }
    activeTurn() { return 'agent-1#1' }
  })
  await ctx.plugin(toolsPlugin, {
    queryTimeoutMs: 1000, verifyTimeoutMs: 1000, readTimeoutMs: 1000,
    liveStartTimeoutMs: 1000, actTimeoutMs: 1000, observeTimeoutMs: 1000,
    evidenceRoots: [], workspaceScope: 'default',
  })
  // Let the fork settle before anything is emitted at it.
  await new Promise((done) => { setTimeout(done, 30) })
  return { ctx, workspace }
}

/**
 * Every record the plugin has filed, read the way the product reads them.
 *
 * Through `watchQuery.librarySearch` rather than by reaching into the index:
 * that is the transport Compare and the Library mode are on the other end of,
 * so a verdict that does not survive it has not arrived where it is needed.
 */
async function records(ctx) {
  const query = ctx.get('watchQuery')
  if (query === undefined || query === null) return null
  const response = await query.librarySearch({
    protocol: 1, requestId: `t${String(Date.now())}`, query: '',
    modalities: [], limit: 100, cursor: null, deadlineMs: 5000,
  }, new AbortController().signal)
  return response.records ?? []
}

const settle = () => new Promise((done) => { setTimeout(done, 40) })

describe('Core’s verdict reaches the record it is about', () => {
  test('receipt first, then the attestation', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    await settle()
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()

    const found = await records(ctx)
    assert.notEqual(found, null, 'the plugin exposes no way to read its records')
    const row = found.find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.ok(row !== undefined, `no record was filed: ${JSON.stringify(found)}`)
    assert.equal(row.verdict, 'VERIFIED', 'Core’s verdict never reached the receipt')
    assert.ok((row.tags ?? []).includes('verdict:VERIFIED'))
    assert.deepEqual(row.evidenceIds, ['vr_abc123'],
      'the verification record is what makes the verdict openable')
  })

  test('attestation first, then the receipt — the answer is not thrown away', async () => {
    // An authoritative result must not be discarded because the record it is
    // about has not been announced yet. This is the ordering that produced
    // `verdict: null` on every row in a real room.
    const { ctx } = await mount()
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    ctx.emit('watch/execution-recorded', receiptEvent())
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.ok(row !== undefined, 'no record was filed')
    assert.equal(row.verdict, 'VERIFIED',
      'the verdict arrived first and was dropped instead of held')
  })

  test('the same attestation twice leaves one record with one verdict', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()

    const all = (await records(ctx)).filter(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(all.length, 1, 'repeat delivery split one receipt into several records')
    assert.equal(all[0].verdict, 'VERIFIED')
  })

  test('pass, fail and inconclusive stay three different answers', async () => {
    for (const verdict of ['VERIFIED', 'FAILED', 'INCONCLUSIVE']) {
      const { ctx } = await mount()
      ctx.emit('watch/execution-recorded', receiptEvent())
      ctx.emit('watch/attestation-recorded', attestationEvent({ coreVerdict: verdict }))
      await settle()
      const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
      assert.equal(row.verdict, verdict, `${verdict} did not survive the join`)
      assert.ok((row.tags ?? []).includes(`verdict:${verdict}`))
    }
  })

  test('an attestation Core never answered leaves the receipt unverified', async () => {
    // `requested_but_not_run` and `unavailable` are real states. Writing a
    // verdict for either would be the Host deciding one, which ADR-002 forbids.
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded',
      attestationEvent({ coreVerdict: null, state: 'requested_but_not_run' }))
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, null, 'an unanswered attestation produced a verdict')
    assert.ok(!(row.tags ?? []).some(tag => tag.startsWith('verdict:')))
  })

  test('a verdict is never overwritten by a later absence', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent({ coreVerdict: 'FAILED' }))
    await settle()
    ctx.emit('watch/attestation-recorded',
      attestationEvent({ coreVerdict: null, state: 'unavailable' }))
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, 'FAILED', 'an absence erased an answer Core had given')
  })

  test('an attestation for an unknown call never lands on another record', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded',
      attestationEvent({ idempotencyKey: 'session-9/agent-9#9/zz#1', coreVerdict: 'FAILED' }))
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, null, 'a stranger’s verdict was attached to this receipt')
  })
})
describe('replay cannot erase an answer Core gave', () => {
  // The reproduced sequence: receipt, `pass`, then the same receipt again left
  // the row at `verdict: null` — and repeating the attestation could not fix
  // it, because the join thought it had already been applied. The answer was
  // gone from the Library and from the journal, and nothing said so.

  test('a duplicate receipt does not downgrade a verified row', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    assert.equal((await records(ctx))
      .find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1')).verdict, 'VERIFIED')

    // The same receipt again, as a reconcile or a replay delivers it.
    ctx.emit('watch/execution-recorded', receiptEvent())
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, 'VERIFIED', 'a duplicate receipt erased the verdict')
    assert.ok((row.tags ?? []).includes('verdict:VERIFIED'))
    assert.deepEqual(row.evidenceIds, ['vr_abc123'],
      'the row kept a verdict but lost the record it came from')
  })

  test('a duplicate receipt carrying a newer execution state keeps both', async () => {
    // The legitimate case the fix must not break: an execution state really
    // can change, and the newer observation is the truthful one. What must
    // survive alongside it is the verdict.
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent({ state: 'running' }))
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    ctx.emit('watch/execution-recorded', receiptEvent({ state: 'completed' }))
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.ok((row.tags ?? []).includes('state:completed'), 'the newer state was lost')
    assert.ok(!(row.tags ?? []).includes('state:running'), 'the stale state survived')
    assert.equal(row.verdict, 'VERIFIED', 'the verdict was lost with the state update')
  })

  test('repeating the attestation after a downgrade still repairs it', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()

    const all = (await records(ctx)).filter(e => e.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(all.length, 1)
    assert.equal(all[0].verdict, 'VERIFIED')
  })

  test('a second verification of the same call is a new answer, not a repeat', async () => {
    // Idempotency keys on execution identity *and* verification identity. Two
    // verifications can both say VERIFIED and be answers to different
    // questions; comparing only the word would keep the first one's evidence.
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    ctx.emit('watch/attestation-recorded',
      attestationEvent({ verificationId: 'vr_second' }))
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, 'VERIFIED')
    assert.deepEqual(row.evidenceIds, ['vr_second'],
      'a second verification did not replace the evidence link')
  })

  test('a late attestation for a much earlier receipt still lands', async () => {
    const { ctx } = await mount()
    ctx.emit('watch/execution-recorded', receiptEvent())
    for (let i = 2; i <= 6; i += 1) {
      ctx.emit('watch/execution-recorded', receiptEvent({
        idempotencyKey: `session-1/agent-1#1/c${String(i)}#1`, callId: `c${String(i)}`,
      }))
    }
    await settle()
    ctx.emit('watch/attestation-recorded', attestationEvent())
    await settle()

    const row = (await records(ctx)).find(entry => entry.recordId === recordIdFor('session-1/agent-1#1/c1#1'))
    assert.equal(row.verdict, 'VERIFIED', 'a late verdict missed its receipt')
  })
})
