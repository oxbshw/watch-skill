/**
 * What the automatic Watch integration must not do.
 *
 * Recording every tool call is only acceptable if it is free of the two things
 * that would make it worse than the gap it fills: spending provider requests,
 * and turning a person's working session into durable memory about them.
 *
 * The first is the sharper risk. The evaluation's turn already processed 2.97M
 * tokens; an integration that added a model call per action would have made a
 * runaway worse while claiming to observe it. Nothing here reaches a provider —
 * a record is assembled from the dispatch that was already happening, and the
 * one outbound call is a Bridge request to Watch Core, which evaluates
 * deterministic checks locally.
 *
 * The second is quieter and worse. Memory in this product is explicit: a person
 * asks for something to be remembered, or it is evidence rather than memory.
 * An observer that filed 76 receipts as durable personal memory would have
 * inverted that in one commit.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const observationPlugin = await import(pathToFileURL(join(TECH, 'observation.js')).href)
const { OBSERVATION_SERVICE } = observationPlugin

const BASE = mkdtempSync(join(tmpdir(), 'watch-cost-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })
let rooms = 0
const freshWorkspace = () => {
  rooms += 1
  const dir = join(BASE, `ws-${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** An adapter that counts every model request anyone makes. */
class CountingLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.dispatched = 0
  }

  stream(options) {
    const ctx = this.ctx
    const self = this
    return (async function* pulled() {
      const inner = await ctx.waterfall('llm/stream', options, () => {
        self.dispatched += 1
        return (async function* served() {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      })
      for await (const chunk of inner) yield chunk
    })()
  }
}

/** A Bridge that counts what it is asked, so a request is not mistaken for a model call. */
class CountingCore extends Service {
  constructor(ctx) {
    super(ctx, 'watchCore')
    this.asked = []
  }

  async request(method, params) {
    this.asked.push(method)
    void params
    return { verdict: 'VERIFIED', reason: 'checks passed' }
  }
}

/** A memory service that records anything anyone tries to remember. */
class CountingMemory extends Service {
  constructor(ctx) {
    super(ctx, 'watchMemory')
    this.remembered = []
  }

  remember(candidate) {
    this.remembered.push(candidate)
    return { stored: true, memoryId: `mem-${String(this.remembered.length)}`, status: 'proposed' }
  }
}

class StubProvenance extends Service {
  constructor(ctx) { super(ctx, 'watchProvenance') }
  activeTurn() { return 'agent-1#1' }
}

class StubTools extends Service {
  constructor(ctx, config) {
    super(ctx, 'tools')
    this.workspace = config.workspace
  }

  async execute(call) {
    const exec = {
      callId: call.callId,
      name: call.name,
      arguments: call.arguments ?? {},
      agent: {
        id: 'agent-1',
        session: { id: 'session-1', cwd: this.workspace },
        permissions: { current: 'workspace-write' },
      },
    }
    const decision = await this.ctx.waterfall(
      'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
    if (decision.kind !== 'allow') {
      const refusal = { isError: true, error: { code: 'denied' }, content: [] }
      this.ctx.emit('tools/result', exec, refusal)
      return refusal
    }
    const result = await this.ctx.waterfall('tools/execute', exec, async () =>
      ({ isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }))
    this.ctx.emit('tools/result', exec, result)
    return result
  }
}

async function mount() {
  const workspace = freshWorkspace()
  const ctx = new Context()
  await ctx.plugin(StubProvenance)
  await ctx.plugin(CountingLlm)
  await ctx.plugin(CountingCore)
  await ctx.plugin(CountingMemory)
  await ctx.plugin(observationPlugin)
  await ctx.plugin(StubTools, { workspace })
  ctx.get(OBSERVATION_SERVICE).setWorkspace(workspace, 'session-1')
  return {
    ctx,
    workspace,
    observation: ctx.get(OBSERVATION_SERVICE),
    llm: ctx.get('llm'),
    core: ctx.get('watchCore'),
    memory: ctx.get('watchMemory'),
    tools: ctx.get('tools'),
  }
}

const settle = () => new Promise((done) => { setTimeout(done, 20) })

describe('observing costs no provider requests', () => {
  test('a busy session of ordinary tool calls reaches no provider', async () => {
    // Roughly the evaluation's shape, at a scale a test can run: reads, writes
    // and shell, none of which is a model call and none of which may become one.
    const host = await mount()
    for (let n = 0; n < 10; n += 1) {
      await host.tools.execute({
        callId: `r${String(n)}`, name: 'read',
        arguments: { path: join(host.workspace, `a${String(n)}.txt`) },
      })
      await host.tools.execute({
        callId: `w${String(n)}`, name: 'write',
        arguments: { path: join(host.workspace, `b${String(n)}.json`), content: '{}' },
      })
      await host.tools.execute({
        callId: `s${String(n)}`, name: 'bash', arguments: { command: 'echo hi' },
      })
    }
    await settle()

    assert.equal(host.observation.all().length, 30, 'the ledger missed calls')
    assert.equal(host.llm.dispatched, 0,
      'the automatic integration spent a provider request')
  })

  test('an attestation is a Bridge request, not a model call', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'out.json'), content: '{}' },
    })
    await settle()
    assert.deepEqual(host.core.asked, ['watch.verification.run'])
    assert.equal(host.llm.dispatched, 0)
  })

  test('an idle Host with a full ledger sends nothing', async () => {
    // The ledger holds records; holding them is not an activity.
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'out.json'), content: '{}' },
    })
    await settle()
    const asked = host.core.asked.length
    await new Promise((done) => { setTimeout(done, 120) })
    assert.equal(host.llm.dispatched, 0)
    assert.equal(host.core.asked.length, asked,
      'the ledger asked something while nobody was doing anything')
  })

  test('a refused call costs nothing either', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'read', arguments: { path: join(BASE, 'outside.txt') },
    })
    await settle()
    assert.equal(host.llm.dispatched, 0)
    assert.equal(host.core.asked.length, 0, 'a refused action was submitted for verification')
  })
})

describe('a tool call is evidence, not a memory about a person', () => {
  test('thirty tool calls create no durable memory', async () => {
    const host = await mount()
    for (let n = 0; n < 10; n += 1) {
      await host.tools.execute({
        callId: `w${String(n)}`, name: 'write',
        arguments: { path: join(host.workspace, `b${String(n)}.json`), content: '{}' },
      })
      await host.tools.execute({
        callId: `r${String(n)}`, name: 'read',
        arguments: { path: join(host.workspace, `a${String(n)}.txt`) },
      })
      await host.tools.execute({
        callId: `s${String(n)}`, name: 'bash', arguments: { command: 'ls' },
      })
    }
    await settle()
    assert.equal(host.observation.all().length, 30)
    assert.equal(host.memory.remembered.length, 0,
      'ordinary work was written into durable personal memory')
  })

  test('the ledger and memory are different stores, and only one is automatic', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'out.json'), content: '{}' },
    })
    await settle()
    // An explicit request is the only thing that reaches memory, and it still
    // works — the observer did not take the seat.
    host.memory.remember({ kind: 'preference', content: 'remember this', origin: 'explicit_user' })
    assert.equal(host.memory.remembered.length, 1)
    assert.equal(host.memory.remembered[0].origin, 'explicit_user')
    assert.equal(host.observation.all().length, 1)
  })
})

describe('the record carries no machine identity', () => {
  test('no record mentions the operating system user or an absolute path', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'deep', 'out.json'), content: 'x' },
    })
    await host.tools.execute({
      callId: 'c2', name: 'read', arguments: { path: join(BASE, 'outside.txt') },
    })
    await settle()

    const serialised = JSON.stringify(host.observation.all())
    // The temporary root contains this machine's user directory on Windows and
    // its home on POSIX, so finding it here would be finding both.
    assert.equal(serialised.includes(BASE), false,
      'a record carried an absolute path from this machine')
    assert.doesNotMatch(serialised, /[A-Za-z]:[\\/]{1,2}Users/i)
    assert.doesNotMatch(serialised, /\/(?:home|Users)\//)
  })

  test('paths inside the workspace survive as workspace-relative', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'src', 'index.ts'), content: 'x' },
    })
    await settle()
    assert.deepEqual(host.observation.all()[0].paths, ['src/index.ts'],
      'redaction removed the useful half along with the disclosing half')
  })
})
