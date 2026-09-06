/**
 * Who is allowed to answer, and what the Host is allowed to ask.
 *
 * ADR-002 is mechanical in this repository: `verify-verdict-authority.mjs`
 * fails the build if anything under `packages` produces a verdict. That rule
 * caught an earlier draft of this work, which evaluated contracts in the Host —
 * a verdict minted by the same process that did the work is the
 * `verification.json` failure with better formatting.
 *
 * So the division these tests hold is: the Host may notice, correlate, freeze
 * and ask; Watch Core answers. Everything below is either about the Host asking
 * a narrow enough question, or about it not pretending to have an answer when
 * Core did not give one.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const observationPlugin = await import(pathToFileURL(join(TECH, 'observation.js')).href)
const attestation = await import(pathToFileURL(join(TECH, 'attestation.js')).href)
const { OBSERVATION_SERVICE } = observationPlugin
const { freezeChecks, operationContract, verificationRequest, writtenContent } = attestation

const BASE = mkdtempSync(join(tmpdir(), 'watch-attest-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })
let rooms = 0
const freshWorkspace = () => {
  rooms += 1
  const dir = join(BASE, `ws-${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** A settled record, in the shape the ledger produces one. */
const recordOf = (over = {}) => ({
  version: 1,
  sessionId: 'session-1',
  turnId: 'agent-1#1',
  callId: 'c1',
  attempt: 1,
  idempotencyKey: 'session-1/agent-1#1/c1#1',
  rootCallId: null,
  subagentId: null,
  parentTurnId: null,
  toolName: 'write',
  state: 'completed',
  startedAt: '2026-09-04T00:00:00.000Z',
  endedAt: '2026-09-04T00:00:01.000Z',
  durationMs: 1000,
  exitStatus: 'ok',
  sideEffect: 'write',
  scope: 'inside',
  scopeDecision: 'allowed',
  paths: ['out.json'],
  outsidePathCount: 0,
  inputSummary: '{}',
  outputSummary: 'ok',
  outputDigest: 'sha256:0',
  authorisedBy: 'agent-1#1',
  verification: 'UNVERIFIED',
  ...over,
})

/**
 * A Core that answers the way the Bridge answers: in a `WatchResult` envelope.
 *
 * It used to return the payload directly, and that is why these tests passed
 * while the product did not. `WatchCoreBridge.request<T>` returns
 * `Promise<WatchResult<T>>`, so a stub returning `{ verdict }` was testing a
 * shape nothing implements — and the ledger's own structural interface said
 * the same wrong thing, so the compiler agreed with both of them.
 *
 * `reply` is written as the payload for readability and wrapped here, so a
 * test says what Core answered and the envelope stays the stub's business.
 */
class StubCore extends Service {
  constructor(ctx, config) {
    super(ctx, 'watchCore')
    this.asked = []
    this.payload = config?.reply ?? { verdict: 'VERIFIED', reason: 'all checks passed' }
    this.envelope = config?.envelope ?? null
    this.fail = config?.fail ?? false
  }

  async request(method, params) {
    this.asked.push({ method, params })
    if (this.fail) throw new Error('bridge unavailable')
    return this.envelope ?? { ok: true, value: this.payload }
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

async function mount({ core = {}, withCore = true } = {}) {
  const workspace = freshWorkspace()
  const ctx = new Context()
  await ctx.plugin(StubProvenance)
  if (withCore) await ctx.plugin(StubCore, core)
  await ctx.plugin(observationPlugin)
  await ctx.plugin(StubTools, { workspace })
  ctx.get(OBSERVATION_SERVICE).setWorkspace(workspace, 'session-1')
  return {
    ctx,
    workspace,
    observation: ctx.get(OBSERVATION_SERVICE),
    core: withCore ? ctx.get('watchCore') : null,
    tools: ctx.get('tools'),
  }
}

/** Let the un-awaited attestation settle. */
const settle = () => new Promise((done) => { setTimeout(done, 20) })

describe('the Host asks; Core answers', () => {
  test('a write is asked about, and the verdict is the one Core returned', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'out.json'), content: '{"ok":true}' },
    })
    await settle()

    assert.equal(host.core.asked.length, 1, 'the Host did not ask Core anything')
    assert.equal(host.core.asked[0].method, 'watch.verification.run')

    const [record] = host.observation.all()
    const made = host.observation.attestationFor(record.idempotencyKey)
    assert.equal(made.state, 'answered')
    assert.equal(made.coreVerdict, 'VERIFIED', 'the Host did not record Core’s verdict')
    assert.equal(made.coreReason, 'all checks passed')
  })

  test('the record itself stays UNVERIFIED whatever Core says', async () => {
    // The separation the repository enforces: an execution state, an evidence
    // record and a verdict are three things. A verdict about a narrow
    // operation-level claim does not retroactively make the *action* verified.
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'out.json'), content: 'x' },
    })
    await settle()
    const [record] = host.observation.all()
    assert.equal(record.state, 'completed')
    assert.equal(record.verification, 'UNVERIFIED')
  })

  test('the checks sent are the narrow ones the act supports', async () => {
    const host = await mount()
    const content = '{"record_count":4}'
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'result.json'), content },
    })
    await settle()

    const { checks, workingDir } = host.core.asked[0].params
    assert.deepEqual(checks.map(check => check.type), ['file_exists', 'file_digest'])
    assert.equal(checks[0].params.path, 'result.json', 'an absolute path was sent to Core')
    assert.equal(checks[1].params.sha256, sha256(content))
    assert.equal(workingDir, host.workspace)
    for (const check of checks) assert.equal(check.required, true)
  })

  test('a shell command is never re-run as its own verification', async () => {
    // Core's `command_exit` check runs a command. Submitting the agent's own
    // command back to it would repeat whatever it did — a second push, a second
    // delete — under the name "verification".
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'bash', arguments: { command: 'rm -rf build && npm publish' },
    })
    await settle()

    assert.equal(host.core.asked.length, 0, 'the Host asked Core to re-run a shell command')
    const [record] = host.observation.all()
    const made = host.observation.attestationFor(record.idempotencyKey)
    assert.equal(made.state, 'no_contract')
    assert.equal(made.basis, 'would_re_execute')
    assert.equal(made.coreVerdict, null)
  })

  test('an exit status is recorded as an exit status, not as success', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'bash', arguments: { command: 'npm test' } })
    await settle()
    const made = host.observation.allAttestations()[0]
    assert.match(made.expectation, /exit status of a process, not evidence that the task/)
    assert.equal(made.coreVerdict, null)
  })

  test('a read earns a receipt and no contract', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'read', arguments: { path: join(host.workspace, 'a.txt') } })
    await settle()
    assert.equal(host.core.asked.length, 0)
    const made = host.observation.allAttestations()[0]
    assert.equal(made.state, 'no_contract')
    assert.equal(made.basis, 'no_claim_available')
    // The ledger record still exists. Nothing was hidden; nothing was claimed.
    assert.equal(host.observation.all().length, 1)
  })

  test('a write the Host never saw the content of gets existence only', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'edit', arguments: { path: join(host.workspace, 'a.txt') } })
    await settle()
    const { checks } = host.core.asked[0].params
    assert.deepEqual(checks.map(check => check.type), ['file_exists'],
      'the Host digested content it never saw')
  })

  test('a failed action is not something to verify', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
      result: { isError: true, error: { code: 'EACCES' }, content: [] },
    })
    await settle()
    assert.equal(host.core.asked.length, 0)
    assert.equal(host.observation.allAttestations()[0].state, 'no_contract')
  })
})

describe('no verdict is better than a borrowed one', () => {
  test('with no Bridge, an asked-for verification is requested_but_not_run', async () => {
    const host = await mount({ withCore: false })
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
    })
    await settle()
    const made = host.observation.allAttestations()[0]
    assert.equal(made.state, 'requested_but_not_run',
      'a missing Bridge was allowed to read as anything other than "not run"')
    assert.equal(made.coreVerdict, null)
  })

  test('a Bridge that throws leaves no verdict and does not break the turn', async () => {
    const host = await mount({ core: { fail: true } })
    const result = await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
    })
    await settle()
    assert.equal(result.isError, false, 'a failed attestation broke the action it was about')
    const made = host.observation.allAttestations()[0]
    assert.equal(made.state, 'unavailable')
    assert.equal(made.coreVerdict, null)
  })

  test('a reply carrying no verdict is not treated as one', async () => {
    const host = await mount({ core: { reply: { reason: 'core was busy' } } })
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
    })
    await settle()
    assert.equal(host.observation.allAttestations()[0].state, 'requested_but_not_run')
  })

  test('a FAILED verdict is recorded as faithfully as a passing one', async () => {
    const host = await mount({ core: { reply: { verdict: 'FAILED', reason: 'digest differs' } } })
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
    })
    await settle()
    const made = host.observation.allAttestations()[0]
    assert.equal(made.state, 'answered')
    assert.equal(made.coreVerdict, 'FAILED')
  })

  test('an attestation is announced, so a surface need not poll', async () => {
    const host = await mount()
    const seen = []
    host.ctx.on('watch/attestation-recorded', (made) => { seen.push(made.state) })
    await host.tools.execute({
      callId: 'c1', name: 'write',
      arguments: { path: join(host.workspace, 'a.txt'), content: 'x' },
    })
    await settle()
    assert.deepEqual(seen, ['answered'])
  })
})

describe('the question is frozen before it is asked', () => {
  test('the digest covers the checks, so the question cannot change afterwards', () => {
    const record = recordOf()
    const first = operationContract(record, { content: 'a' })
    const second = operationContract(record, { content: 'a' })
    const different = operationContract(record, { content: 'b' })
    assert.equal(freezeChecks(first.checks), freezeChecks(second.checks))
    assert.notEqual(freezeChecks(first.checks), freezeChecks(different.checks))
    assert.match(freezeChecks(first.checks), /^sha256:[0-9a-f]{64}$/)
  })

  test('one action yields one contract id, however often it is built', () => {
    const record = recordOf()
    assert.equal(
      operationContract(record, {}).contractId, operationContract(record, {}).contractId)
    assert.notEqual(
      operationContract(record, {}).contractId,
      operationContract(recordOf({ idempotencyKey: 'other' }), {}).contractId)
  })

  test('the request carries the workspace as the bound Core evaluates within', () => {
    const contract = operationContract(recordOf(), { content: 'x' })
    const request = verificationRequest(contract, 'ver_1', '/w')
    assert.equal(request.workingDir, '/w')
    assert.equal(request.verificationId, 'ver_1')
    assert.equal(request.checks.length, 2)
  })

  test('content is read from the shapes write tools actually use', () => {
    assert.equal(writtenContent({ content: 'a' }), 'a')
    assert.equal(writtenContent({ text: 'b' }), 'b')
    assert.equal(writtenContent({ path: 'p' }), null)
    assert.equal(writtenContent(null), null)
  })
})

describe('the authority rule is enforced by the repository, not by intent', () => {
  test('nothing in this package assigns a verdict literal', () => {
    // The gate that caught the earlier draft. Asserted here too, so the reason
    // travels with the code rather than living only in a script.
    for (const file of ['observation.ts', 'attestation.ts']) {
      const source = readFileSync(
        join(ROOT, 'packages', 'watch', 'technology', 'src', file), 'utf8')
      assert.doesNotMatch(source, /\bverdict\s*[:=]\s*['"`](VERIFIED|FAILED|INCONCLUSIVE)['"`]/,
        `${file} mints a verdict`)
    }
  })

  test('the Host reads Core’s verdict rather than deriving one', () => {
    const source = readFileSync(
      join(ROOT, 'packages', 'watch', 'technology', 'src', 'observation.ts'), 'utf8')
    assert.match(source, /if \(!result\.ok\)/,
      'an unsuccessful Bridge result is no longer handled before the payload')
    assert.match(source, /typeof reply\.verdict === 'string' \? reply\.verdict : null/,
      'the verdict is no longer read out of the envelope’s value')
  })
})
