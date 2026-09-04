/**
 * Whether Watch sees a tool call nobody told it about.
 *
 * The owner evaluation these tests come from ran 76 tool calls — 30 shell, 30
 * reads, 5 writes, 4 greps, 3 subagents — and produced zero Watch records. The
 * task was ordinary and the agent did it; it simply never called a `watch_*`
 * tool, because nothing in the task suggested it should. Watch's capabilities
 * were opt-in, so they were opted out of by default.
 *
 * So the first test here does the same thing the evaluation did: it dispatches
 * ordinary tools through the real registry lifecycle and never mentions Watch.
 * Every other test in this file is downstream of that one being true.
 *
 * The second thing these hold is the separation the evaluation lost. A tool
 * that returns is a tool that returned. The agent wrote `verification.json`,
 * reread it with a second generic tool and reported PASS; nothing about that
 * sequence is evidence, and none of it may reach a Watch verdict.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const observationPlugin = await import(pathToFileURL(join(TECH, 'observation.js')).href)
const {
  OBSERVATION_SERVICE, WatchObservation, classifySideEffect, pathsIn, readScope,
} = observationPlugin
const provenancePlugin = await import(pathToFileURL(join(TECH, 'provenance.js')).href)
const { boundSummary, executionKey, isSameAction, looksLikeSecret, redactSecrets } =
  await import(pathToFileURL(
    join(ROOT, 'packages', 'watch', 'contracts', 'lib', 'index.js')).href)

const WORKSPACE = process.platform === 'win32' ? 'D:/work/project' : '/work/project'
const OUTSIDE = process.platform === 'win32' ? 'D:/elsewhere/notes.md' : '/elsewhere/notes.md'

/**
 * A tool registry with the real lifecycle shape.
 *
 * Small on purpose, and faithful where it matters: `tools/execute` is a
 * waterfall the dispatch actually flows through, and `tools/result` is an emit
 * carrying the frozen outcome. A stub that fired them as plain events would
 * pass while the product broke, which is the exact failure mode this file
 * exists to catch.
 */
class StubTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.dispatched = []
  }

  /** Run one call the way the registry does, through both waterfalls. */
  async execute(call) {
    const exec = {
      callId: call.callId,
      rootCallId: call.rootCallId ?? null,
      name: call.name,
      arguments: call.arguments ?? {},
      agent: call.agent ?? { id: 'agent-1', session: { id: 'session-1' } },
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
      return refusal
    }
    const result = await this.ctx.waterfall('tools/execute', exec, async () => {
      this.dispatched.push(call.name)
      return call.result ?? {
        isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }],
      }
    })
    this.ctx.emit('tools/result', exec, result)
    return result
  }
}

/** A provenance service with one turn open, so records have a turn to belong to. */
class StubProvenance extends Service {
  constructor(ctx) {
    super(ctx, 'watchProvenance')
    this.turn = 'agent-1#1'
  }

  activeTurn() { return this.turn }
}

/** The composed shape: the ledger mounted once, the registry dispatching through it. */
async function mount({ workspace = WORKSPACE, provenance = true } = {}) {
  const ctx = new Context()
  if (provenance) await ctx.plugin(StubProvenance)
  await ctx.plugin(observationPlugin)
  await ctx.plugin(StubTools)
  const observation = ctx.get(OBSERVATION_SERVICE)
  observation.setWorkspace(workspace)
  return { ctx, observation, tools: ctx.get('tools') }
}

describe('a task that never mentions Watch still leaves Watch evidence', () => {
  test('ordinary read, write and shell calls all become records', async () => {
    // Deliberately the shape of the evaluation that failed: generic tools, no
    // Watch tool anywhere, nothing in the arguments naming Watch.
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read_file', arguments: { path: `${WORKSPACE}/src/index.ts` } })
    await host.tools.execute({ callId: 'c2', name: 'write_file', arguments: { path: `${WORKSPACE}/out.json` } })
    await host.tools.execute({ callId: 'c3', name: 'bash', arguments: { command: 'npm test' } })

    const records = host.observation.all()
    assert.equal(records.length, 3, 'a generic task left no Watch record')
    assert.deepEqual(records.map(r => r.toolName), ['read_file', 'write_file', 'bash'])
    assert.deepEqual(records.map(r => r.sideEffect), ['read', 'write', 'execute'])
    for (const record of records) {
      assert.equal(record.sessionId, 'session-1')
      assert.equal(record.turnId, 'agent-1#1')
      assert.equal(record.state, 'completed')
    }
  })

  test('every call has exactly one correlated record', async () => {
    const host = await mount()
    for (let n = 0; n < 12; n += 1) {
      await host.tools.execute({ callId: `c${String(n)}`, name: 'read_file', arguments: { path: `${WORKSPACE}/a${String(n)}.txt` } })
    }
    const records = host.observation.all()
    assert.equal(records.length, 12)
    assert.equal(new Set(records.map(r => r.idempotencyKey)).size, 12,
      'two calls shared an idempotency key')
    assert.equal(host.observation.openCount(), 0, 'a call was left open')
  })

  test('a retry is a second attempt at one action, not a second action', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'write_file', arguments: { path: `${WORKSPACE}/out.json` } })
    await host.tools.execute({ callId: 'c1', name: 'write_file', arguments: { path: `${WORKSPACE}/out.json` } })
    const [first, second] = host.observation.all()
    assert.equal(first.attempt, 1)
    assert.equal(second.attempt, 2)
    assert.ok(isSameAction(first, second), 'the retry was recorded as a different action')
    assert.notEqual(first.idempotencyKey, second.idempotencyKey)
  })

  test('a failing tool is recorded as failed, with its own code', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'bash', arguments: { command: 'exit 1' },
      result: { isError: true, error: { code: 'NONZERO_EXIT' }, content: [{ type: 'text', text: 'exit status 1' }] },
    })
    const [record] = host.observation.all()
    assert.equal(record.state, 'failed')
    assert.equal(record.exitStatus, 'NONZERO_EXIT')
  })

  test('the ledger is announced as it is written, so an index can keep up', async () => {
    const host = await mount()
    const announced = []
    host.ctx.on('watch/execution-recorded', (record) => { announced.push(record.toolName) })
    await host.tools.execute({ callId: 'c1', name: 'read_file', arguments: { path: `${WORKSPACE}/a.txt` } })
    assert.deepEqual(announced, ['read_file'],
      'nothing announced the record, so the Library can only learn of it by polling')
  })
})

describe('completed is not verified', () => {
  test('a successful call is recorded UNVERIFIED', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'write_file', arguments: { path: `${WORKSPACE}/out.json` } })
    const [record] = host.observation.all()
    assert.equal(record.state, 'completed')
    assert.equal(record.verification, 'UNVERIFIED',
      'a tool returning was taken as proof that what it did was correct')
  })

  test('a model-authored verification file changes no verdict', async () => {
    // The evaluation's exact sequence: the agent writes `verification.json`
    // saying everything passed, rereads it with a second generic tool, and
    // reports PASS. Watch sees two ordinary tool calls and nothing else.
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'write_file',
      arguments: { path: `${WORKSPACE}/verification.json` },
      result: {
        isError: false, value: 'written',
        content: [{ type: 'text', text: '{"status":"pass","checks":[{"ok":true}]}' }],
      },
    })
    await host.tools.execute({
      callId: 'c2', name: 'read_file',
      arguments: { path: `${WORKSPACE}/verification.json` },
      result: {
        isError: false, value: 'read',
        content: [{ type: 'text', text: '{"status":"pass","checks":[{"ok":true}]}' }],
      },
    })
    for (const record of host.observation.all()) {
      assert.equal(record.verification, 'UNVERIFIED',
        'a file the model wrote about itself moved the Watch verdict')
    }
  })

  test('the record carries a digest of the output it summarised', async () => {
    const host = await mount()
    const text = 'a'.repeat(4000)
    await host.tools.execute({
      callId: 'c1', name: 'bash', arguments: { command: 'cat big.txt' },
      result: { isError: false, value: text, content: [{ type: 'text', text }] },
    })
    const [record] = host.observation.all()
    assert.match(record.outputDigest, /^sha256:[0-9a-f]{64}$/)
    assert.ok(record.outputSummary.length < text.length, 'the summary was not bounded')
    assert.match(record.outputSummary, /chars\)$/, 'a truncated summary did not say so')
  })
})

describe('containment is recorded, whatever it decided', () => {
  test('a path inside the workspace is recorded workspace-relative', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read_file', arguments: { path: `${WORKSPACE}/src/index.ts` } })
    const [record] = host.observation.all()
    assert.equal(record.scope, 'inside')
    assert.deepEqual(record.paths, ['src/index.ts'])
    assert.equal(record.outsidePathCount, 0)
  })

  test('a path outside it is counted and never written down', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'read_file', arguments: { path: OUTSIDE } })
    const [record] = host.observation.all()
    assert.equal(record.scope, 'outside_workspace')
    assert.equal(record.outsidePathCount, 1)
    assert.deepEqual(record.paths, [], 'an outside path was recorded as a path')
    assert.doesNotMatch(JSON.stringify(record), /elsewhere/,
      'the outside path survived into the record')
  })

  test('no selected workspace is its own answer, not "inside"', async () => {
    const host = await mount({ workspace: null })
    await host.tools.execute({ callId: 'c1', name: 'read_file', arguments: { path: OUTSIDE } })
    const [record] = host.observation.all()
    assert.equal(record.scope, 'no_workspace')
  })

  test('a call naming no path is not_applicable rather than inside', async () => {
    const host = await mount()
    await host.tools.execute({ callId: 'c1', name: 'todo_write', arguments: { todos: [] } })
    const [record] = host.observation.all()
    assert.equal(record.scope, 'not_applicable')
    assert.equal(record.sideEffect, 'none')
  })

  test('a tool this distribution has never seen is unknown, not harmless', () => {
    assert.equal(classifySideEffect('something_new'), 'unknown')
    assert.equal(classifySideEffect('read_file'), 'read')
  })

  test('scope reading finds paths in the argument shapes tools actually use', () => {
    assert.deepEqual(pathsIn({ path: 'a' }), ['a'])
    assert.deepEqual(pathsIn({ files: ['a', 'b'] }), ['a', 'b'])
    assert.deepEqual(pathsIn({ source: 'a', destination: 'b' }), ['a', 'b'])
    assert.deepEqual(pathsIn({ command: 'rm -rf /' }), [],
      'a command string was mistaken for a path')
    assert.deepEqual(readScope([], WORKSPACE).scope, 'not_applicable')
  })
})

describe('nothing secret reaches a record', () => {
  test('a credential in a command line is redacted from the summary', async () => {
    const host = await mount()
    await host.tools.execute({
      callId: 'c1', name: 'bash',
      arguments: { command: 'curl -H "Authorization: Bearer sk-live-abcdef1234567890" https://x' },
    })
    const [record] = host.observation.all()
    assert.doesNotMatch(record.inputSummary, /sk-live-abcdef1234567890/)
    assert.match(record.inputSummary, /<redacted>/, 'the fact of a credential was lost too')
    assert.equal(looksLikeSecret(record.inputSummary), false)
  })

  test('the redactor catches the shapes a key actually arrives in', () => {
    for (const text of [
      'OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9',
      '--api-key sk-ant-api03-abcdefghij',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    ]) {
      assert.equal(looksLikeSecret(text), true, `not detected: ${text}`)
      assert.equal(looksLikeSecret(redactSecrets(text)), false, `not redacted: ${text}`)
    }
  })

  test('ordinary text is left alone', () => {
    const plain = 'read 42 files from src/ and wrote a summary'
    assert.equal(redactSecrets(plain), plain)
    assert.equal(looksLikeSecret(plain), false)
  })
})

describe('the identity and summary helpers', () => {
  test('the key is one spelling of four parts', () => {
    assert.equal(
      executionKey({ sessionId: 's', turnId: 't', callId: 'c', attempt: 2 }), 's/t/c#2')
  })

  test('a bounded summary collapses whitespace and marks a cut', () => {
    assert.equal(boundSummary('  a\n\nb  '), 'a b')
    const long = boundSummary('x'.repeat(600))
    assert.ok(long.length < 600)
    assert.match(long, /\(600 chars\)$/)
  })
})

describe('the lifecycle this relies on still has the shape it had', () => {
  test('the pinned tools package still declares the dispatch events', (t) => {
    const source = pinnedTools()
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    for (const event of ['tools/pre-execute', 'tools/execute', 'tools/result']) {
      assert.ok(source.includes(`'${event}'`), `upstream no longer declares ${event}`)
    }
  })

  test('every tools event is listened to in the mode upstream declares', (t) => {
    // The bug this exists for was found on `agent/pre-step`: a waterfall
    // listener written as an observer answers the pipeline with `undefined`
    // instead of watching it. Here that would break every tool call in the
    // product, silently.
    const source = pinnedTools()
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    const lines = source.split('\n')
    const modeOf = (event) => {
      const at = lines.findIndex(line => line.includes(`'${event}'(this`))
      if (at === -1) return null
      for (let above = at - 1; above >= 0 && above > at - 40; above -= 1) {
        const found = /@mode (\w+)/.exec(lines[above] ?? '')
        if (found !== null) return found[1]
        if ((lines[above] ?? '').includes("'(this")) return null
      }
      return null
    }
    const ours = readFileSync(
      join(ROOT, 'packages', 'watch', 'technology', 'src', 'observation.ts'), 'utf8')
    const listened = [...ours.matchAll(/(observe|link)[\s\S]{0,200}?\.on\('(tools\/[a-z-]+)'/g)]
    assert.ok(listened.length >= 2, 'the tool listeners moved; this check no longer reads them')
    for (const [, shape, event] of listened) {
      const mode = modeOf(event)
      assert.notEqual(mode, null, `upstream no longer declares a mode for ${event}`)
      assert.equal(shape, mode === 'waterfall' ? 'link' : 'observe',
        `${event} is @mode ${mode} upstream and is registered here as a ${shape}`)
    }
  })

  test('the bundle mounts the ledger as its own row, ahead of what injects it', () => {
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    const observationAt = patch.indexOf('id: watch-observation')
    const toolsAt = patch.indexOf('id: watch-tools')
    assert.ok(observationAt > 0, 'the bundle composes no observation row')
    assert.ok(observationAt < toolsAt, 'the row is composed after what uses it')
    assert.match(patch, /name: '@deepwatch\/dsh-technology\/observation'/)
  })

  test('the guard does not construct its own ledger', () => {
    const source = readFileSync(
      join(ROOT, 'packages', 'watch', 'technology', 'src', 'observation.ts'), 'utf8')
    // One `new WatchObservation(` — the one inside `apply`. A second would be a
    // second ledger, which is the per-scope reflection bug wearing a new hat.
    assert.equal(source.split('new WatchObservation(').length - 1, 1)
  })
})

/** The pinned tools package's source, or null when the baseline is absent. */
function pinnedTools() {
  const candidate = join(
    ROOT, 'upstream', 'deepseek-harness', 'packages', 'core', 'tools', 'src', 'index.ts')
  try {
    return readFileSync(candidate, 'utf8')
  } catch {
    return null
  }
}

/** Kept so an unused import cannot hide a missing dependency. */
void WatchObservation
void provenancePlugin
