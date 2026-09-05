/**
 * The Bridge answers in an envelope, and the ledger has to open it.
 *
 * `WatchCoreBridge.request<T>` returns `Promise<WatchResult<T>>` — a discriminated
 * envelope, `{ ok: true, value }` or `{ ok: false, error }`. The ledger declared
 * its own structural `CoreRequester` saying `Promise<T>` and read `reply.verdict`
 * straight off it. Against the real Bridge that is `undefined` on every call,
 * so `attest()` settled `requested_but_not_run` with `coreVerdict: null` for
 * work Core had actually verified, and every receipt in the Library read
 * `verdict: null`.
 *
 * The structural interface is what let the two drift: it described a shape
 * nothing implements, and TypeScript agreed with it. The fix imports the real
 * contract, so the compiler has an opinion the next time either side moves.
 *
 * These tests drive `attest()` with the envelope the Bridge actually returns,
 * and with the failure envelope too — a Bridge that refuses is not a verdict,
 * and must not become one.
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

const BASE = mkdtempSync(join(tmpdir(), 'watch-envelope-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })
let rooms = 0
const freshWorkspace = () => {
  rooms += 1
  const dir = join(BASE, `ws-${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A Core that answers the way the Bridge does: in a `WatchResult` envelope.
 *
 * The previous stub returned the payload directly, which is why the tests
 * around this passed while the product did not. Every reply here is wrapped.
 */
class EnvelopeCore extends Service {
  constructor(ctx, config) {
    super(ctx, 'watchCore')
    this.asked = []
    this.reply = config?.reply ?? { ok: true, value: { verdict: 'VERIFIED', reason: 'all checks passed', verificationId: 'vr_1' } }
  }

  async request(method, params) {
    this.asked.push({ method, params })
    return this.reply
  }
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
      call.result ?? { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] })
    this.ctx.emit('tools/result', exec, result)
    return result
  }
}

class StubProvenance extends Service {
  constructor(ctx) { super(ctx, 'watchProvenance') }
  activeTurn() { return 'agent-1#1' }
}

async function mount(reply) {
  const workspace = freshWorkspace()
  const ctx = new Context()
  await ctx.plugin(StubProvenance)
  await ctx.plugin(EnvelopeCore, reply === undefined ? {} : { reply })
  await ctx.plugin(observationPlugin)
  await ctx.plugin(StubTools, { workspace })
  ctx.get(OBSERVATION_SERVICE).setWorkspace(workspace, 'session-1')
  return { ctx, workspace, observation: ctx.get(OBSERVATION_SERVICE), tools: ctx.get('tools') }
}

const settle = () => new Promise((done) => { setTimeout(done, 40) })

/** One ordinary in-workspace write, which is what gets attested. */
async function write(host, name = 'a.json') {
  await host.tools.execute({
    callId: 'c1', name: 'write',
    arguments: { path: join(host.workspace, name), content: '{"ok":true}' },
  })
  await settle()
  return host.observation.allAttestations()[0]
}

describe('the ledger reads the envelope the Bridge returns', () => {
  test('a successful envelope yields Core’s verdict', async () => {
    const host = await mount()
    const made = await write(host)
    assert.equal(host.asked ?? host.observation !== null, true)
    assert.equal(made.state, 'answered',
      'the ledger did not recognise a successful Bridge reply')
    assert.equal(made.coreVerdict, 'VERIFIED',
      'the verdict was inside `value` and was read off the envelope instead')
    assert.equal(made.coreReason, 'all checks passed')
  })

  test('the verification id comes from the envelope too', async () => {
    const host = await mount({
      ok: true,
      value: { verdict: 'FAILED', reason: 'digest differs', verificationId: 'vr_42' },
    })
    const made = await write(host)
    assert.equal(made.coreVerdict, 'FAILED')
    assert.equal(made.verificationId, 'vr_42',
      'the record Core wrote is what makes a verdict openable')
  })

  test('snake_case from the wire is accepted', async () => {
    const host = await mount({
      ok: true, value: { verdict: 'VERIFIED', verification_id: 'vr_snake' },
    })
    const made = await write(host)
    assert.equal(made.coreVerdict, 'VERIFIED')
    assert.equal(made.verificationId, 'vr_snake')
  })

  test('a refusing Bridge is not a verdict', async () => {
    // `{ ok: false }` is the Bridge saying it could not ask. Turning that into
    // a pass would be the Host deciding an answer only Core may give, and
    // turning it into a FAILED would be worse: it would report work as broken
    // because a socket was.
    const host = await mount({
      ok: false,
      error: { code: 'bridge.not_connected', message: 'no engine', fix: 'reconnect' },
    })
    const made = await write(host)
    assert.equal(made.coreVerdict, null)
    assert.notEqual(made.state, 'answered')
    assert.equal(made.state, 'unavailable',
      'a refused request should read as unavailable, not as an unasked one')
  })

  test('a success envelope with no verdict is still not a verdict', async () => {
    const host = await mount({ ok: true, value: { reason: 'core was busy' } })
    const made = await write(host)
    assert.equal(made.coreVerdict, null)
    assert.equal(made.state, 'requested_but_not_run')
  })

  test('a bare payload — the shape the old interface described — is refused', async () => {
    // Nothing returns this. Accepting it anyway would let the structural
    // interface drift back, because the tests would keep passing.
    const host = await mount({ verdict: 'VERIFIED', reason: 'direct payload' })
    const made = await write(host)
    assert.equal(made.coreVerdict, null,
      'an unenveloped reply was accepted, so the two sides can drift again')
  })
})
describe('a verification the agent asked for is attested from its own result', () => {
  // `watch_verify` touches no path, so the operation contract finds nothing to
  // check and settles `no_contract` — a completed verification whose receipt
  // said nobody verified anything. Core already answered; the answer is in the
  // tool's own result and only had to be carried to the receipt.

  /** Dispatch `watch_verify` through the ledger, returning what it attested. */
  async function verified(value) {
    const host = await mount()
    await host.tools.execute({
      callId: 'v1', name: 'watch_verify',
      arguments: { expectation: 'the total is 60' },
      result: { isError: false, value, content: [{ type: 'text', text: 'ok' }] },
    })
    await settle()
    return host.observation.allAttestations()[0]
  }

  test('Core’s verdict lands on the receipt, without a second contract', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'v1', name: 'watch_verify',
      arguments: { expectation: 'the total is 60' },
      result: {
        isError: false,
        value: { verdict: 'VERIFIED', reason: '2 of 2 checks passed', verificationId: 'vr_real' },
        content: [{ type: 'text', text: 'ok' }],
      },
    })
    await settle()

    const made = host.observation.allAttestations()[0]
    assert.equal(made.state, 'answered', 'the receipt said nobody verified anything')
    assert.equal(made.coreVerdict, 'VERIFIED')
    assert.equal(made.verificationId, 'vr_real',
      'the receipt does not point at the record Core actually wrote')
    assert.equal(made.basis, 'core_verification')

    // And no second verification was run to obtain the association.
    const asked = host.ctx.get('watchCore').asked
      .filter(entry => entry.method === 'watch.verification.run')
    assert.equal(asked.length, 0,
      'a second contract was run just to get an association')
  })

  test('FAILED and INCONCLUSIVE are carried as faithfully as VERIFIED', async () => {
    for (const verdict of ['FAILED', 'INCONCLUSIVE', 'UNVERIFIED']) {
      const made = await verified({ verdict, verificationId: `vr_${verdict}` })
      assert.equal(made.coreVerdict, verdict)
      assert.equal(made.state, 'answered')
    }
  })

  test('a verification with no id is not attached to anything', async () => {
    // A verdict nobody can open is the kind of claim this product refuses to
    // make, so it falls back to the ordinary path rather than inventing a link.
    const made = await verified({ verdict: 'VERIFIED' })
    assert.notEqual(made.basis, 'core_verification')
    assert.equal(made.coreVerdict, null)
  })

  test('a refusal is not a verdict', async () => {
    const made = await verified({ ok: false, error: 'verify.unavailable', message: 'no core' })
    assert.notEqual(made.basis, 'core_verification')
    assert.equal(made.coreVerdict, null)
  })

  test('an errored watch_verify call carries nothing forward', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'v1', name: 'watch_verify',
      arguments: { expectation: 'x' },
      result: { isError: true, error: { code: 'boom' }, content: [] },
    })
    await settle()
    const made = host.observation.allAttestations()[0]
    assert.equal(made.coreVerdict, null,
      'a failed verification call produced a verdict')
  })

  test('another tool is unaffected and still gets an operation contract', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'b.json'), content: '{"ok":true}' },
    })
    await settle()
    const made = host.observation.allAttestations()[0]
    assert.equal(made.basis, 'operation_checks')
    assert.equal(made.coreVerdict, 'VERIFIED')
  })
})
