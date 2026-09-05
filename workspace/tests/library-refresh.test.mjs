/**
 * Refreshing the Library, as a real operation rather than a control that lies.
 *
 * The host built its index once per process. Records written afterwards were
 * invisible until somebody restarted the application, and the surface's rebuild
 * button could not reach the host's index at all — so it said "Search again",
 * which was honest and useless.
 *
 * What replaced it is a wire operation, and the properties that make it safe to
 * expose are the ones asserted here: one rebuild at a time, callers join rather
 * than duplicate, a repeated request id is answered rather than re-run, the
 * work is abandoned only when the last waiter leaves, and a failed or abandoned
 * rebuild leaves the previous generation searchable. A refresh that could break
 * the Library would be worse than one that does not exist.
 *
 * The generation service is exercised directly with an injected builder, so
 * concurrency and failure are deterministic rather than raced against a
 * filesystem. The wire is exercised through the real Gateway with a real
 * directory, because a contract that only works against a fake is not a
 * contract.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import TypertRegistryPlugin from '@deepseek-ai/dsh-typert-registry'
import GatewayPlugin from '@deepseek-ai/dsh-api-gateway'

import { LibraryIndex } from '../packages/watch/library/lib/index.js'
import { LibraryGenerations } from '../packages/watch/tools/lib/library-generations.js'
import { WatchQueryService } from '../packages/watch/tools/lib/read-plane.js'

const { TYPERT } = await import('../packages/watch/tools/lib/typert.host.js')

const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })
const posix = value => value.split(sep).join('/')

/** A directory of records, and a handle to add to it. */
function corpus(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lref-'))
  const write = (name, text) => {
    writeFileSync(join(dir, name), JSON.stringify({ kind: 'document', text }))
  }
  for (const [name, text] of Object.entries(initial)) write(name, text)
  return { dir: posix(dir), write, dispose: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/** An index built from nothing, for a builder that does not touch a disk. */
const emptyIndex = () => new LibraryIndex()

// ── the generation service ──────────────────────────────────────────────────

describe('one rebuild at a time', () => {
  test('a second caller joins the first rather than starting another', async () => {
    let builds = 0
    let release = () => {}
    const gate = new Promise(resolve => { release = resolve })
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: async () => {
        builds += 1
        await gate
        return { index: emptyIndex(), skipped: [], sourceCount: 1 }
      },
    })

    const first = generations.refresh('req-a', new AbortController().signal)
    await settle()
    const second = generations.refresh('req-b', new AbortController().signal)
    await settle()

    assert.equal(generations.rebuilding(), true, 'the surface can say it is working')
    release()
    const [a, b] = await Promise.all([first, second])

    assert.equal(builds, 1, 'two callers must not read the corpus twice')
    assert.equal(a.kind, 'refreshed')
    assert.equal(b.kind, 'refreshed')
    assert.equal(a.index.generation, b.index.generation,
      'joined callers describe the same generation')
    assert.equal(generations.rebuilding(), false)
  })

  test('a repeated request id is answered, not re-run', async () => {
    let builds = 0
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: () => {
        builds += 1
        return Promise.resolve({ index: emptyIndex(), skipped: [], sourceCount: 1 })
      },
    })

    const once = await generations.refresh('req-same', new AbortController().signal)
    const again = await generations.refresh('req-same', new AbortController().signal)

    assert.equal(builds, 1, 'a retried request must not become a second side effect')
    assert.deepEqual(again, once, 'and it returns what the first attempt produced')
  })

  test('a later refresh does start a new rebuild', async () => {
    let builds = 0
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: () => {
        builds += 1
        return Promise.resolve({ index: emptyIndex(), skipped: [], sourceCount: 1 })
      },
    })
    const first = await generations.refresh('req-1', new AbortController().signal)
    const second = await generations.refresh('req-2', new AbortController().signal)
    assert.equal(builds, 2)
    assert.equal(second.index.generation, first.index.generation + 1,
      'each healthy rebuild is its own generation')
  })
})

describe('cancellation is the last waiter leaving', () => {
  test('one caller withdrawing does not abandon the work others want', async () => {
    let observed = null
    let release = () => {}
    const gate = new Promise(resolve => { release = resolve })
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: async (_roots, signal) => {
        await gate
        observed = signal.aborted
        return signal.aborted
          ? { index: null, skipped: [], sourceCount: 1 }
          : { index: emptyIndex(), skipped: [], sourceCount: 1 }
      },
    })

    const staying = new AbortController()
    const leaving = new AbortController()
    const stays = generations.refresh('req-stay', staying.signal)
    const leaves = generations.refresh('req-leave', leaving.signal)
    await settle()

    leaving.abort()
    await settle()
    release()
    await Promise.all([stays, leaves])

    assert.equal(observed, false, 'the rebuild was still wanted, so it was not abandoned')
    assert.equal((await stays).kind, 'refreshed')
  })

  test('the last waiter leaving abandons it, and the old index survives', async () => {
    let release = () => {}
    const gate = new Promise(resolve => { release = resolve })
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: async (_roots, signal) => {
        await gate
        return signal.aborted
          ? { index: null, skipped: [], sourceCount: 1 }
          : { index: emptyIndex(), skipped: [], sourceCount: 1 }
      },
    })
    const before = generations.generation()

    const controller = new AbortController()
    const pending = generations.refresh('req-gone', controller.signal)
    await settle()
    controller.abort()
    await settle()
    release()

    const outcome = await pending
    assert.equal(outcome.kind, 'cancelled')
    assert.equal(outcome.index.generation, before.generation,
      'an abandoned rebuild never replaces what is in service')
    assert.equal(generations.generation().generation, before.generation)
  })
})

describe('a failed rebuild leaves a working Library', () => {
  test('the previous generation stays in service, and is named', async () => {
    const held = new LibraryIndex()
    held.addAll([{
      recordId: 'kept', revisionId: 'kept@1', title: 'kept', kind: 'document',
      text: 'still here', source: null, runId: null, observedAt: null,
      verdict: null, tags: [], evidenceIds: [],
    }])

    let first = true
    const generations = new LibraryGenerations({
      roots: ['/nowhere'],
      build: () => {
        if (first) {
          first = false
          return Promise.resolve({ index: held, skipped: [], sourceCount: 1 })
        }
        return Promise.reject(new Error('the roots became unreadable'))
      },
    })

    const good = await generations.refresh('req-good', new AbortController().signal)
    assert.equal(good.kind, 'refreshed')
    assert.equal(generations.index().size, 1)

    const bad = await generations.refresh('req-bad', new AbortController().signal)
    assert.equal(bad.kind, 'failed')
    assert.equal(bad.reason, 'the roots became unreadable')
    assert.equal(bad.index.generation, good.index.generation,
      'the generation reported is the one still answering')
    assert.equal(generations.index().size, 1, 'and it is still searchable')
  })
})

// ── through the wire, against a real directory ──────────────────────────────

/** The real Host: registry, Gateway, generated contribution, service. */
async function host(roots) {
  const ctx = new Context()
  ctx.plugin(TypertRegistryPlugin)
  ctx.plugin(GatewayPlugin)
  await settle()
  ctx.typert.register(TYPERT)

  const generations = new LibraryGenerations({ roots })
  new WatchQueryService(ctx, {
    index: () => generations.index(),
    scope: 'workspace-1',
    generations,
  })
  await settle()
  return { ctx, generations, gateway: ctx.typertGateway }
}

const invoke = (gateway, method, request, signal = new AbortController().signal) =>
  gateway.invoke({ namespace: 'watchQuery', method, args: { request }, signal })

const search = (overrides = {}) => ({
  protocol: 1, requestId: 'req-s', query: '', modalities: [],
  limit: 20, cursor: null, deadlineMs: 5000, ...overrides,
})

describe('the wire operation', () => {
  test('a record added after start becomes searchable without a restart', async () => {
    const store = corpus({ 'one.json': 'the kettle boiled' })
    try {
      const { gateway } = await host([store.dir])

      const before = await invoke(gateway, 'librarySearch', search({ requestId: 'req-b1' }))
      assert.equal(before.total, 1)
      const firstGeneration = before.generation

      // The whole point. Nothing restarts; the file simply appears.
      store.write('two.json', 'the toaster popped')
      const stale = await invoke(gateway, 'librarySearch', search({ requestId: 'req-b2' }))
      assert.equal(stale.total, 1, 'a search does not re-read the corpus on its own')

      const refreshed = await invoke(gateway, 'libraryRefresh',
        { protocol: 1, requestId: 'req-r1', deadlineMs: 5000 })
      assert.equal(refreshed.outcome, 'refreshed')
      assert.equal(refreshed.index.recordCount, 2)
      assert.equal(refreshed.index.sourceCount, 1)
      assert.equal(refreshed.index.indexState, 'ready')
      assert.equal(typeof refreshed.index.startedAt, 'string')
      assert.equal(typeof refreshed.index.completedAt, 'string')
      assert.ok(refreshed.index.generation > firstGeneration)

      const after = await invoke(gateway, 'librarySearch', search({ requestId: 'req-b3' }))
      assert.equal(after.total, 2)
      assert.equal(after.generation, refreshed.index.generation,
        'the page says which generation answered, and it is the new one')
    } finally {
      store.dispose()
    }
  })

  test('a malformed request is refused before anything is read', async () => {
    const store = corpus({ 'one.json': 'x' })
    try {
      const { gateway, generations } = await host([store.dir])
      const before = generations.generation().generation

      const refused = await invoke(gateway, 'libraryRefresh',
        { protocol: 99, requestId: 'req-bad-proto', deadlineMs: 5000 })
      assert.equal(refused.outcome, 'rejected')
      assert.equal(refused.reason, 'protocol_mismatch')
      assert.equal(generations.generation().generation, before, 'nothing was rebuilt')

      // And a structurally invalid one never reaches the host at all.
      const codec = await invoke(gateway, 'libraryRefresh',
        { protocol: 1, requestId: 'req-x', deadlineMs: 'soon' }).then(() => null, cause => cause)
      assert.notEqual(codec, null)
      assert.equal(codec.code, 'input-invalid')
    } finally {
      store.dispose()
    }
  })

  test('an aborted caller gets a deadline answer and starts nothing', async () => {
    const store = corpus({ 'one.json': 'x' })
    try {
      const { gateway, generations } = await host([store.dir])
      const before = generations.generation().generation

      const controller = new AbortController()
      controller.abort()
      const answer = await invoke(gateway, 'libraryRefresh',
        { protocol: 1, requestId: 'req-abort', deadlineMs: 5000 }, controller.signal)

      assert.equal(answer.outcome, 'deadline_exceeded')
      assert.equal(generations.generation().generation, before)
    } finally {
      store.dispose()
    }
  })

  test('a host that owns no index says so rather than appearing to refresh', async () => {
    // The capability-absent path. A surface has to be able to render "this
    // host cannot do that", which is a different fact from "it did nothing".
    const ctx = new Context()
    ctx.plugin(TypertRegistryPlugin)
    ctx.plugin(GatewayPlugin)
    await settle()
    ctx.typert.register(TYPERT)
    const index = new LibraryIndex()
    new WatchQueryService(ctx, { index: () => index, scope: 'w' })
    await settle()

    const answer = await invoke(ctx.typertGateway, 'libraryRefresh',
      { protocol: 1, requestId: 'req-none', deadlineMs: 5000 })
    assert.equal(answer.outcome, 'refresh_failed')
    assert.match(answer.reason, /does not own the Library index/)
  })

  test('a refresh answer carries no filesystem path', async () => {
    const store = corpus({ 'one.json': 'x' })
    try {
      writeFileSync(join(store.dir, 'broken.json'), '{ not json')
      const { gateway } = await host([store.dir])
      const answer = await invoke(gateway, 'libraryRefresh',
        { protocol: 1, requestId: 'req-paths', deadlineMs: 5000 })

      assert.equal(answer.outcome, 'refreshed')
      assert.deepEqual([...answer.skipped], ['broken.json: not a readable record'])
      const serialized = JSON.stringify(answer)
      assert.equal(serialized.includes(store.dir), false, 'the answer names the host’s directory')
      assert.doesNotMatch(serialized, /[A-Za-z]:\\\\|[A-Za-z]:\//, 'the answer carries a drive path')
    } finally {
      store.dispose()
    }
  })

  test('content identity survives a refresh', async () => {
    const store = corpus({ 'one.json': 'the kettle boiled' })
    try {
      const { gateway } = await host([store.dir])
      const before = await invoke(gateway, 'librarySearch', search({ requestId: 'req-i1' }))
      const id = before.records[0].recordId

      // The same bytes under a different name. One record, same id, and the
      // id a search returns is still one `libraryGet` accepts.
      store.write('renamed.json', 'the kettle boiled')
      await invoke(gateway, 'libraryRefresh',
        { protocol: 1, requestId: 'req-i2', deadlineMs: 5000 })

      const after = await invoke(gateway, 'librarySearch', search({ requestId: 'req-i3' }))
      assert.deepEqual([...new Set(after.records.map(r => r.recordId))], [id],
        'moving or copying the bytes did not mint a second record')

      const fetched = await invoke(gateway, 'libraryGet',
        { protocol: 1, requestId: 'req-i4', recordId: id, deadlineMs: 5000 })
      assert.equal(fetched.outcome, 'record')
    } finally {
      store.dispose()
    }
  })
})
