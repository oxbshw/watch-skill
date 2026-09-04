/**
 * One execution, one record, and a denial that cannot be talked out of.
 *
 * The defect these pin was small and total: a refused call produced two
 * records. The containment screen wrote the truthful one — `cancelled`,
 * `scopeDecision: 'denied'` — and then the denial travelled back through the
 * dispatch layer as an ordinary error, which settled into a second record
 * saying `failed` and `scopeDecision: 'allowed'`. Both carried the same
 * idempotency key, the Library stores receipts in a map keyed by exactly that,
 * and so the record an owner read was the one that said the boundary let it
 * through. A boundary that held, described afterwards as never tested.
 *
 * The fix is not suppression of the second write. It is that there is only ever
 * one record per execution, and every producer writes through a reconciliation
 * that knows which observations may move it and which may not. These tests hold
 * that design rather than the symptom, at both levels: the pure reconciler, and
 * the service that a real dispatch drives.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts', 'lib')

const observationPlugin = await import(pathToFileURL(join(TECH, 'observation.js')).href)
const { OBSERVATION_SERVICE, TRACKING_LIMIT } = observationPlugin
const provenancePlugin = await import(pathToFileURL(join(TECH, 'provenance.js')).href)
const {
  EXECUTION_RECORD_VERSION, executionKey, isTerminalState,
  reconcileExecutionRecords, scopeDecisionRank, stateRank,
} = await import(pathToFileURL(join(CONTRACTS, 'index.js')).href)

const BASE = mkdtempSync(join(tmpdir(), 'watch-ledger-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })

const WORKSPACE = join(BASE, 'project')
const OUTSIDE = join(BASE, 'elsewhere', 'notes.md')
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(join(BASE, 'elsewhere'), { recursive: true })
writeFileSync(OUTSIDE, 'not yours', 'utf8')
writeFileSync(join(WORKSPACE, 'index.ts'), 'export const a = 1\n', 'utf8')

class StubProvenance extends Service {
  constructor(ctx) { super(ctx, 'watchProvenance') }
  activeTurn() { return 'agent-1#1' }
}

/**
 * A registry that dispatches through the real lifecycle events.
 *
 * Including the part that caused the defect: when `tools/pre-execute` denies, a
 * result is still emitted. Any harness that skipped that would have made the
 * bug untestable, which is most of why it survived.
 */
class StubTools extends Service {
  constructor(ctx, config) {
    super(ctx, 'tools')
    this.workspace = config?.workspace ?? WORKSPACE
    this.dispatched = []
  }

  async execute(call) {
    const exec = {
      callId: call.callId,
      name: call.name,
      arguments: call.arguments ?? {},
      agent: {
        id: call.agentId ?? 'agent-1',
        session: { id: call.sessionId ?? 'session-1', cwd: call.cwd ?? this.workspace },
        permissions: { current: call.permission ?? 'workspace-write' },
      },
    }
    const decision = await this.ctx.waterfall(
      'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
    if (decision.kind !== 'allow') {
      const refusal = {
        isError: true,
        error: { code: 'denied', message: decision.reason ?? 'denied' },
        content: [{ type: 'text', text: decision.reason ?? 'denied' }],
      }
      this.ctx.emit('tools/result', exec, refusal)
      return { exec, result: refusal }
    }
    const result = await this.ctx.waterfall('tools/execute', exec, async () => {
      this.dispatched.push(call.name)
      return call.result ?? {
        isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }],
      }
    })
    this.ctx.emit('tools/result', exec, result)
    return { exec, result }
  }
}

async function mount({ workspace = WORKSPACE } = {}) {
  const ctx = new Context()
  await ctx.plugin(StubProvenance)
  await ctx.plugin(observationPlugin)
  await ctx.plugin(StubTools, { workspace })
  const observation = ctx.get(OBSERVATION_SERVICE)
  observation.setWorkspace(workspace, 'session-1')
  const announced = []
  ctx.on('watch/execution-recorded', record => { announced.push(record) })
  return { ctx, observation, tools: ctx.get('tools'), announced, workspace }
}

/** A record shaped like the ones the service mints, for reconciler unit tests. */
function record(overrides = {}) {
  const identity = {
    sessionId: overrides.sessionId ?? 'session-1',
    turnId: overrides.turnId ?? 'agent-1#1',
    callId: overrides.callId ?? 'c1',
    attempt: overrides.attempt ?? 1,
  }
  return {
    version: EXECUTION_RECORD_VERSION,
    ...identity,
    idempotencyKey: executionKey(identity),
    rootCallId: null,
    subagentId: null,
    parentTurnId: null,
    toolName: 'write',
    state: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    exitStatus: 'ok',
    sideEffect: 'write',
    scope: 'inside',
    scopeDecision: 'allowed',
    paths: [],
    outsidePathCount: 0,
    inputSummary: '',
    outputSummary: '',
    outputDigest: 'sha256:0',
    authorisedBy: 'agent-1#1',
    verification: 'UNVERIFIED',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('invariant 1 — one execution identity, one canonical receipt', () => {
  test('a refused call leaves exactly one record', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    assert.equal(host.observation.all().length, 1)
    assert.deepEqual(host.tools.dispatched, [])
  })

  test('an allowed call leaves exactly one record', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' },
    })
    assert.equal(host.observation.all().length, 1)
  })

  test('records are addressed by identity, so two writes cannot both survive', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    const keys = host.observation.all().map(entry => entry.idempotencyKey)
    assert.equal(new Set(keys).size, keys.length, 'the ledger holds two rows for one key')
  })
})

describe('invariant 2 — denied never becomes allowed', () => {
  test('the reconciler refuses to soften a denial', () => {
    const denied = record({ state: 'cancelled', scopeDecision: 'denied', exitStatus: 'denied' })
    const settled = record({ state: 'failed', scopeDecision: 'allowed', exitStatus: 'error' })
    const merged = reconcileExecutionRecords(denied, settled)
    assert.equal(merged.scopeDecision, 'denied')
    assert.equal(merged.state, 'cancelled')
  })

  test('denial outranks every other decision', () => {
    for (const weaker of ['allowed', 'approved', 'not_evaluated']) {
      assert.ok(scopeDecisionRank('denied') > scopeDecisionRank(weaker),
        `${weaker} was allowed to overwrite a denial`)
    }
  })

  test('through a real dispatch, the surviving record still says denied', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    const [only] = host.observation.all()
    assert.equal(only.scopeDecision, 'denied')
    assert.equal(only.state, 'cancelled')
    assert.equal(only.exitStatus, 'denied')
    assert.equal(
      host.observation.all().some(entry => entry.scopeDecision === 'allowed'), false)
  })

  test('a denial survives even when the later observation claims success', async () => {
    // The nastier shape: not an error coming back, but a result that looks like
    // the call worked. Nothing may promote a refused call to completed.
    const host = await mount()
    const { exec } = await host.tools.execute({
      callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    host.observation.settle(exec, {
      isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }],
    }, 'session-1')
    const records = host.observation.all()
    assert.equal(records.length, 1)
    assert.equal(records[0].scopeDecision, 'denied')
    assert.equal(records[0].state, 'cancelled')
  })
})

describe('invariant 3 — states move forward, terminal states are final', () => {
  test('progress is ranked, and the terminal states are the ones that end it', () => {
    assert.ok(stateRank('queued') < stateRank('running'))
    assert.ok(stateRank('running') < stateRank('completed'))
    for (const state of ['completed', 'failed', 'cancelled']) {
      assert.equal(isTerminalState(state), true, `${state} is not treated as terminal`)
    }
    for (const state of ['queued', 'running']) {
      assert.equal(isTerminalState(state), false)
    }
  })

  test('a terminal record is not overwritten by another terminal one', () => {
    const done = record({ state: 'completed', exitStatus: 'ok' })
    const later = record({ state: 'failed', exitStatus: 'boom', outputSummary: 'late' })
    const merged = reconcileExecutionRecords(done, later)
    assert.equal(merged.state, 'completed')
    assert.equal(merged.outputSummary, '')
  })

  test('a late running observation cannot un-finish a call', () => {
    const done = record({ state: 'completed' })
    const merged = reconcileExecutionRecords(done, record({ state: 'running' }))
    assert.equal(merged.state, 'completed')
  })

  test('a genuine step forward is taken', () => {
    const opened = record({ state: 'running', endedAt: null, durationMs: null })
    const merged = reconcileExecutionRecords(opened, record({ state: 'completed' }))
    assert.equal(merged.state, 'completed')
    assert.equal(merged.startedAt, opened.startedAt, 'the later view rewrote when it began')
  })
})

describe('invariant 4 — late, duplicated and reordered events', () => {
  test('settling the same result twice does not mint a second record', async () => {
    const host = await mount()
    const { exec, result } = await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' },
    })
    const before = host.observation.all().length
    host.observation.settle(exec, result, 'session-1')
    host.observation.settle(exec, result, 'session-1')
    assert.equal(host.observation.all().length, before)
  })

  test('a duplicate settle is not re-announced to the Library', async () => {
    const host = await mount()
    const { exec, result } = await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' },
    })
    const announced = host.announced.length
    host.observation.settle(exec, result, 'session-1')
    assert.equal(host.announced.length, announced,
      'a stale copy of a receipt was published over the canonical one')
  })

  test('a result arriving after a denial cannot create a second receipt', async () => {
    const host = await mount()
    const { exec } = await host.tools.execute({
      callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    host.observation.settle(exec, { isError: true, error: { code: 'late' }, content: [] },
      'session-1')
    assert.equal(host.observation.all().length, 1)
    assert.equal(host.observation.all()[0].scopeDecision, 'denied')
  })

  test('a begin observed twice for one in-flight call is one call', async () => {
    const host = await mount()
    const exec = {
      callId: 'c1', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' },
      agent: { id: 'agent-1', session: { id: 'session-1', cwd: WORKSPACE } },
    }
    host.observation.begin(exec, 'session-1')
    host.observation.begin(exec, 'session-1')
    host.observation.settle(exec, { isError: false, content: [] }, 'session-1')
    assert.equal(host.observation.all().length, 1)
    assert.equal(host.observation.all()[0].attempt, 1,
      'a duplicated dispatch was numbered as a retry')
  })

  test('records for different executions are never merged', () => {
    const mine = record({ callId: 'c1' })
    const theirs = record({ callId: 'c2', state: 'failed' })
    assert.equal(reconcileExecutionRecords(mine, theirs).callId, 'c1')
    assert.equal(reconcileExecutionRecords(mine, theirs).state, 'completed')
  })
})

describe('invariant 5 — identity is scoped', () => {
  test('the same call id in two sessions is two executions', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'call_1', name: 'write', sessionId: 'session-1',
      arguments: { path: join(WORKSPACE, 'a.json'), content: '{}' },
    })
    host.observation.setWorkspace(WORKSPACE, 'session-2')
    await host.tools.execute({
      callId: 'call_1', name: 'write', sessionId: 'session-2',
      arguments: { path: join(WORKSPACE, 'b.json'), content: '{}' },
    })
    const records = host.observation.all()
    assert.equal(records.length, 2, 'two sessions collided on one call id')
    assert.deepEqual(records.map(entry => entry.sessionId).sort(), ['session-1', 'session-2'])
  })

  test('concurrent calls in one session each get their own record', async () => {
    const host = await mount()
    await Promise.all([1, 2, 3, 4, 5].map(async n => host.tools.execute({
      callId: `c${String(n)}`, name: 'write',
      arguments: { path: join(WORKSPACE, `f${String(n)}.json`), content: '{}' },
    })))
    assert.equal(host.observation.all().length, 5)
    assert.equal(host.observation.openCount(), 0, 'a call was left in flight')
  })

  test('the same tool name repeated is not one execution', async () => {
    const host = await mount()
    for (const n of [1, 2, 3]) {
      await host.tools.execute({
        callId: `w${String(n)}`, name: 'write',
        arguments: { path: join(WORKSPACE, 'same.json'), content: '{}' },
      })
    }
    assert.equal(host.observation.all().length, 3)
  })

  test('a real retry of one call id is a second attempt, not a second action', async () => {
    const host = await mount()
    const args = { path: join(WORKSPACE, 'retry.json'), content: '{}' }
    await host.tools.execute({ callId: 'c1', name: 'write', arguments: args })
    await host.tools.execute({ callId: 'c1', name: 'write', arguments: args })
    const records = host.observation.all()
    assert.equal(records.length, 2)
    assert.deepEqual(records.map(entry => entry.attempt), [1, 2])
    assert.equal(new Set(records.map(entry => entry.idempotencyKey)).size, 2)
  })

  test('records can be read back per session', async () => {
    const host = await mount()
    host.observation.setWorkspace(WORKSPACE, 'session-2')
    await host.tools.execute({
      callId: 'c1', name: 'write', sessionId: 'session-1',
      arguments: { path: join(WORKSPACE, 'a.json'), content: '{}' } })
    await host.tools.execute({
      callId: 'c2', name: 'write', sessionId: 'session-2',
      arguments: { path: join(WORKSPACE, 'b.json'), content: '{}' } })
    assert.equal(host.observation.forSession('session-1').length, 1)
    assert.equal(host.observation.forSession('session-2').length, 1)
  })
})

describe('invariant 6 — tracking is bounded and cleaned', () => {
  test('settled calls stop counting as open', async () => {
    const host = await mount()
    for (const n of [1, 2, 3]) {
      await host.tools.execute({
        callId: `c${String(n)}`, name: 'write',
        arguments: { path: join(WORKSPACE, `x${String(n)}.json`), content: '{}' },
      })
    }
    assert.equal(host.observation.openCount(), 0)
    assert.equal(host.observation.trackedCount(), 3, 'the entries a replay needs were dropped')
  })

  test('tracking does not grow without limit', async () => {
    // Retention is deliberate — a late result has to find its record — so the
    // ceiling is what stops "kept" meaning "kept forever" on a long-lived Host.
    const host = await mount()
    const target = TRACKING_LIMIT + 250
    for (let n = 0; n < target; n += 1) {
      const exec = {
        callId: `c${String(n)}`, name: 'read',
        arguments: { path: join(WORKSPACE, 'index.ts') },
        agent: { id: 'agent-1', session: { id: 'session-1', cwd: WORKSPACE } },
      }
      host.observation.begin(exec, 'session-1')
      host.observation.settle(exec, { isError: false, content: [] }, 'session-1')
    }
    assert.ok(host.observation.trackedCount() <= TRACKING_LIMIT,
      `tracking grew to ${String(host.observation.trackedCount())}`)
  })

  test('the ledger itself stays bounded', async () => {
    const host = await mount()
    const { LEDGER_LIMIT } = observationPlugin
    for (let n = 0; n < LEDGER_LIMIT + 100; n += 1) {
      const exec = {
        callId: `c${String(n)}`, name: 'read',
        arguments: { path: join(WORKSPACE, 'index.ts') },
        agent: { id: 'agent-1', session: { id: 'session-1', cwd: WORKSPACE } },
      }
      host.observation.begin(exec, 'session-1')
      host.observation.settle(exec, { isError: false, content: [] }, 'session-1')
    }
    assert.ok(host.observation.all().length <= LEDGER_LIMIT)
  })

  test('a teardown forgets everything', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' } })
    host.observation.clear()
    assert.equal(host.observation.all().length, 0)
    assert.equal(host.observation.trackedCount(), 0)
  })
})

describe('invariant 7 — replay is idempotent', () => {
  test('replaying a whole turn produces the same ledger, not a doubled one', async () => {
    const host = await mount()
    const calls = [
      { callId: 'c1', name: 'write',
        arguments: { path: join(WORKSPACE, 'a.json'), content: '{}' } },
      { callId: 'c2', name: 'read', arguments: { path: OUTSIDE } },
      { callId: 'c3', name: 'read', arguments: { path: join(WORKSPACE, 'index.ts') } },
    ]
    const seen = []
    for (const call of calls) seen.push(await host.tools.execute(call))
    const first = JSON.stringify(host.observation.all())

    // The same results delivered again, in a different order.
    for (const { exec, result } of [...seen].reverse()) {
      host.observation.settle(exec, result, 'session-1')
    }
    assert.equal(JSON.stringify(host.observation.all()), first,
      'a replay changed the ledger')
  })

  test('a denial replayed stays a denial', async () => {
    const host = await mount()
    const { exec, result } = await host.tools.execute({
      callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    for (const n of [1, 2, 3]) {
      void n
      host.observation.settle(exec, result, 'session-1')
    }
    assert.equal(host.observation.all().length, 1)
    assert.equal(host.observation.all()[0].scopeDecision, 'denied')
  })
})

describe('invariant 8 — the Library is told the canonical truth', () => {
  test('what is announced for a refused call says denied, and is announced once', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    assert.equal(host.announced.length, 1,
      'the Library was handed two receipts for one execution')
    assert.equal(host.announced[0].scopeDecision, 'denied')
    assert.equal(host.announced[0].state, 'cancelled')
  })

  test('the last thing the Library heard is what the ledger holds', async () => {
    // The Library stores receipts in a map keyed by idempotency key, so the last
    // announcement for a key wins. That is exactly how the false record used to
    // displace the true one, and it is why "announced once, canonically" is the
    // property rather than "announced".
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read', arguments: { path: OUTSIDE } })
    await host.tools.execute({
      callId: 'c2', name: 'write',
      arguments: { path: join(WORKSPACE, 'out.json'), content: '{}' } })

    const latest = new Map()
    for (const entry of host.announced) latest.set(entry.idempotencyKey, entry)
    const ledger = new Map(
      host.observation.all().map(entry => [entry.idempotencyKey, entry]))

    assert.equal(latest.size, ledger.size)
    for (const [key, entry] of latest) {
      assert.equal(entry.scopeDecision, ledger.get(key).scopeDecision)
      assert.equal(entry.state, ledger.get(key).state)
    }
  })
})

void provenancePlugin
