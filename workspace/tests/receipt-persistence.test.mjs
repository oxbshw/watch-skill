/**
 * Receipts, and the verdicts on them, survive the Host stopping.
 *
 * They did not. A clean room holding thirteen receipts had its Host restarted;
 * afterwards the Library returned one — the receipt created after the restart.
 * `Refresh` did not bring the others back and reported `sourceCount: 0`,
 * because it re-reads evidence roots on disk and an in-memory receipt is not
 * on disk to be read.
 *
 * That made one word mean two things. Indexed sources are Watch Core's and
 * persist; receipts were a live view that looked identical in the same list
 * and vanished with the process. Somebody reading "every receipt this
 * workspace recorded" and coming back tomorrow found nothing, with no error to
 * explain it.
 *
 * These tests drive the shipped plugin, twice, against one directory — the
 * second mount is the restart. What is asserted is not "a file was written"
 * but that the Library answers the same question the same way afterwards, and
 * that the awkward cases behave:
 *
 *  - a verdict that arrived before the restart is still on its receipt;
 *  - `Refresh` does not lose them, which is where the old behaviour showed;
 *  - replaying the journal does not duplicate a record;
 *  - a torn last line costs one record, not the journal;
 *  - a journal of rubbish is skipped rather than filed as rows.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const toolsPlugin = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'tools', 'lib', 'index.js')).href)

const BASE = mkdtempSync(join(tmpdir(), 'watch-receipts-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })

let rooms = 0
function room() {
  rooms += 1
  const dir = join(BASE, `r${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const receiptEvent = (over = {}) => ({
  version: 1,
  sessionId: 'session-1',
  turnId: 'agent-1#1',
  callId: 'c1',
  attempt: 1,
  idempotencyKey: 'session-1/agent-1#1/c1#1',
  toolName: 'write',
  state: 'completed',
  startedAt: '2026-09-04T00:00:00.000Z',
  sideEffect: 'write',
  scope: 'inside',
  paths: ['owner-test/totals.json'],
  inputSummary: '{}',
  outputSummary: 'ok',
  ...over,
})

const attestationEvent = (over = {}) => ({
  idempotencyKey: 'session-1/agent-1#1/c1#1',
  coreVerdict: 'VERIFIED',
  verificationId: 'vr_abc123',
  state: 'answered',
  ...over,
})

/** Mount the shipped tools plugin against `receipts`, as a Host boot would. */
async function boot(receipts) {
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
  await ctx.plugin(class Llm extends Service { constructor(c) { super(c, 'llm') } })
  await ctx.plugin(class Prov extends Service {
    constructor(c) { super(c, 'watchProvenance') }
    activeTurn() { return 'agent-1#1' }
  })
  await ctx.plugin(toolsPlugin, {
    queryTimeoutMs: 1000, verifyTimeoutMs: 1000, readTimeoutMs: 1000,
    liveStartTimeoutMs: 1000, actTimeoutMs: 1000, observeTimeoutMs: 1000,
    libraryRoots: [], workspaceScope: 'default', receiptsDirectory: receipts,
  })
  await new Promise((done) => { setTimeout(done, 30) })
  return ctx
}

/** Read back the way Compare and the Library mode read. */
async function records(ctx) {
  const response = await ctx.get('watchQuery').librarySearch({
    protocol: 1, requestId: `t${String(Date.now())}`, query: '',
    modalities: [], limit: 200, cursor: null, deadlineMs: 5000,
  }, new AbortController().signal)
  return response.records ?? []
}

const settle = () => new Promise((done) => { setTimeout(done, 40) })
const journalPath = receipts => join(receipts, 'receipts.jsonl')

describe('a restart does not lose what the Host recorded', () => {
  test('the same receipts, with the same verdicts, after a restart', async () => {
    const receipts = room()

    const first = await boot(receipts)
    first.emit('watch/execution-recorded', receiptEvent())
    first.emit('watch/execution-recorded', receiptEvent({
      idempotencyKey: 'session-1/agent-1#1/c2#1', callId: 'c2', toolName: 'read',
    }))
    first.emit('watch/attestation-recorded', attestationEvent())
    await settle()
    const before = await records(first)
    assert.equal(before.length, 2, 'the first run did not file both receipts')

    // The restart: a new process, the same directory, nothing in memory.
    const second = await boot(receipts)
    const after_ = await records(second)

    assert.equal(after_.length, 2, 'a restart lost receipts')
    const write = after_.find(entry => entry.recordId === 'session-1/agent-1#1/c1#1')
    assert.ok(write !== undefined)
    assert.equal(write.verdict, 'VERIFIED', 'the verdict did not survive the restart')
    assert.ok((write.tags ?? []).includes('scope:inside'), 'the containment decision was lost')
    assert.ok((write.tags ?? []).includes('state:completed'))
    assert.deepEqual(write.evidenceIds, ['vr_abc123'],
      'the verification record the verdict came from was lost')
    assert.equal(write.runId, 'session-1', 'session identity was lost')
  })

  test('Refresh keeps them, which is where the old behaviour showed', async () => {
    const receipts = room()
    const first = await boot(receipts)
    first.emit('watch/execution-recorded', receiptEvent())
    await settle()

    const second = await boot(receipts)
    const refreshed = await second.get('watchQuery').libraryRefresh({
      protocol: 1, requestId: 'rf', deadlineMs: 10_000,
    }, new AbortController().signal)
    assert.equal(refreshed.outcome, 'refreshed', JSON.stringify(refreshed))

    const after_ = await records(second)
    assert.equal(after_.length, 1, 'Refresh dropped a restored receipt')
    assert.equal(after_[0].recordId, 'session-1/agent-1#1/c1#1')
  })

  test('replay does not duplicate: three boots, one record', async () => {
    const receipts = room()
    const first = await boot(receipts)
    first.emit('watch/execution-recorded', receiptEvent())
    first.emit('watch/attestation-recorded', attestationEvent())
    await settle()

    const lines = () => readFileSync(journalPath(receipts), 'utf8')
      .split('\n').filter(line => line.trim() !== '').length
    const afterFirst = lines()

    await boot(receipts)
    const third = await boot(receipts)
    assert.equal(lines(), afterFirst,
      'a boot re-journalled what it had just restored, so the file grows every time')

    const found = await records(third)
    assert.equal(found.length, 1, 'replay produced duplicate records')
    assert.equal(found[0].verdict, 'VERIFIED')
  })

  test('a torn last line costs one record, not the journal', async () => {
    // The failure that actually happens: the process dies mid-append.
    const receipts = room()
    const first = await boot(receipts)
    for (const call of ['c1', 'c2', 'c3']) {
      first.emit('watch/execution-recorded', receiptEvent({
        idempotencyKey: `session-1/agent-1#1/${call}#1`, callId: call,
      }))
    }
    await settle()
    assert.equal((await records(first)).length, 3)

    // Half a line, as an interrupted write leaves.
    appendFileSync(journalPath(receipts), '{"recordId":"session-1/agent-1#1/c4#1","rev', 'utf8')

    const second = await boot(receipts)
    const after_ = await records(second)
    assert.equal(after_.length, 3,
      'a torn append cost more than the record it was writing')
    assert.deepEqual(after_.map(entry => entry.recordId).sort(),
      ['session-1/agent-1#1/c1#1', 'session-1/agent-1#1/c2#1', 'session-1/agent-1#1/c3#1'])
  })

  test('a corrupted journal files nothing rather than rubbish', async () => {
    const receipts = room()
    mkdirSync(receipts, { recursive: true })
    writeFileSync(journalPath(receipts),
      'not json at all\n{"but":"this parses and is not a record"}\n[]\n', 'utf8')

    const ctx = await boot(receipts)
    assert.deepEqual(await records(ctx), [],
      'a line that parses as JSON but is not a record became a Library row')
  })

  test('no journal configured is the old behaviour, and does not crash', async () => {
    // A deployment that has not asked for a durable record still works; its
    // receipts are live-only, which is what every deployment did before this.
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
    await ctx.plugin(class Llm extends Service { constructor(c) { super(c, 'llm') } })
    await ctx.plugin(class Prov extends Service {
      constructor(c) { super(c, 'watchProvenance') }
      activeTurn() { return 'agent-1#1' }
    })
    await ctx.plugin(toolsPlugin, {
      queryTimeoutMs: 1000, verifyTimeoutMs: 1000, readTimeoutMs: 1000,
      liveStartTimeoutMs: 1000, actTimeoutMs: 1000, observeTimeoutMs: 1000,
      libraryRoots: [], workspaceScope: 'default',
    })
    await new Promise((done) => { setTimeout(done, 30) })
    ctx.emit('watch/execution-recorded', receiptEvent())
    await settle()
    assert.equal((await records(ctx)).length, 1)
  })

  test('the journal holds no raw arguments and no credential-shaped text', async () => {
    // What is written is what was already filed, and the ledger's summaries are
    // bounded and redacted before they get here. This is the assertion that
    // keeps it that way if somebody widens the record later.
    const receipts = room()
    const ctx = await boot(receipts)
    ctx.emit('watch/execution-recorded', receiptEvent({
      inputSummary: '{"file_path":"owner-test/totals.json"}',
      outputSummary: 'wrote 31 bytes',
    }))
    await settle()

    const text = readFileSync(journalPath(receipts), 'utf8')
    assert.ok(!/sk-[A-Za-z0-9]{8}/.test(text), 'something key-shaped reached the journal')
    assert.ok(!/"arguments"/.test(text), 'raw tool arguments reached the journal')
    assert.ok(text.includes('owner-test/totals.json'),
      'the workspace-relative path is the record and should be there')
  })
})
describe('an interrupted write does not take the next one with it', () => {
  // The reproduced defect: the reader skipped an incomplete final line and
  // left it on disk. The next append concatenated onto the fragment, returned
  // success, and produced one unparseable line — so the new record vanished at
  // the next load, and nothing had failed.

  test('valid, torn, restart, append, restart — everything survives once', async () => {
    const receipts = room()

    // Three good records.
    const first = await boot(receipts)
    for (const call of ['c1', 'c2', 'c3']) {
      first.emit('watch/execution-recorded', receiptEvent({
        idempotencyKey: `session-1/agent-1#1/${call}#1`, callId: call,
      }))
    }
    await settle()

    // A write interrupted half way: no trailing newline.
    appendFileSync(journalPath(receipts),
      '{"recordId":"session-1/agent-1#1/c4#1","revisionId":"x","title":"wr', 'utf8')

    // Restart. The tail must be repaired before anything else is written.
    const second = await boot(receipts)
    assert.equal((await records(second)).length, 3, 'the torn tail cost a good record')

    // A new append after the recovery.
    second.emit('watch/execution-recorded', receiptEvent({
      idempotencyKey: 'session-1/agent-1#1/c5#1', callId: 'c5',
    }))
    await settle()
    assert.equal((await records(second)).length, 4)

    // Restart again: the new record must still be there.
    const third = await boot(receipts)
    const ids = (await records(third)).map(entry => entry.recordId).sort()
    assert.deepEqual(ids, [
      'session-1/agent-1#1/c1#1',
      'session-1/agent-1#1/c2#1',
      'session-1/agent-1#1/c3#1',
      'session-1/agent-1#1/c5#1',
    ], 'the append after a torn tail did not survive the next restart')

    // And exactly once each.
    assert.equal(new Set(ids).size, ids.length, 'a record was restored twice')
  })

  test('the repair removes only the tail, never a good record before it', async () => {
    const receipts = room()
    const first = await boot(receipts)
    first.emit('watch/execution-recorded', receiptEvent())
    await settle()
    const before = readFileSync(journalPath(receipts), 'utf8')

    appendFileSync(journalPath(receipts), '{"recordId":"torn', 'utf8')
    await boot(receipts)

    assert.equal(readFileSync(journalPath(receipts), 'utf8'), before,
      'the repair rewrote more than the incomplete tail')
  })

  test('a damaged line in the middle is not truncated away', async () => {
    // Truncating there would delete every valid record after it, which is a
    // far larger loss than the one being recovered from.
    const receipts = room()
    const first = await boot(receipts)
    first.emit('watch/execution-recorded', receiptEvent())
    await settle()
    appendFileSync(journalPath(receipts), 'not json at all\n', 'utf8')
    first.emit('watch/execution-recorded', receiptEvent({
      idempotencyKey: 'session-1/agent-1#1/c9#1', callId: 'c9',
    }))
    await settle()

    const second = await boot(receipts)
    const ids = (await records(second)).map(entry => entry.recordId).sort()
    assert.deepEqual(ids, ['session-1/agent-1#1/c1#1', 'session-1/agent-1#1/c9#1'],
      'a mid-file damaged line cost the records after it')
  })
})

describe('a store that is not working says so', () => {
  test('an unreadable store is not reported as an empty one', async () => {
    const { ReceiptJournal } = await import(
      pathToFileURL(join(ROOT, 'packages', 'watch', 'tools', 'lib', 'receipt-journal.js')).href)
    const receipts = room()
    mkdirSync(receipts, { recursive: true })
    // A directory where the journal file should be: `existsSync` is true and
    // every read fails, which is the shape of a store that exists and cannot
    // be opened.
    mkdirSync(journalPath(receipts), { recursive: true })

    const journal = new ReceiptJournal(receipts)
    const loaded = journal.load()
    assert.equal(loaded.status, 'unreadable',
      'an unreadable store answered the same way a first run does')
    assert.notEqual(loaded.reason, null, 'the failure did not say why')
    assert.deepEqual(loaded.records, [])
    assert.notEqual(journal.degradedReason(), null)
  })

  test('a first run is absent, not unreadable', async () => {
    const { ReceiptJournal } = await import(
      pathToFileURL(join(ROOT, 'packages', 'watch', 'tools', 'lib', 'receipt-journal.js')).href)
    const loaded = new ReceiptJournal(room()).load()
    assert.equal(loaded.status, 'absent')
    assert.equal(loaded.reason, null)
    assert.equal(loaded.records.length, 0)
  })

  test('a failed append is reported, and the record is still indexed', async () => {
    const { ReceiptJournal } = await import(
      pathToFileURL(join(ROOT, 'packages', 'watch', 'tools', 'lib', 'receipt-journal.js')).href)
    const receipts = room()
    mkdirSync(journalPath(receipts), { recursive: true })
    const journal = new ReceiptJournal(receipts)

    assert.equal(journal.degradedReason(), null, 'nothing has failed yet')
    const wrote = journal.append({
      recordId: 'r1', revisionId: 'r1', title: 't', text: 't',
      kind: 'document', source: null, runId: null, observedAt: null,
      verdict: null, tags: [], evidenceIds: [],
    })
    assert.equal(wrote, false, 'the append should not have succeeded')
    assert.notEqual(journal.degradedReason(), null,
      'a failed append left nothing for a caller to report')
  })

  test('the journal lives under the profile directory it was given', async () => {
    // Workspace and profile isolation: two rooms never share a store.
    const { ReceiptJournal } = await import(
      pathToFileURL(join(ROOT, 'packages', 'watch', 'tools', 'lib', 'receipt-journal.js')).href)
    const a = room()
    const b = room()
    assert.notEqual(new ReceiptJournal(a).path, new ReceiptJournal(b).path)
    assert.ok(new ReceiptJournal(a).path.startsWith(a))
  })

  test('on POSIX the store is owner-only; on Windows it inherits the profile', async () => {
    // Stated as two different claims because they are. `chmod` is meaningful
    // on POSIX and is a no-op for access control on Windows, where the file
    // inherits the profile directory's ACL. Asserting a mode on Windows would
    // be asserting something that does not decide access there.
    const receipts = room()
    const ctx = await boot(receipts)
    ctx.emit('watch/execution-recorded', receiptEvent())
    await settle()

    const mode = statSync(journalPath(receipts)).mode & 0o777
    if (process.platform === 'win32') {
      assert.ok(existsSync(journalPath(receipts)),
        'the journal was not created under the profile directory')
    } else {
      assert.equal(mode, 0o600, `expected owner-only, got ${mode.toString(8)}`)
      assert.equal(statSync(receipts).mode & 0o777, 0o700)
    }
  })
})
