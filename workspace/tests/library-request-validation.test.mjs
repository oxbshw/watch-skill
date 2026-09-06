/**
 * What the Library read plane accepts, and what it refuses before reading.
 *
 * The generated Typert codec proves shape. These are the checks it has no
 * opinion about: how long a query may be, which modalities exist, whether a
 * record id is an identifier or a path, and how large a request may be at all.
 *
 * The ordering assertion is the one that matters most. A bounds check that runs
 * after the index has been consulted is not a bound, it is a log message — so
 * the refusal cases here use an index accessor that fails the test if anything
 * calls it.
 *
 * The extras test records a measured behaviour rather than an intended one. The
 * generated codec is a plain `z.object`, so unknown fields are stripped and not
 * rejected, and Typert's `mode: 'strict'` refers to strict codec generation
 * rather than zod's strict object mode. Writing that down as an assertion is
 * the only way it stays true.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QUERY_LIMITS } from '../packages/watch/contracts/lib/query.js'
import {
  LIBRARY_MODALITIES,
  parseLibraryGetRequest,
  parseLibrarySearchRequest,
} from '../packages/watch/contracts/lib/query/validate.js'
import { LibraryIndex } from '../packages/watch/library/lib/index.js'
import { getLibraryRecord, searchLibrary } from '../packages/watch/tools/lib/read-plane.js'

const search = (overrides = {}) => ({
  protocol: 1, requestId: 'req-1', query: 'kettle', modalities: [],
  limit: 10, cursor: null, deadlineMs: 5000, ...overrides,
})
const get = (overrides = {}) => ({
  protocol: 1, requestId: 'req-1', recordId: 'rec-1', deadlineMs: 5000, ...overrides,
})

/** A host whose index must never be reached. */
const forbidden = {
  scope: 'workspace-1',
  index: () => { assert.fail('the index was consulted for a request that should have been refused') },
}

/** A host with one real record. */
function hostWith(records) {
  const index = new LibraryIndex()
  index.addAll(records)
  return { index: () => index, scope: 'workspace-1' }
}

const record = (id, title = 'A kettle boiling') => ({
  recordId: id, revisionId: `${id}-r1`, title, kind: 'document',
  text: 'the kettle boiled', source: 'fixture', runId: 'run-1',
  observedAt: '2026-08-29T10:00:00.000Z', verdict: null, tags: [],
  evidenceIds: [`ev-${id}`],
})

// ── accepted, and normalised ────────────────────────────────────────────────

test('a well-formed search is accepted and normalised', () => {
  const parsed = parseLibrarySearchRequest(search({ limit: 100_000, deadlineMs: 10 ** 9 }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.limit, QUERY_LIMITS.limit, 'limit is clamped, not refused')
  assert.equal(parsed.value.deadlineMs, QUERY_LIMITS.deadlineMs, 'deadline is clamped')
  assert.deepEqual(parsed.value.modalities, [])
})

test('every declared modality is accepted, and nothing else is', () => {
  const accepted = parseLibrarySearchRequest(search({ modalities: [...LIBRARY_MODALITIES] }))
  assert.equal(accepted.ok, true)
  assert.equal(accepted.value.modalities.length, LIBRARY_MODALITIES.length)

  for (const bogus of ['telepathy', 'VIDEO', '', 'document ', 42, null]) {
    const parsed = parseLibrarySearchRequest(search({ modalities: [bogus] }))
    assert.equal(parsed.ok, false, String(bogus))
    assert.equal(parsed.refusal.field, 'modalities', String(bogus))
  }
})

// ── boundaries, and one over ────────────────────────────────────────────────

test('each bound accepts its limit and refuses one more', () => {
  const cases = [
    ['query', QUERY_LIMITS.queryLength, length => search({ query: 'x'.repeat(length) })],
    ['cursor', QUERY_LIMITS.cursorLength, length => search({ cursor: 'c'.repeat(length) })],
    ['requestId', QUERY_LIMITS.requestIdLength, length => search({ requestId: 'r'.repeat(length) })],
    ['modalities', QUERY_LIMITS.arrayLength,
      length => search({ modalities: Array.from({ length }, () => 'document') })],
  ]
  for (const [field, limit, build] of cases) {
    assert.equal(parseLibrarySearchRequest(build(limit)).ok, true, `${field} at ${String(limit)}`)
    const over = parseLibrarySearchRequest(build(limit + 1))
    assert.equal(over.ok, false, `${field} at ${String(limit + 1)}`)
  }
})

test('an oversized request is refused before it is walked', () => {
  const parsed = parseLibrarySearchRequest(
    search({ query: 'x'.repeat(QUERY_LIMITS.requestBytes + 1000) }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.refusal.reason, 'request_too_large')
})

test('a request that cannot be serialised is refused rather than throwing', () => {
  const cyclic = search()
  cyclic.self = cyclic
  const parsed = parseLibrarySearchRequest(cyclic)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.refusal.reason, 'request_too_large')
})

test('deeply nested params are refused', () => {
  let nested = { deep: true }
  for (let level = 0; level < QUERY_LIMITS.depth + 3; level += 1) nested = { nested }
  const parsed = parseLibrarySearchRequest(search({ extra: nested }))
  assert.equal(parsed.ok, false)
})

test('protocol and deadline must be non-negative safe integers', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null]) {
    assert.equal(parseLibrarySearchRequest(search({ protocol: bad })).ok, false, `protocol ${String(bad)}`)
    assert.equal(parseLibrarySearchRequest(search({ deadlineMs: bad })).ok, false, `deadline ${String(bad)}`)
  }
})

// ── identifiers are not locations ───────────────────────────────────────────

test('a record id may not be a path, a share, or a traversal', () => {
  for (const hostile of [
    '../secrets', '..\\secrets', '/etc/passwd', 'C:/Windows/System32',
    '\\\\server\\share', 'file:///etc/passwd', 'https://example.test/x',
    'rec 1', 'rec/1', 'rec:1', 'a'.repeat(QUERY_LIMITS.identifierLength + 1),
  ]) {
    const parsed = parseLibraryGetRequest(get({ recordId: hostile }))
    assert.equal(parsed.ok, false, hostile)
    assert.equal(parsed.refusal.reason, 'identifier_invalid', hostile)
    assert.equal(parsed.refusal.field, 'recordId', hostile)
  }
})

test('a refusal does not reflect an unsafe request id back', () => {
  const parsed = parseLibraryGetRequest(get({ requestId: '<script>alert(1)</script>' }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.refusal.requestId, '',
    'an id that failed the grammar is not echoed')
})

// ── nothing expensive runs before the bounds pass ───────────────────────────

test('a refused search never reaches the index', () => {
  for (const bad of [
    search({ query: 'x'.repeat(QUERY_LIMITS.queryLength + 1) }),
    search({ modalities: ['telepathy'] }),
    search({ protocol: 99 }),
    search({ requestId: '' }),
    'not an object',
    null,
  ]) {
    const answer = searchLibrary(bad, forbidden, new AbortController().signal)
    assert.equal(answer.outcome, 'rejected', JSON.stringify(bad)?.slice(0, 40))
  }
})

test('a refused get never reaches the index', () => {
  for (const bad of [get({ recordId: '../escape' }), get({ recordId: '' }), get({ protocol: 0 })]) {
    const answer = getLibraryRecord(bad, forbidden, new AbortController().signal)
    assert.equal(answer.outcome, 'rejected')
  }
})

test('an accepted request does reach the index', () => {
  const answer = searchLibrary(search(), hostWith([record('rec-1')]), new AbortController().signal)
  assert.equal(answer.outcome, 'page')
  assert.equal(answer.records.length, 1)
  assert.equal(answer.records[0].recordId, 'rec-1')
})

// ── the measured extras policy ──────────────────────────────────────────────

test('unknown fields are stripped, not rejected, and reach nothing', () => {
  // Measured against the generated codec: it is emitted as a plain `z.object`,
  // so zod strips. This is asserted rather than described because the opposite
  // is the natural assumption, and because the parsed value -- not the input --
  // is what continues past the boundary.
  const parsed = parseLibrarySearchRequest(search({
    unexpectedExtra: 'surprise',
    __proto__ready: true,
  }))
  assert.equal(parsed.ok, true, 'extras do not refuse the request')
  assert.equal('unexpectedExtra' in parsed.value, false, 'and they do not survive it')
  assert.deepEqual(
    Object.keys(parsed.value).sort(),
    ['cursor', 'deadlineMs', 'limit', 'modalities', 'protocol', 'query', 'requestId'],
    'exactly the declared fields continue')
})

test('a stripped field cannot influence what the host reads', () => {
  const answer = searchLibrary(
    search({ query: 'kettle', offset: 999, roots: ['C:/Windows'] }),
    hostWith([record('rec-1')]),
    new AbortController().signal)
  assert.equal(answer.outcome, 'page')
  assert.equal(answer.records.length, 1,
    'an injected offset did not page past the only record')
})
