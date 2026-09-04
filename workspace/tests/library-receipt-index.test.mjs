/**
 * Whether the Library knows about work the Host just did.
 *
 * The evaluation produced 76 tool actions and a Library with nothing in it,
 * under a banner reading `Index is behind the store`. Both halves were wrong
 * and they were wrong in opposite directions: nothing was indexing receipts at
 * all, and the one thing the screen did say was that the index had fallen
 * behind a store that was empty.
 *
 * The second was a single conditional — anything not `ready` became `stale` —
 * and it is the more interesting failure, because "empty" and "stale" are
 * opposite claims. Empty says the index agrees with a store holding nothing.
 * Stale says the store moved and the index has not caught up. Reporting the
 * first as the second turns a quiet first run into a bug report.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, 'packages', 'watch', 'tools', 'lib')
const LIBRARY = join(ROOT, 'packages', 'watch', 'library', 'lib')

const { wireIndexState } = await import(pathToFileURL(join(TOOLS, 'read-plane.js')).href)
const { LibraryGenerations } = await import(
  pathToFileURL(join(TOOLS, 'library-generations.js')).href)
const { LibraryIndex } = await import(pathToFileURL(join(LIBRARY, 'index-store.js')).href)

const BASE = mkdtempSync(join(tmpdir(), 'watch-library-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })
let rooms = 0
const emptyRoot = () => {
  rooms += 1
  const dir = join(BASE, `root-${String(rooms)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** One execution receipt, in the shape the ledger emits. */
const receipt = (over = {}) => ({
  recordId: 'session-1/agent-1#1/c1#1',
  revisionId: 'session-1/agent-1#1/c1#1',
  title: 'write_file — result.json',
  kind: 'document',
  text: 'write_file {"path":"result.json"} ok result.json',
  source: null,
  runId: 'session-1',
  observedAt: '2026-09-04T00:00:00.000Z',
  verdict: null,
  tags: ['execution-receipt', 'tool:write_file', 'effect:write', 'state:completed'],
  evidenceIds: [],
  ...over,
})

describe('an empty index is caught up, not behind', () => {
  test('an index over an empty store reports empty', () => {
    const index = new LibraryIndex()
    assert.equal(index.size, 0)
    assert.equal(wireIndexState(index.health, index.size), 'empty',
      'an empty store was reported as behind itself')
  })

  test('the old conditional would have said stale, which is why this test exists', () => {
    // The defect, spelled out: `health === 'ready' ? 'ready' : 'stale'` over a
    // fresh index yields 'stale', because a fresh index's health is 'empty'.
    const index = new LibraryIndex()
    const oldAnswer = index.health === 'ready' ? 'ready' : 'stale'
    assert.equal(oldAnswer, 'stale')
    assert.notEqual(wireIndexState(index.health, index.size), oldAnswer)
  })

  test('an index with records and a current build is ready', () => {
    const index = new LibraryIndex()
    index.add(receipt())
    assert.equal(wireIndexState(index.health, index.size), 'ready')
  })

  test('a build in progress is rebuilding, whether or not it has records yet', () => {
    assert.equal(wireIndexState('indexing', 0), 'rebuilding')
    assert.equal(wireIndexState('indexing', 5), 'rebuilding')
  })

  test('an index that fell behind a non-empty store is stale', () => {
    assert.equal(wireIndexState('stale', 5), 'stale')
  })

  test('a corrupt index sends somebody to Refresh rather than claiming empty', () => {
    assert.equal(wireIndexState('corrupt', 5), 'stale')
  })
})

describe('a receipt is searchable without pressing Refresh', () => {
  test('a live record is in the index immediately', () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    assert.equal(generations.index().size, 0)
    generations.addLive(receipt())
    assert.equal(generations.index().size, 1, 'a receipt was not indexed when it was recorded')
    const found = generations.index().search({ text: 'write_file', limit: 10, offset: 0 })
    assert.equal(found.total, 1)
  })

  test('the index reports itself ready once it holds one', () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    const index = generations.index()
    assert.equal(wireIndexState(index.health, index.size), 'ready')
  })

  test('a rebuild does not lose what the Host recorded while running', async () => {
    // The race this closes: a receipt lives in memory, a rebuild reads roots on
    // disk, and without carrying the live records across, Refresh would take a
    // searchable Library back to empty for no reason a person could see.
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    assert.equal(generations.index().size, 1)

    const outcome = await generations.refresh('req-1', new AbortController().signal)
    assert.equal(outcome.kind, 'refreshed')
    assert.equal(generations.index().size, 1, 'Refresh dropped the receipts it did not read')
    assert.equal(generations.liveCount(), 1)
  })

  test('two receipts are two records, and a repeat is one', () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    generations.addLive(receipt({ recordId: 'other', revisionId: 'other' }))
    generations.addLive(receipt())
    assert.equal(generations.liveCount(), 2)
    assert.equal(generations.index().size, 2)
  })

  test('the generation record carries the counts a person can act on', () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    const meta = generations.generation()
    assert.equal(meta.recordCount, 1)
    assert.equal(meta.indexState, 'ready')
    assert.ok(meta.generation >= 1)
  })

  test('an empty profile’s first generation says empty rather than behind', () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    assert.equal(generations.generation().indexState, 'empty')
    assert.equal(generations.generation().recordCount, 0)
  })

  test('a receipt is filed as a document and tagged as a receipt', () => {
    // The source vocabulary is a closed union the wire and the client filters
    // both depend on. A receipt is textual, so it is a document, and the tag is
    // what keeps it filterable without widening the union.
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    const [stored] = generations.index().search(
      { text: 'write_file', limit: 10, offset: 0 }).results
    assert.equal(stored.kind, 'document')
    // A search hit names the source; the stored record is where the filing is.
    const full = generations.index().record(stored.sourceId)
    assert.ok(full.tags.includes('execution-receipt'))
    assert.ok(full.tags.includes('effect:write'))
  })

  test('a receipt carries no verdict of its own', () => {
    // What happened is not whether it was right. The verdict, if there is one,
    // is Core's and arrives separately.
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    generations.addLive(receipt())
    const full = generations.index().record('session-1/agent-1#1/c1#1')
    assert.equal(full.verdict, null)
  })
})

describe('refresh converges rather than racing', () => {
  test('the same request id returns the same outcome', async () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    const signal = new AbortController().signal
    const first = await generations.refresh('req-1', signal)
    const second = await generations.refresh('req-1', signal)
    assert.deepEqual(first, second, 'a retried refresh read the corpus twice')
  })

  test('a refresh over an empty store leaves it empty and says so', async () => {
    const generations = new LibraryGenerations({ roots: [emptyRoot()] })
    const outcome = await generations.refresh('req-1', new AbortController().signal)
    assert.equal(outcome.kind, 'refreshed')
    assert.equal(outcome.index.indexState, 'empty')
    assert.equal(outcome.index.recordCount, 0)
  })
})
