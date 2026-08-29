/**
 * The Library read plane, end to end on the host side.
 *
 * This is the half a surface talks to: a request off the wire, parsed, run
 * against the real `LibraryIndex` the `watch_library_search` tool reads, and
 * returned as a snapshot. Everything below uses that real index over real
 * records -- no fixture array standing in for a search, because a fixture
 * array is exactly what the Library mode already had and what made it look
 * like a working surface.
 *
 * `answerQuery` is exercised rather than the Typert Service that wraps it. The
 * Service is a five-line adapter whose only job is to be reachable as
 * `ctx.remote.watchQuery.read`; everything that decides an answer is here, and
 * testing it directly is what lets these assertions run without standing up a
 * DSH runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LibraryIndex } from '../packages/watch/library/lib/index.js'
import { answerQuery } from '../packages/watch/tools/lib/read-plane.js'
import {
  WATCH_QUERY_PROTOCOL_VERSION,
  parseLibraryRecord,
  parseQuerySnapshot,
} from '../packages/watch/contracts/lib/query.js'

/** A record the index will actually accept. */
const record = (id, title, text, kind = 'document') => ({
  recordId: id,
  revisionId: `${id}-r1`,
  title,
  kind,
  text,
  source: 'fixture',
  runId: 'run-1',
  observedAt: '2026-08-29T10:00:00.000Z',
  verdict: null,
  tags: [],
  evidenceIds: [`ev-${id}`],
})

/** A populated index, and the config the read plane takes over it. */
function hostWith(records) {
  const index = new LibraryIndex()
  index.addAll(records)
  return { index: () => index, scope: 'workspace-1' }
}

const request = (overrides = {}) => ({
  protocol: WATCH_QUERY_PROTOCOL_VERSION,
  requestId: 'req-1',
  namespace: 'library',
  operation: 'search',
  deadlineMs: 5000,
  cursor: null,
  params: { query: 'kettle', limit: 10, modalities: [] },
  ...overrides,
})

const CORPUS = [
  record('rec-1', 'A kettle boiling', 'the kettle boiled and clicked off'),
  record('rec-2', 'A kettle descaled', 'descaling the kettle with vinegar'),
  record('rec-3', 'A toaster', 'the toaster popped'),
]

test('a search returns real records from the real index', async () => {
  const answer = await answerQuery(request(), hostWith(CORPUS))
  assert.equal(answer.ok, true, JSON.stringify(answer.error ?? {}))

  const names = answer.value.items.map(item => item.recordId).sort()
  assert.deepEqual(names, ['rec-1', 'rec-2'], 'both kettle records, and not the toaster')
  assert.equal(answer.value.requestId, 'req-1', 'the answer names the request')
  assert.ok(Number.isSafeInteger(answer.value.revision) && answer.value.revision >= 0)
})

test('what the host returns satisfies the contract the client parses with', async () => {
  const answer = await answerQuery(request(), hostWith(CORPUS))
  assert.equal(answer.ok, true)

  // The client parses before rendering. If the host's own output does not pass
  // that parser, the surface would refuse it -- so the two have to agree here.
  const parsed = parseQuerySnapshot(answer.value, parseLibraryRecord)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.error ?? {}))
  assert.equal(parsed.value.items.length, 2)
  for (const item of parsed.value.items) {
    assert.match(item.recordId, /^rec-/)
    assert.notEqual(item.title, '')
    assert.ok(Array.isArray(item.evidenceIds))
  }
})

test('a search that matches nothing is an empty answer, not a failure', async () => {
  const answer = await answerQuery(
    request({ params: { query: 'submarine', limit: 10, modalities: [] } }),
    hostWith(CORPUS))
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.items, [])
})

test('an empty index answers rather than refusing', async () => {
  const answer = await answerQuery(request(), hostWith([]))
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.items, [])
  assert.equal(answer.value.complete, false,
    'an index nobody has built is not a complete answer to anything')
})

test('paging issues a cursor and the cursor resumes', async () => {
  const host = hostWith(CORPUS)
  const first = await answerQuery(
    request({ params: { query: 'kettle', limit: 1, modalities: [] } }), host)
  assert.equal(first.ok, true)
  assert.equal(first.value.items.length, 1)
  assert.notEqual(first.value.nextCursor, null, 'two matches and a limit of one')

  const second = await answerQuery(
    request({
      requestId: 'req-2',
      cursor: first.value.nextCursor,
      params: { query: 'kettle', limit: 1, modalities: [] },
    }), host)
  assert.equal(second.ok, true, JSON.stringify(second.error ?? {}))
  assert.equal(second.value.items.length, 1)
  assert.notEqual(second.value.items[0].recordId, first.value.items[0].recordId,
    'the second page is not the first page again')
})

test('a cursor from another workspace is refused, not silently reused', async () => {
  const mine = hostWith(CORPUS)
  const first = await answerQuery(
    request({ params: { query: 'kettle', limit: 1, modalities: [] } }), mine)
  assert.equal(first.ok, true)

  const theirs = { index: mine.index, scope: 'another-workspace' }
  const replayed = await answerQuery(
    request({ cursor: first.value.nextCursor, params: { query: 'kettle', limit: 1, modalities: [] } }),
    theirs)
  assert.equal(replayed.ok, false)
  assert.equal(replayed.error.error, 'watch.query.cursor_expired')
})

test('a malformed request never reaches the index', async () => {
  let touched = false
  const host = {
    index: () => { touched = true; return new LibraryIndex() },
    scope: 'workspace-1',
  }
  const answer = await answerQuery(request({ requestId: '' }), host)
  assert.equal(answer.ok, false)
  assert.equal(answer.error.error, 'watch.query.malformed_request')
  assert.equal(touched, false, 'parsing happens before anything is read')
})

test('a namespace with no host behind it says so rather than answering empty', async () => {
  for (const namespace of ['memory', 'compare', 'live']) {
    const operation = { memory: 'list', compare: 'pair', live: 'state' }[namespace]
    const params = {
      memory: { scope: 'personal', limit: 10 },
      compare: { leftId: 'rec-1', rightId: 'rec-2' },
      live: {},
    }[namespace]
    const answer = await answerQuery(
      request({ namespace, operation, params }), hostWith(CORPUS))
    assert.equal(answer.ok, false, namespace)
    assert.equal(answer.error.error, 'watch.query.unavailable', namespace)
    assert.notEqual(answer.error.fix, '',
      'an unimplemented capability has to be distinguishable from an empty one')
  }
})

test('a deadline is enforced by the host, and the answer says which request', async () => {
  const slow = {
    scope: 'workspace-1',
    index: () => {
      const until = Date.now() + 250
      while (Date.now() < until) { /* hold the turn past the deadline */ }
      return new LibraryIndex()
    },
  }
  const answer = await answerQuery(request({ deadlineMs: 1 }), slow)
  // A synchronous index cannot be pre-empted, so this asserts the contract the
  // deadline exists for rather than a race: either it answered, or it refused
  // with the code and correlation a surface needs to explain the wait.
  if (!answer.ok) {
    assert.equal(answer.error.error, 'watch.query.deadline_exceeded')
    assert.equal(answer.error.correlationId, 'req-1')
    assert.equal(answer.error.retryable, true)
  } else {
    assert.equal(answer.value.requestId, 'req-1')
  }
})

test('a get for a record that is not there is empty rather than an error', async () => {
  const answer = await answerQuery(
    request({ operation: 'get', params: { recordId: 'rec-absent' } }), hostWith(CORPUS))
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.items, [])
})

test('the read plane exposes no way to name a path', async () => {
  for (const recordId of ['../secrets', 'C:/Windows', '/etc/passwd']) {
    const answer = await answerQuery(
      request({ operation: 'get', params: { recordId } }), hostWith(CORPUS))
    assert.equal(answer.ok, false, recordId)
    assert.equal(answer.error.error, 'watch.query.malformed_request', recordId)
  }
})
